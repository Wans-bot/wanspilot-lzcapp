/**
 * 下载引擎：内置 WebTorrent，随应用镜像一起跑，不依赖外部下载器。
 *
 * 设计要点：
 * 1. 任务列表落盘在 /data/torrents.json，进程重启后自动恢复，满足「重启不丢数据」的审核要求。
 * 2. 文件直接写入当前实例用户的网盘目录（容器内 /downloads 下的下载目录）。
 * 3. 对外只暴露 TaskItem 快照，前端不感知 webtorrent 的对象结构。
 * 4. 单文件与多文件种子都支持；删除任务时可选删除已下载文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import WebTorrent from 'webtorrent';
import { JsonStore } from './store.mjs';
import { log } from './log.mjs';

let client = null;
let taskStore = null;
/** infoHash(lowercase) -> { torrent, record } */
const tasks = new Map();
const listeners = new Set();

const MAX_CONCURRENT = 5;

export function initEngine(dataDir) {
  taskStore = new JsonStore(path.join(dataDir, 'torrents.json'), { items: [] }, { debounceMs: 500 });

  client = new WebTorrent({
    maxConns: 100,
    dht: true,
    tracker: true,
    utp: true,
  });
  client.on('error', (err) => {
    // 客户端级错误（例如 DHT 端口占用）不应让进程退出
    log.error(`[engine] 客户端错误: ${err?.message || err}`);
  });

  const records = Array.isArray(taskStore.data.items) ? taskStore.data.items : [];
  log.info(`[engine] 恢复 ${records.length} 个历史任务`);
  for (const record of records) {
    restore(record);
  }
  return client;
}

function saveRecords() {
  taskStore.data.items = [...tasks.values()].map(({ record }) => record);
  taskStore.save();
}

function persistNow() {
  if (taskStore) taskStore.flush();
}

/** 进程退出前保证任务列表落盘。 */
export function shutdownEngine() {
  try {
    persistNow();
  } catch {
    // 忽略
  }
  try {
    if (client) client.destroy();
  } catch {
    // 忽略
  }
}

function restore(record) {
  if (!record) return;
  const id = (record.infoHash || '').toLowerCase();
  if (id && tasks.has(id)) return;
  try {
    const source = record.magnet || (record.torrentBase64 ? Buffer.from(record.torrentBase64, 'base64') : null);
    if (!source) return;
    addToClient(source, record);
  } catch (err) {
    log.warn(`[engine] 恢复任务失败 ${record.name || record.infoHash}: ${err.message}`);
  }
}

function addToClient(source, record) {
  const opts = { path: record.savePath };
  const torrent = client.add(source, opts);
  const key = (torrent.infoHash || record.infoHash || '').toLowerCase();
  const entry = { torrent, record: { ...record, infoHash: key } };
  if (key) tasks.set(key, entry);
  else {
    // 极少数情况下 infoHash 要等元数据才可用
    torrent.once('infoHash', () => {
      const real = String(torrent.infoHash || '').toLowerCase();
      if (real) tasks.set(real, entry);
    });
  }

  torrent.on('metadata', () => {
    entry.record.name = torrent.name || entry.record.name;
    entry.record.sizeBytes = torrent.length;
    saveRecords();
    broadcast();
  });
  torrent.on('done', () => {
    entry.record.completedAt = new Date().toISOString();
    saveRecords();
    broadcast();
  });
  torrent.on('error', (err) => {
    log.warn(`[engine] 任务错误 ${torrent.infoHash}: ${err?.message || err}`);
    broadcast();
  });
  return entry;
}

/* --------------------------------------------------------------- 对外操作 */

function normalizeInfoHash(value) {
  const s = String(value || '').trim().toLowerCase();
  return /^[a-f0-9]{40}$/.test(s) ? s : '';
}

function findEntry(idOrHash) {
  const key = normalizeInfoHash(idOrHash);
  if (key && tasks.has(key)) return tasks.get(key);
  for (const entry of tasks.values()) {
    if (entry.record.id === idOrHash) return entry;
    if (String(entry.torrent.infoHash || '').toLowerCase() === String(idOrHash).toLowerCase()) return entry;
  }
  return null;
}

function activeCount() {
  let n = 0;
  for (const { torrent } of tasks.values()) {
    if (!torrent.done && !torrent.destroyed) n += 1;
  }
  return n;
}

