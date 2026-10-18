/**
 * 订阅：记录要追的影片，定期检查更新，发现新剧集就自动搜索并交给下载引擎。
 *
 * 判断「有没有更新」完全基于 TMDB 的播出日期：某集的 airDate 已过且未下载过，
 * 就算新剧集。这样不依赖任何站点状态，也不需要用户手动标记。
 */
import path from 'node:path';
import { JsonStore } from './store.mjs';
import { log } from './log.mjs';
import { getSettings, resolveDownloadDir } from './settings.mjs';
import * as tmdb from './tmdb.mjs';
import { searchResources } from './sources.mjs';
import { addTask, getTask, listTasks } from './engine.mjs';
import { capacityCheck } from './capacity.mjs';

let store = null;
let timer = null;
let running = false;

let engineAdd = null;
let subscribeKeysFactory = null;

export function initSubscriptions(dataDir, deps = {}) {
  store = new JsonStore(path.join(dataDir, 'subscriptions.json'), { items: [] }, { debounceMs: 300 });
  engineAdd = deps.addTask || addTask;
  subscribeKeysFactory = deps.getTask || getTask;
  return listSubscriptions();
}

function save() {
  store.save();
}

export function listSubscriptions() {
  const items = Array.isArray(store.data.items) ? store.data.items : [];
  return { items: items.map(decorate) };
}

function decorate(item) {
  return {
    id: item.id,
    type: item.type,
    tmdbId: item.tmdbId,
    title: item.title,
    originalTitle: item.originalTitle || '',
    posterPath: item.posterPath || '',
    year: item.year || '',
    seasons: item.seasons ?? null,
    qualityPreference: item.qualityPreference,
    minSeeders: item.minSeeders,
    maxSizeGB: item.maxSizeGB,
    autoDownload: item.autoDownload !== false,
    enabled: item.enabled !== false,
    createdAt: item.createdAt,
    lastCheckAt: item.lastCheckAt || null,
    nextCheckAt: item.nextCheckAt || null,
    lastMessage: item.lastMessage || '',
    downloadedKeys: item.downloadedKeys || [],
    // 降档下载后如果发现更好的版本，这里带着候选给界面做「替换」提示
    upgrade: item.upgrade || null,
    state: item.state || 'idle',
    totalEpisodes: item.totalEpisodes || 0,
  };
}

function findItem(id) {
  const items = Array.isArray(store.data.items) ? store.data.items : [];
  return items.find((it) => it.id === id);
}

