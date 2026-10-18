/**
 * 下载后整理。
 *
 * 任务下完后按「片名 (年份)/」归档，剧集再补一层 Season NN；可选写 .nfo 与海报，
 * 让下载好的片子直接被 Jellyfin / Emby / Kodi 认出来，并清掉样本文件。
 *
 * 三个开关都默认关闭，在设置里逐个打开。整理只在下载目录内做移动，
 * 不动下载目录以外的任何东西；重名时加 (2)、(3) 后缀，不覆盖已有文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveDownloadDir, getSettings } from './settings.mjs';
import { log } from './log.mjs';
import { subscribe, listTasks } from './engine.mjs';
import * as tmdb from './tmdb.mjs';
import { listSubscriptions } from './subscriptions.mjs';

const SAMPLE_PATTERN = /(^|[.\-_ ])(sample|samples|rarbg|\.url$|\.txt$|\.nfo$)/i;

let processed = new Set();
let running = false;
let lastReport = null;

/** 剧集或电影的中文名与年份：优先取订阅里已解析到的信息。 */
function describeTask(task) {
  const subs = listSubscriptions().items || [];
  const name = String(task.name || '');
  const lower = name.toLowerCase();
  const hit = subs.find((item) => {
    const candidates = [item.originalTitle, item.title].filter(Boolean).map((t) => String(t).toLowerCase());
    return candidates.some((title) => title.length >= 3 && lower.includes(title));
  });
  if (hit) {
    return {
      title: hit.title || name,
      originalTitle: hit.originalTitle || '',
      year: hit.year || '',
      tmdbId: hit.tmdbId,
      type: hit.type === 'movie' ? 'movie' : 'tv',
    };
  }
  // 没订阅记录时用种子名兜底，去掉常见的发布后缀
  const cleaned = name
    .replace(/\.(19|20)\d{2}.*$/, '')
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const yearMatch = /(19|20)\d{2}/.exec(name);
  return {
    title: cleaned || name,
    originalTitle: '',
    year: yearMatch ? yearMatch[0] : '',
    tmdbId: 0,
    type: /\bS\d{1,2}\b|\bseason\b|第\s*\d+\s*季/i.test(name) ? 'tv' : 'movie',
  };
}