/**
 * 加入一个下载任务。
 * @param {{magnet?: string, infoHash?: string, torrentBase64?: string}} input
 * @param {string} downloadDir 容器内绝对路径
 */
export function addTask(input, downloadDir) {
  const magnet = String(input.magnet || '').trim();
  const infoHash = normalizeInfoHash(input.infoHash);
  const base64 = String(input.torrentBase64 || '').trim();

  let source;
  let hashForDedup = infoHash;

  if (magnet) {
    source = magnet;
    const m = /xt=urn:btih:([a-zA-Z0-9]{32,40})/i.exec(magnet);
    if (m) hashForDedup = m[1].toLowerCase();
  } else if (base64) {
    source = Buffer.from(base64, 'base64');
    try {
      const parsed = parseInfoHashFromTorrent(source);
      if (parsed) hashForDedup = parsed;
    } catch (err) {
      throw new Error(`种子文件无法解析: ${err.message}`);
    }
  } else if (infoHash) {
    source = `magnet:?xt=urn:btih:${infoHash}`;
  } else {
    const err = new Error('请提供磁力链接、信息哈希或种子文件');
    err.statusCode = 400;
    throw err;
  }

  const existing = findEntry(hashForDedup);
  if (existing) {
    const err = new Error('该任务已在下载列表中');
    err.statusCode = 409;
    throw err;
  }

  if (activeCount() >= MAX_CONCURRENT) {
    // 不拒绝，只提示；webtorrent 会按自身调度处理连接数
    log.warn(`[engine] 同时进行的任务已达 ${MAX_CONCURRENT} 个，新任务会排队等待带宽`);
  }

  fs.mkdirSync(downloadDir, { recursive: true });

  const record = {
    // 用信息哈希做稳定 id；暂时拿不到哈希时用随机值，元数据到达后仍可检索。
    id: hashForDedup || crypto.randomBytes(20).toString('hex'),
    infoHash: hashForDedup || '',
    magnet: magnet || (hashForDedup ? `magnet:?xt=urn:btih:${hashForDedup}` : ''),
    torrentBase64: base64 ? base64.slice(0, 4 * 1024 * 1024) : '',
    name: '',
    sizeBytes: 0,
    addedAt: new Date().toISOString(),
    completedAt: null,
    savePath: downloadDir,
  };

  const entry = addToClient(source, record);
  saveRecords();
  broadcast();
  return snapshotOf(entry);
}

/** 从 .torrent 内容里取出 infoHash，用于去重。 */
function parseInfoHashFromTorrent(buffer) {
  // 用 webtorrent 自带解析器，避免自己写 bencode
  try {
    // eslint-disable-next-line global-require
    const parseTorrent = WebTorrent.parse || null;
    if (typeof parseTorrent === 'function') {
      const parsed = parseTorrent(buffer);
      if (parsed && parsed.infoHash) return String(parsed.infoHash).toLowerCase();
    }
  } catch {
    // 落到下面的 bencode 提取
  }
  // 退路：在 bencode 里定位 info 字典并算 sha1
  const text = buffer.toString('latin1');
  const idx = text.indexOf('4:infod');
  if (idx < 0) return '';
  const infoStart = idx + 7;
  const infoEnd = findDictEnd(text, infoStart - 1);
  if (infoEnd < 0) return '';
  const slice = buffer.subarray(infoStart - 1, infoEnd);
  return crypto.createHash('sha1').update(slice).digest('hex');
}

function findDictEnd(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === 'd' || ch === 'l') depth += 1;
    else if (ch === 'e') {
      depth -= 1;
      if (depth === 0) return i + 1;
    } else if (ch >= '0' && ch <= '9') {
      const m = /^(\d+):/.exec(text.slice(i));
      if (m) i += m[1].length + 1 + Number(m[1]) - 1;
    }
  }
  return -1;
}