function newId() {
  return `sub_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** 订阅同一部作品的同一批季只允许一份。 */
export function createSubscription(input) {
  const type = input.type === 'movie' ? 'movie' : 'tv';
  const tmdbId = Number.parseInt(input.tmdbId, 10);
  if (!Number.isFinite(tmdbId)) {
    const err = new Error('缺少有效的 TMDB 编号');
    err.statusCode = 400;
    throw err;
  }

  const items = Array.isArray(store.data.items) ? store.data.items : [];
  const dup = items.find((it) => it.tmdbId === tmdbId && it.type === type);
  if (dup) {
    const err = new Error('已经订阅过这部作品');
    err.statusCode = 409;
    throw err;
  }

  const settings = getSettings();
  const seasons = type === 'movie' ? null : normalizeSeasons(input.seasons);

  const item = {
    id: newId(),
    type,
    tmdbId,
    title: String(input.title || '').trim(),
    originalTitle: String(input.originalTitle || '').trim(),
    posterPath: String(input.posterPath || ''),
    year: String(input.year || ''),
    seasons,
    qualityPreference: normalizeQuality(input.qualityPreference, settings.qualityPreference),
    minSeeders: clamp(input.minSeeders, 0, 100000, settings.minSeeders),
    maxSizeGB: clamp(input.maxSizeGB, 1, 500, settings.maxSizeGB),
    autoDownload: input.autoDownload !== false,
    enabled: true,
    createdAt: new Date().toISOString(),
    lastCheckAt: null,
    nextCheckAt: new Date().toISOString(),
    lastMessage: '已订阅，等待首次检查',
    downloadedKeys: [],
    state: 'idle',
    totalEpisodes: 0,
  };

  items.push(item);
  store.data.items = items;
  save();

  // 订阅后立刻跑一次，用户不用等下一个周期
  runCheck(item).catch((err) => log.warn(`[subs] 首次检查失败 ${item.id}: ${err.message}`));
  return { item: decorate(item) };
}

function clamp(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function normalizeQuality(value, fallback) {
  const v = String(value || '').trim();
  return ['any', '720p', '1080p', '2160p'].includes(v) ? v : fallback;
}

function normalizeSeasons(value) {
  if (!Array.isArray(value)) return null;
  const list = [...new Set(value.map((n) => Number.parseInt(n, 10)).filter((n) => Number.isFinite(n) && n > 0))];
  list.sort((a, b) => a - b);
  return list.length ? list : null;
}

export function updateSubscription(id, patch) {
  const item = findItem(id);
  if (!item) return null;
  if ('qualityPreference' in patch) item.qualityPreference = normalizeQuality(patch.qualityPreference, item.qualityPreference);
  if ('minSeeders' in patch) item.minSeeders = clamp(patch.minSeeders, 0, 100000, item.minSeeders);
  if ('maxSizeGB' in patch) item.maxSizeGB = clamp(patch.maxSizeGB, 1, 500, item.maxSizeGB);
  if ('autoDownload' in patch) item.autoDownload = Boolean(patch.autoDownload);
  if ('enabled' in patch) {
    item.enabled = Boolean(patch.enabled);
    item.state = item.enabled ? 'watching' : 'paused';
  }
  if ('seasons' in patch) item.seasons = item.type === 'movie' ? null : normalizeSeasons(patch.seasons);
  // API.md 写的是「SubscriptionItem 的任意子集」，下载记录也要能重置：
  // 用户在网盘里删了文件、或改了画质想重下时需要它。
  if ('downloadedKeys' in patch && Array.isArray(patch.downloadedKeys)) {
    const keys = new Set();
    for (const raw of patch.downloadedKeys) {
      const text = String(raw || '').trim();
      if (text === 'movie' || /^S\d{2}E\d{2}$/.test(text)) keys.add(text);
    }
    item.downloadedKeys = [...keys];
    if (!item.downloadedKeys.length && item.state === 'idle') item.state = 'watching';
  }
  save();
  return { item: decorate(item) };
}

export function deleteSubscription(id) {
  const items = Array.isArray(store.data.items) ? store.data.items : [];
  const idx = items.findIndex((it) => it.id === id);
  if (idx < 0) return false;
  items.splice(idx, 1);
  store.data.items = items;
  save();
  return true;
}

/* --------------------------------------------------------------- 检查逻辑 */

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function isAired(dateStr) {
  if (!dateStr) return false;
  return dateStr <= todayStr();
}

function epKey(season, episode) {
  return `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
}

// 片名匹配用：这些词出现在发布名里但没有区分度。
const TITLE_STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'part', 'vol', 'complete', 'season', 'series', 'movie',
  'web', 'webrip', 'bluray', 'brrip', 'bdrip', 'dvdrip', 'hdrip', 'hdtv', 'remux',
  'proper', 'repack', 'multi', 'dual', 'audio', 'x264', 'x265', 'h264', 'h265', 'hevc',
  'avc', 'aac', 'ac3', 'dts', 'ddp', 'atmos', 'hdr', 'dv', 'remastered', 'extended',
  'ita', 'eng', 'jpn', 'kor', 'chs', 'cht', 'sub', 'subs', 'internal',
]);

function normalizeTitle(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^0-9a-z\u3400-\u4dbf\u4e00-\u9fff]+/g, ' ')
    .trim();
}

function latinTokens(text) {
  return normalizeTitle(text)
    .split(' ')
    .filter((t) => t.length >= 3 && !/^\d+$/.test(t) && !TITLE_STOP_WORDS.has(t));
}

function cjkChars(text) {
  return String(text || '').match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) || [];
}

/**
 * 候选片名是否属于所订阅的作品。
 *
 * 索引源对中文片名基本无效：实测用中文名查 apibay 会返回一份与本片无关的通用列表，
 * 而这份列表里有别的 2160p 新片，按画质偏好排序就会顶到第一。所以下发前必须过这道闸。
 * 中文名按字符命中率（≥50%）判，原名按有效词命中率（≥60%）判。
 */
