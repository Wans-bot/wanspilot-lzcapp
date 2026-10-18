/**
 * 设置项：读写、校验、路径解析与自检。
 * 设置保存在 /data/settings.json。
 */
import fs from 'node:fs';
import path from 'node:path';
import { JsonStore } from './store.mjs';
import { log } from './log.mjs';

export const DATA_DIR = process.env.WP_DATA_DIR || '/data';
export const DOWNLOAD_ROOT = process.env.WP_DOWNLOAD_DIR || '/downloads';
export const CACHE_DIR = process.env.WP_CACHE_DIR || '/cache/wanspilot';

/**
 * 默认值说明：
 * - tmdbApiBase 用 api.tmdb.org：实测 api.themoviedb.org 在受限网络下不可达，
 *   api.tmdb.org 可达且返回真实 TMDB 响应。
 * - tmdbImageBase 用 Bunny CDN 直连域名：实测 image.tmdb.org 的 TLS 被重置，
 *   而它背后的 tmdb-image-prod.b-cdn.net 可达。
 * 两者都可在设置页改，用户也可以指向商店的「TMDB Proxy」应用。
 */
export const DEFAULT_SETTINGS = {
  tmdbApiKey: '',
  tmdbApiBase: 'https://api.tmdb.org/3',
  tmdbImageBase: 'https://tmdb-image-prod.b-cdn.net/t/p',
  proxy: '',
  downloadDir: '下载/wanspilot',
  qualityPreference: '1080p',
  minSeeders: 5,
  maxSizeGB: 30,
  checkIntervalMinutes: 60,
  autoDownload: true,
  theme: 'dark',
  // 下载与整理
  quotaGB: 0,
  autoOrganize: false,
  writeNfo: false,
  deleteSamples: true,
};

const QUALITY_VALUES = new Set(['any', '720p', '1080p', '2160p']);

let store = null;

export function initSettings() {
  store = new JsonStore(path.join(DATA_DIR, 'settings.json'), DEFAULT_SETTINGS, {
    debounceMs: 100,
  });
  // 保证下载目录存在，否则下载引擎第一次抓取元数据就会失败。
  try {
    const dir = resolveDownloadDir();
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    log.error(`[settings] 创建下载目录失败: ${err.message}`);
  }
  return getSettings();
}

/** 返回设置的副本，调用方改它不会影响存储。 */
export function getSettings() {
  return { ...DEFAULT_SETTINGS, ...store.data };
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/**
 * 只接受已知字段，并对每个字段做类型与范围校验。
 * 未出现的字段保持原值；显式传空字符串表示清空该字段。
 */
export function updateSettings(patch) {
  if (!patch || typeof patch !== 'object') return getSettings();
  const next = { ...store.data };

  if ('tmdbApiKey' in patch) {
    next.tmdbApiKey = String(patch.tmdbApiKey ?? '').trim();
  }
  if ('tmdbApiBase' in patch) {
    const v = String(patch.tmdbApiBase ?? '').trim().replace(/\/+$/, '');
    next.tmdbApiBase = v || DEFAULT_SETTINGS.tmdbApiBase;
  }
  if ('tmdbImageBase' in patch) {
    const v = String(patch.tmdbImageBase ?? '').trim().replace(/\/+$/, '');
    next.tmdbImageBase = v || DEFAULT_SETTINGS.tmdbImageBase;
  }
  if ('proxy' in patch) {
    const v = String(patch.proxy ?? '').trim();
    if (v && !/^(https?|socks[45]?):\/\/[^\s]+$/i.test(v)) {
      const err = new Error('代理地址格式不正确，应形如 http://127.0.0.1:7890');
      err.statusCode = 400;
      throw err;
    }
    next.proxy = v;
  }
  if ('downloadDir' in patch) {
    let v = String(patch.downloadDir ?? '').trim().replace(/^\/+/, '');
    // 去掉可能的盘符式前缀与 .. ，保证始终落在 /downloads 之下。
    v = v.split('/').filter((seg) => seg && seg !== '.' && seg !== '..').join('/');
    next.downloadDir = v || DEFAULT_SETTINGS.downloadDir;
  }
  if ('qualityPreference' in patch) {
    const v = String(patch.qualityPreference ?? '').trim();
    if (!QUALITY_VALUES.has(v)) {
      const err = new Error('画质偏好取值不合法');
      err.statusCode = 400;
      throw err;
    }
    next.qualityPreference = v;
  }
  if ('minSeeders' in patch) {
    next.minSeeders = clampInt(patch.minSeeders, 0, 100000, DEFAULT_SETTINGS.minSeeders);
  }
  if ('maxSizeGB' in patch) {
    next.maxSizeGB = clampInt(patch.maxSizeGB, 1, 500, DEFAULT_SETTINGS.maxSizeGB);
  }
  if ('checkIntervalMinutes' in patch) {
    next.checkIntervalMinutes = clampInt(patch.checkIntervalMinutes, 5, 1440, DEFAULT_SETTINGS.checkIntervalMinutes);
  }
  if ('autoDownload' in patch) {
    next.autoDownload = Boolean(patch.autoDownload);
  }
  if ('quotaGB' in patch) {
    next.quotaGB = clampInt(patch.quotaGB, 0, 100000, DEFAULT_SETTINGS.quotaGB);
  }
  if ('autoOrganize' in patch) {
    next.autoOrganize = Boolean(patch.autoOrganize);
  }
  if ('writeNfo' in patch) {
    next.writeNfo = Boolean(patch.writeNfo);
  }
  if ('deleteSamples' in patch) {
    next.deleteSamples = Boolean(patch.deleteSamples);
  }
  if ('theme' in patch) {
    // 只有白天与夜间两态；历史值 auto 落到夜间，前端会在首屏把它落成确定值
    const v = String(patch.theme ?? '').trim();
    next.theme = v === 'light' || v === 'dark' ? v : 'dark';
  }

  store.data = next;
  store.save();

  if ('downloadDir' in patch) {
    try {
      fs.mkdirSync(resolveDownloadDir(), { recursive: true });
    } catch (err) {
      log.error(`[settings] 创建下载目录失败: ${err.message}`);
      const wrapped = new Error(`下载目录不可用: ${err.message}`);
      wrapped.statusCode = 400;
      throw wrapped;
    }
  }
  return getSettings();
}

/** 把设置里的相对目录解析成容器内的绝对路径。 */
export function resolveDownloadDir(settings = getSettings()) {
  const rel = String(settings.downloadDir || DEFAULT_SETTINGS.downloadDir)
    .split('/')
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .join('/');
  return path.join(DOWNLOAD_ROOT, rel);
}

function isWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.wm-write-test-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

export function downloadDirStatus() {
  const settings = getSettings();
  const dir = resolveDownloadDir(settings);
  const ok = isWritable(dir);
  return {
    ok,
    dir,
    message: ok ? `${dir} 可写` : `${dir} 不可写，请检查下载目录设置`,
  };
}

export function cacheDir() {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  } catch {
    // 缓存目录不可用时后端会退化为不缓存
  }
  return CACHE_DIR;
}