/** 目标目录名：媒体库认「片名 (年份)」。 */
function targetFolder(info) {
  const title = String(info.title || '未命名').replace(/[\\/:*?"<>|]/g, ' ').trim();
  return info.year ? `${title} (${info.year})` : title;
}

function seasonFolderFrom(fileName) {
  const match = /[Ss](\d{1,2})[Ee]\d{1,3}/.exec(String(fileName || ''));
  return match ? `Season ${String(Number(match[1])).padStart(2, '0')}` : '';
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 不覆盖已有文件：重名时依次加 (2)、(3)。 */
function uniquePath(target) {
  if (!fs.existsSync(target)) return target;
  const dir = path.dirname(target);
  const ext = path.extname(target);
  const base = path.basename(target, ext);
  for (let i = 2; i < 100; i += 1) {
    const candidate = path.join(dir, `${base} (${i})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, `${base}-${Date.now()}${ext}`);
}

function moveFile(from, to) {
  try {
    fs.renameSync(from, to);
    return true;
  } catch (err) {
    // 跨设备时 rename 会失败，退化为复制后删除
    try {
      fs.copyFileSync(from, to);
      fs.unlinkSync(from);
      return true;
    } catch (inner) {
      log.warn(`[organize] 移动失败 ${from} → ${to}：${inner.message}`);
      return false;
    }
  }
}

/** 写 Kodi/Jellyfin 认的 .nfo 与海报。 */
async function writeMetadata(dir, info) {
  if (!info.tmdbId) return { nfo: false, poster: false };
  let detail = null;
  try {
    detail = await tmdb.detail({ type: info.type === 'tv' ? 'tv' : 'movie', id: info.tmdbId });
  } catch (err) {
    log.warn(`[organize] 取 TMDB 资料失败：${err.message}`);
    return { nfo: false, poster: false };
  }

  const xml = info.type === 'tv'
    ? ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>', '<tvshow>',
      `  <title>${escapeXml(detail.title)}</title>`,
      `  <originaltitle>${escapeXml(detail.originalTitle)}</originaltitle>`,
      `  <year>${escapeXml(detail.year)}</year>`,
      `  <plot>${escapeXml(detail.overview)}</plot>`,
      `  <rating>${detail.voteAverage}</rating>`,
      `  <premiered>${escapeXml(detail.releaseDate)}</premiered>`,
      detail.genres.map((g) => `  <genre>${escapeXml(g)}</genre>`).join('\n'),
      `  <uniqueid type="tmdb">${detail.id}</uniqueid>`,
      '</tvshow>'].filter(Boolean).join('\n')
    : ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>', '<movie>',
      `  <title>${escapeXml(detail.title)}</title>`,
      `  <originaltitle>${escapeXml(detail.originalTitle)}</originaltitle>`,
      `  <year>${escapeXml(detail.year)}</year>`,
      `  <plot>${escapeXml(detail.overview)}</plot>`,
      `  <rating>${detail.voteAverage}</rating>`,
      `  <premiered>${escapeXml(detail.releaseDate)}</premiered>`,
      `  <runtime>${detail.runtime || 0}</runtime>`,
      detail.genres.map((g) => `  <genre>${escapeXml(g)}</genre>`).join('\n'),
      `  <uniqueid type="tmdb">${detail.id}</uniqueid>`,
      '</movie>'].filter(Boolean).join('\n');

  const nfoName = info.type === 'tv' ? 'tvshow.nfo' : 'movie.nfo';
  let nfo = false;
  try {
    fs.writeFileSync(path.join(dir, nfoName), xml, 'utf8');
    nfo = true;
  } catch (err) {
    log.warn(`[organize] 写 ${nfoName} 失败：${err.message}`);
  }

  let poster = false;
  const posterPath = (detail.posterPath || '').replace(/^\/+/, '');
  if (posterPath) {
    try {
      const image = await tmdb.fetchImage(posterPath, 'w500');
      fs.writeFileSync(path.join(dir, 'poster.jpg'), image.body);
      poster = true;
    } catch (err) {
      log.warn(`[organize] 写海报失败：${err.message}`);
    }
  }
  return { nfo, poster };
}

function escapeXml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 整理一个任务。返回可写进日志与界面的报告。
 * @param {object} task 任务快照
 * @param {{force?: boolean}} [options]
 */
export async function organizeTask(task, options = {}) {
  const settings = getSettings();
  const root = resolveDownloadDir();
  const files = Array.isArray(task.files) ? task.files : [];
  const report = { taskId: task.id, name: task.name, moved: 0, samples: 0, folder: '', nfo: false, poster: false, skipped: '' };

  if (!files.length) {
    report.skipped = '没有文件';
    return report;
  }
  if (Number(task.progress || 0) < 1) {
    report.skipped = '还没下完';
    return report;
  }
  if (!options.force && !settings.autoOrganize) {
    report.skipped = '未打开自动整理';
    return report;
  }

  const info = describeTask(task);
  const folder = targetFolder(info);
  report.folder = folder;

  for (const file of files) {
    const relative = String(file.path || '').split('/').filter((seg) => seg && seg !== '.' && seg !== '..').join('/');
    const source = path.resolve(root, relative);
    if (!source.startsWith(path.resolve(root) + path.sep) || !fs.existsSync(source)) continue;

    const baseName = path.basename(relative);
    if (settings.deleteSamples && SAMPLE_PATTERN.test(baseName) && Number(file.sizeBytes || 0) < 50 * 1024 * 1024) {
      try {
        fs.unlinkSync(source);
        report.samples += 1;
      } catch (err) {
        log.warn(`[organize] 删样本失败：${err.message}`);
      }
      continue;
    }

    const season = info.type === 'tv' ? seasonFolderFrom(baseName) : '';
    const targetDir = ensureDir(season ? path.join(root, folder, season) : path.join(root, folder));
    const target = uniquePath(path.join(targetDir, baseName));
    if (moveFile(source, target)) report.moved += 1;
  }

  if (settings.writeNfo) {
    const meta = await writeMetadata(path.join(root, folder), info);
    report.nfo = meta.nfo;
    report.poster = meta.poster;
  }

  // 清掉整理后留下的空目录（只删下载目录内的）
  pruneEmptyDirs(root);
  log.info(`[organize] ${report.name} → ${folder}：移动 ${report.moved} 个文件，清样本 ${report.samples} 个`);
  return report;
}

function pruneEmptyDirs(root) {
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name), depth + 1);
    }
    if (dir === path.resolve(root)) return;
    try {
      if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    } catch (err) {
      // 删不掉就算了，不影响结果
    }
  };
  walk(root, 0);
}

/** 任务下完就自动整理；已经在队列里的不重复处理。 */
export function initOrganizer() {
  subscribe((snapshot) => {
    const settings = getSettings();
    if (!settings.autoOrganize) return;
    const items = (snapshot && snapshot.items) || [];
    for (const task of items) {
      if (Number(task.progress || 0) < 1) continue;
      if (['completed', 'seeding'].indexOf(task.state) < 0) continue;
      if (processed.has(task.id)) continue;
      processed.add(task.id);
      organizeTask(task).catch((err) => log.warn(`[organize] 自动整理失败：${err.message}`));
    }
  });
}

/** 手动整理所有已完成的任务。 */
export async function organizeAll() {
  if (running) return { running: true, reports: [] };
  running = true;
  try {
    const tasks = (listTasks().items || []).filter((task) => Number(task.progress || 0) >= 1);
    const reports = [];
    for (const task of tasks) {
      reports.push(await organizeTask(Object.assign({}, task, { files: task.files || [] }), { force: true }));
    }
    lastReport = { at: new Date().toISOString(), reports };
    return { running: false, reports };
  } finally {
    running = false;
  }
}

export function organizerStatus() {
  const settings = getSettings();
  return {
    autoOrganize: Boolean(settings.autoOrganize),
    writeNfo: Boolean(settings.writeNfo),
    deleteSamples: Boolean(settings.deleteSamples),
    processed: processed.size,
    last: lastReport,
  };
}