export function titleMatches(candidateTitle, expectedTitles) {
  const candidate = normalizeTitle(candidateTitle);
  if (!candidate) return false;
  for (const expected of expectedTitles) {
    if (!expected) continue;
    const chars = cjkChars(expected);
    if (chars.length >= 2) {
      const hit = chars.filter((ch) => candidate.includes(ch)).length;
      if (hit >= 2 && hit / chars.length >= 0.5) return true;
      continue;
    }
    const tokens = latinTokens(expected);
    if (!tokens.length) continue;
    const hit = tokens.filter((t) => candidate.includes(t)).length;
    if (hit / tokens.length >= 0.6) return true;
  }
  return false;
}

/** 候选名里写的年份与所订阅年份相差超过一年 → 不是同一部作品。 */
function yearMismatch(title, expectedYear) {
  if (!expectedYear) return false;
  const found = String(title || '').match(/(?:19|20)\d{2}/g);
  if (!found) return false;
  return found.every((y) => Math.abs(Number(y) - Number(expectedYear)) > 1);
}

/** 画质从高到低，用于「主档缺源时逐级降档」。 */
const QUALITY_ORDER = ['2160p', '1080p', '720p', '480p'];

/** 从偏好档开始的降级顺序。 */
function qualityLadder(preference) {
  const index = QUALITY_ORDER.indexOf(String(preference || '1080p'));
  return QUALITY_ORDER.slice(index >= 0 ? index : 1);
}

/** 从候选资源里按偏好挑一个可用的。expectedTitles 非空时先过片名闸。 */
export function pickBest(candidates, item, want, expectedTitles = [], options = {}) {
  const minSeeders = item.minSeeders ?? 0;
  const maxBytes = (item.maxSizeGB || 30) * 1024 ** 3;
  const expectedYear = want === 'movie' ? Number(item.year) || 0 : 0;
  const strictQuality = options.strictQuality || '';
  const filtered = candidates.filter((c) => {
    if (!c.magnet) return false;
    if (c.seeders < minSeeders) return false;
    if (c.sizeBytes > maxBytes) return false;
    if (strictQuality && c.resolution !== strictQuality) return false;
    if (expectedTitles.length && !titleMatches(c.title, expectedTitles)) return false;
    if (expectedYear && yearMismatch(c.title, expectedYear)) return false;
    return true;
  });
  if (!filtered.length) return null;

  // 画质偏好优先级最高；同画质看做种数
  const prefer = item.qualityPreference || '1080p';
  const rank = (c) => {
    let s = c.seeders;
    if (prefer !== 'any' && c.resolution) s += c.resolution === prefer ? 1e9 : 0;
    if (want === 'pack' && c.isSeasonPack) s += 5e8;
    if (want === 'episode' && !c.isSeasonPack) s += 1e8;
    return s;
  };
  filtered.sort((a, b) => rank(b) - rank(a));
  return filtered[0];
}

/**
 * 按原名搜索，过头道闸；原名搜不到时再用 TMDB 的本地化名搜一次
 * （torrents-csv 收录部分中文内容），两次都过同一道片名闸。
 */
async function searchForTitle(item, params, localizedTitle, want, extraFilter, options = {}) {
  const titles = [item.originalTitle, localizedTitle, item.title].filter(Boolean);
  const primary = item.originalTitle || localizedTitle || item.title;
  let checked = 0;
  const attempt = async (q) => {
    const res = await searchResources({ ...params, q });
    checked += res.items.length;
    const pool = extraFilter ? res.items.filter(extraFilter) : res.items;
    return pickBest(pool, item, want, titles, options);
  };
  let best = await attempt(primary);
  if (!best && localizedTitle && localizedTitle !== primary) best = await attempt(localizedTitle);
  return { best, checked, titles };
}

/**
 * 按偏好档找，缺源时逐级降档。
 * @returns {{best: object|null, checked: number, usedRung: string, fellBack: boolean}}
 */
async function searchWithLadder(item, params, localizedTitle, want, extraFilter) {
  const ladder = qualityLadder(item.qualityPreference);
  let checked = 0;
  for (const rung of ladder) {
    const found = await searchForTitle(item, params, localizedTitle, want, extraFilter, { strictQuality: rung });
    checked += found.checked;
    if (found.best) {
      return { best: found.best, checked, usedRung: rung, fellBack: rung !== ladder[0] };
    }
  }
  return { best: null, checked, usedRung: '', fellBack: false };
}