/** 单个任务的对外快照。 */
function snapshotOf(entry) {
  const { torrent, record } = entry;
  // 暂停优先于「已完成」判断：已下载完并在做种的任务被暂停时，
  // 旧顺序会先落成 completed，再被做种分支覆盖，界面上看不到任何反馈。
  let state = 'queued';
  if (torrent.destroyed) state = 'error';
  else if (torrent.paused) state = 'paused';
  else if (torrent.done) state = 'completed';
  else if (!torrent.metadata) state = 'fetching-metadata';
  else if (torrent.downloadSpeed > 0 || torrent.progress < 1) state = 'downloading';
  if (!torrent.paused && torrent.uploadSpeed > 0 && torrent.done) state = 'seeding';

  const files = (torrent.files || []).slice(0, 200).map((f) => ({
    path: f.path,
    sizeBytes: f.length,
    progress: Math.round((f.progress || 0) * 1000) / 1000,
  }));

  return {
    id: record.id,
    infoHash: String(torrent.infoHash || record.infoHash || '').toLowerCase(),
    name: torrent.name || record.name || '正在获取元数据…',
    magnet: record.magnet,
    sizeBytes: torrent.length || record.sizeBytes || 0,
    downloadedBytes: torrent.downloaded || 0,
    progress: Math.round((torrent.progress || 0) * 1000) / 1000,
    state,
    rateDown: torrent.downloadSpeed || 0,
    rateUp: torrent.uploadSpeed || 0,
    peers: torrent.numPeers || 0,
    etaSeconds: Number.isFinite(torrent.timeRemaining) ? Math.round(torrent.timeRemaining / 1000) : null,
    addedAt: record.addedAt,
    completedAt: record.completedAt || null,
    savePath: record.savePath,
    error: torrent.destroyed && !torrent.done ? '任务已停止' : '',
    files,
  };
}

export function listTasks() {
  const items = [...tasks.values()].map(snapshotOf);
  items.sort((a, b) => String(b.addedAt).localeCompare(String(a.addedAt)));
  const stats = {
    active: items.filter((t) => ['downloading', 'fetching-metadata', 'queued', 'seeding'].includes(t.state)).length,
    completed: items.filter((t) => t.state === 'completed').length,
    rateDown: items.reduce((sum, t) => sum + t.rateDown, 0),
    rateUp: items.reduce((sum, t) => sum + t.rateUp, 0),
    totalSizeBytes: items.reduce((sum, t) => sum + t.sizeBytes, 0),
  };
  return { items, stats };
}

export function getTask(id) {
  const entry = findEntry(id);
  return entry ? snapshotOf(entry) : null;
}

export function pauseTask(id) {
  const entry = findEntry(id);
  if (!entry) return null;
  entry.torrent.pause();
  broadcast();
  return snapshotOf(entry);
}

export function resumeTask(id) {
  const entry = findEntry(id);
  if (!entry) return null;
  entry.torrent.resume();
  broadcast();
  return snapshotOf(entry);
}

/** 删除任务；deleteFiles 为真时同时删除已下载文件。 */
export function removeTask(id, deleteFiles = false) {
  const entry = findEntry(id);
  if (!entry) return false;
  const { torrent, record } = entry;
  const hash = String(torrent.infoHash || record.infoHash || '').toLowerCase();

  const destroyStore = Boolean(deleteFiles);
  const done = () => {
    if (hash) tasks.delete(hash);
    saveRecords();
    broadcast();
  };
  try {
    torrent.destroy({ destroyStore }, done);
  } catch (err) {
    log.warn(`[engine] 删除任务失败: ${err.message}`);
    done();
  }

  if (deleteFiles) {
    // webtorrent 的 destroyStore 只删它自己管理的分片；这里再兜底删一次目录。
    const target = path.join(record.savePath, safeSegment(torrent.name || record.name || ''));
    if (target && torrent.name) {
      try {
        fs.rmSync(target, { recursive: true, force: true });
      } catch (err) {
        log.warn(`[engine] 删除文件目录失败 ${target}: ${err.message}`);
      }
    }
  }
  return true;
}

function safeSegment(name) {
  return String(name || '').replace(/[/\\]/g, '_').replace(/^\.+/, '').slice(0, 200);
}

/* ------------------------------------------------------------- 事件广播 */

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function broadcast() {
  if (!listeners.size) return;
  const payload = listTasks();
  for (const fn of [...listeners]) {
    try {
      fn(payload);
    } catch {
      listeners.delete(fn);
    }
  }
}

// 下载过程中没有事件回调也会变化，定时推一次，保证前端进度是活的。
let ticker = null;
export function startTicker() {
  if (ticker) return;
  ticker = setInterval(() => {
    if (tasks.size) broadcast();
  }, 2000);
  if (ticker.unref) ticker.unref();
}

export function engineReady() {
  return Boolean(client) && !client.destroyed;
}

export function engineStats() {
  return {
    ready: engineReady(),
    tasks: tasks.size,
    downloadDir: null,
  };
}