/** 交给下载引擎。候选已在下载列表里是正常情况，不能记成检查失败。 */
function addToEngine(item, candidate) {
  // 体积已知时先看空间，避免下到一半撑爆网盘
  const cap = capacityCheck(candidate.sizeBytes, Number(((listTasks().stats) || {}).totalSizeBytes) || 0);
  if (!cap.ok) {
    log.warn(`[subs] ${item.id} 空间不足，跳过《${candidate.title}》：${cap.message}`);
    return { ok: false, duplicate: false, reason: cap.message };
  }
  try {
    engineAdd({ magnet: candidate.magnet }, resolveDownloadDir());
    return { ok: true, duplicate: false };
  } catch (err) {
    if (/已在下载列表/.test(err.message)) {
      log.info(`[subs] ${item.id} 候选《${candidate.title}》已在下载列表中，跳过重复添加`);
      return { ok: true, duplicate: true };
    }
    throw err;
  }
}

async function checkMovie(item) {
  const detail = await tmdb.detail({ type: 'movie', id: item.tmdbId });
  item.title = detail.title || item.title;
  item.originalTitle = detail.originalTitle || item.originalTitle || '';
  item.posterPath = detail.posterPath || item.posterPath;
  item.year = detail.year || item.year;

  if (!isAired(detail.releaseDate)) {
    item.lastMessage = `尚未上映（${detail.releaseDate || '日期待定'}）`;
    item.state = 'watching';
    return { found: 0, added: [] };
  }
  if (item.downloadedKeys.includes('movie')) {
    item.lastMessage = '已下载，无需重复获取';
    item.state = 'idle';
    return { found: 0, added: [] };
  }

  // 已经下过但当时是降档拿到的，之后每次检查都回头看有没有更好的版本
  if (item.downloadedKeys.includes('movie') && item.upgrade && item.upgrade.pending) {
    const better = await searchForTitle(
      item,
      { type: 'movie', year: detail.year, qualityPreference: item.qualityPreference },
      detail.title,
      'movie',
      null,
      { strictQuality: item.qualityPreference },
    );
    if (better.best) {
      item.upgrade = {
        available: true,
        title: better.best.title,
        magnet: better.best.magnet,
        sizeBytes: better.best.sizeBytes,
        resolution: better.best.resolution,
      };
      item.lastMessage = `发现更好的版本（${better.best.resolution || '更高画质'}）：${better.best.title}`;
      item.state = 'watching';
      return { found: better.checked, added: [] };
    }
    item.lastMessage = '仍是降档版本，暂未出现更好的资源';
    item.state = 'idle';
    return { found: 0, added: [] };
  }

  const { best, checked, usedRung, fellBack } = await searchWithLadder(
    item,
    { type: 'movie', year: detail.year, qualityPreference: item.qualityPreference },
    detail.title,
    'movie',
  );
  if (!best) {
    item.lastMessage = checked
      ? `未找到与《${item.title}》匹配的资源（已检查 ${checked} 条候选）`
      : `未找到与《${item.title}》匹配的资源`;
    item.state = 'watching';
    return { found: checked, added: [] };
  }
  if (!item.autoDownload) {
    item.lastMessage = `找到 ${checked} 条候选，自动下载已关闭`;
    return { found: checked, added: [] };
  }
  const added = addToEngine(item, best);
  if (!added.ok) {
    item.lastMessage = added.reason || '空间不足，已跳过';
    item.state = 'error';
    return { found: checked, added: [] };
  }
  item.downloadedKeys = [...item.downloadedKeys, 'movie'];
  item.upgrade = fellBack
    ? { pending: true, reason: `${item.qualityPreference} 暂无符合条件资源，先下 ${usedRung}` }
    : null;
  item.lastMessage = added.duplicate
    ? `已在下载列表中：${best.title}`
    : `已加入下载${fellBack ? `（${usedRung}，主档缺源）` : ''}：${best.title}`;
  item.state = 'idle';
  return { found: checked, added: ['movie'] };
}

async function checkTv(item) {
  const detail = await tmdb.detail({ type: 'tv', id: item.tmdbId });
  item.title = detail.title || item.title;
  item.originalTitle = detail.originalTitle || item.originalTitle || '';
  item.posterPath = detail.posterPath || item.posterPath;
  item.year = detail.year || item.year;

  // 没选季 = 追全部季。但像「仙逆」这种 160 多集的剧，从第 1 季逐集查过去要几分钟，
  // 而且早年的季早已过期；所以只查「最后两季」，与日历页的口径一致。
  const allSeasons = (detail.seasons || []).map((s) => s.seasonNumber);
  const seasonNumbers = item.seasons?.length
    ? item.seasons
    : allSeasons.slice(-2);
  if (!item.seasons?.length && allSeasons.length > seasonNumbers.length) {
    log.info(`[subs] ${item.id} 未指定季，本次只检查最后 ${seasonNumbers.length} 季（共 ${allSeasons.length} 季）`);
  }
  if (!seasonNumbers.length) {
    item.lastMessage = 'TMDB 未返回季信息';
    item.state = 'error';
    return { found: 0, added: [] };
  }

  const downloaded = new Set(item.downloadedKeys);
  let totalAired = 0;
  let candidatesChecked = 0;
  const added = [];
  let lastMessage = '';

  // 一次检查最多补 5 集，避免首次订阅把整个季一次性灌进下载队列
  let budget = 5;

  for (const seasonNumber of seasonNumbers) {
    if (budget <= 0) break;
    let seasonInfo;
    try {
      seasonInfo = await tmdb.season({ id: item.tmdbId, season: seasonNumber });
    } catch (err) {
      log.warn(`[subs] ${item.id} 第 ${seasonNumber} 季信息获取失败: ${err.message}`);
      continue;
    }
    const aired = (seasonInfo.episodes || []).filter((e) => isAired(e.airDate));
    totalAired += aired.length;
    const missing = aired.filter((e) => !downloaded.has(epKey(seasonNumber, e.episodeNumber)));
    if (!missing.length) continue;

    // 缺得多时先试整季包，一次拿到全部
    if (missing.length >= 4) {
      // 整季包必须声明同一季，或声明为合集；片名要过闸。
      const { best: pack, checked } = await searchWithLadder(
        item,
        { type: 'tv', season: seasonNumber, year: item.year, qualityPreference: item.qualityPreference },
        detail.title,
        'pack',
        (c) => c.isSeasonPack && (c.season === null || c.season === seasonNumber),
      );
      candidatesChecked += checked;
      if (pack && item.autoDownload) {
        const packed = addToEngine(item, pack);
        for (const e of missing) {
          downloaded.add(epKey(seasonNumber, e.episodeNumber));
          added.push(epKey(seasonNumber, e.episodeNumber));
        }
        lastMessage = packed.duplicate
          ? `整季包已在下载列表中：${pack.title}`
          : `已加入整季包：${pack.title}`;
        budget = 0;
        continue;
      }
    }

    for (const episode of missing) {
      if (budget <= 0) break;
      // 单集候选必须自己声明同一季，且集号包含目标集；声明了别的季集一律不要。
      const { best, checked } = await searchWithLadder(
        item,
        {
          type: 'tv',
          season: seasonNumber,
          episode: episode.episodeNumber,
          year: item.year,
          qualityPreference: item.qualityPreference,
        },
        detail.title,
        'episode',
        (c) => !c.isSeasonPack
          && c.season === seasonNumber
          && (c.episodeList || []).includes(episode.episodeNumber),
      );
      candidatesChecked += checked;
      if (!best) continue;
      if (!item.autoDownload) {
        lastMessage = `找到 ${checked} 条候选，自动下载已关闭`;
        continue;
      }
      const single = addToEngine(item, best);
      downloaded.add(epKey(seasonNumber, episode.episodeNumber));
      added.push(epKey(seasonNumber, episode.episodeNumber));
      lastMessage = single.duplicate
        ? `已在下载列表中：${best.title}`
        : `已加入下载：${best.title}`;
      budget -= 1;
    }
  }

  item.downloadedKeys = [...downloaded];
  item.totalEpisodes = totalAired;
  if (!lastMessage) {
    lastMessage = totalAired === 0
      ? '暂无已播出的剧集'
      : `已是最新，共 ${totalAired} 集，已下载 ${downloaded.size} 集`;
  }
  item.lastMessage = lastMessage;
  item.state = 'watching';
  return { found: candidatesChecked, added };
}

/** 执行一次检查，并更新调度字段。 */
export async function runCheck(item) {
  const started = new Date();
  let result = { found: 0, added: [] };
  try {
    result = item.type === 'movie' ? await checkMovie(item) : await checkTv(item);
  } catch (err) {
    item.lastMessage = `检查失败：${err.message}`;
    item.state = 'error';
    log.warn(`[subs] ${item.id} 检查失败: ${err.message}`);
  }
  item.lastCheckAt = started.toISOString();
  const interval = getSettings().checkIntervalMinutes || 60;
  item.nextCheckAt = new Date(Date.now() + interval * 60000).toISOString();
  save();
  return { ran: true, found: result.found, added: result.added, message: item.lastMessage };
}

export async function checkNow(id) {
  const item = findItem(id);
  if (!item) return null;
  return runCheck(item);
}

/** 调度循环：每 30 秒看一次有没有到期该检查的订阅。 */
/** 用户在界面上确认「替换为更好的版本」。 */
export function promoteUpgrade(id) {
  const item = findItem(id);
  if (!item || !item.upgrade || !item.upgrade.available) {
    const err = new Error('当前没有可替换的更好版本');
    err.statusCode = 400;
    throw err;
  }
  const cap = capacityCheck(item.upgrade.sizeBytes || 0, Number(((listTasks().stats) || {}).totalSizeBytes) || 0);
  if (!cap.ok) {
    const err = new Error(cap.message);
    err.statusCode = 413;
    throw err;
  }
  engineAdd({ magnet: item.upgrade.magnet }, resolveDownloadDir());
  const title = item.upgrade.title;
  item.upgrade = null;
  item.lastMessage = `已加入更好的版本：${title}`;
  save();
  return { item: decorate(item) };
}

/** 忽略这次提示，之后不再重复提醒同一档位。 */
export function dismissUpgrade(id) {
  const item = findItem(id);
  if (!item) return null;
  item.upgrade = null;
  item.lastMessage = '已忽略画质升级提示';
  save();
  return { item: decorate(item) };
}

export function startScheduler() {
  if (timer) return;
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const items = Array.isArray(store.data.items) ? store.data.items : [];
      for (const item of items) {
        if (!item.enabled) continue;
        if (!getSettings().tmdbApiKey) break;
        const due = !item.nextCheckAt || item.nextCheckAt <= new Date().toISOString();
        if (!due) continue;
        await runCheck(item);
      }
    } catch (err) {
      log.error(`[subs] 调度循环异常: ${err.message}`);
    } finally {
      running = false;
    }
  }, 30000);
  if (timer.unref) timer.unref();
}

/* --------------------------------------------------------------- 导入导出 */

export function exportPayload() {
  const items = Array.isArray(store.data.items) ? store.data.items : [];
  return {
    format: 'wanspilot-subscriptions',
    version: 1,
    exportedAt: new Date().toISOString(),
    items: items.map(decorate),
  };
}

export function importPayload(payload) {
  const incoming = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.items)
      ? payload.items
      : [];
  const items = Array.isArray(store.data.items) ? store.data.items : [];
  let imported = 0;
  let skipped = 0;

  for (const raw of incoming) {
    const tmdbId = Number.parseInt(raw?.tmdbId, 10);
    const type = raw?.type === 'movie' ? 'movie' : 'tv';
    if (!Number.isFinite(tmdbId)) {
      skipped += 1;
      continue;
    }
    if (items.some((it) => it.tmdbId === tmdbId && it.type === type)) {
      skipped += 1;
      continue;
    }
    items.push({
      id: newId(),
      type,
      tmdbId,
      title: String(raw.title || '').trim(),
      originalTitle: String(raw.originalTitle || ''),
      posterPath: String(raw.posterPath || ''),
      year: String(raw.year || ''),
      seasons: type === 'movie' ? null : normalizeSeasons(raw.seasons),
      qualityPreference: normalizeQuality(raw.qualityPreference, getSettings().qualityPreference),
      minSeeders: clamp(raw.minSeeders, 0, 100000, getSettings().minSeeders),
      maxSizeGB: clamp(raw.maxSizeGB, 1, 500, getSettings().maxSizeGB),
      autoDownload: raw.autoDownload !== false,
      enabled: true,
      createdAt: new Date().toISOString(),
      lastCheckAt: null,
      nextCheckAt: new Date().toISOString(),
      lastMessage: '由导入创建，等待首次检查',
      downloadedKeys: Array.isArray(raw.downloadedKeys) ? raw.downloadedKeys : [],
      state: 'idle',
      totalEpisodes: 0,
    });
    imported += 1;
  }

  store.data.items = items;
  save();
  return { imported, skipped };
}
