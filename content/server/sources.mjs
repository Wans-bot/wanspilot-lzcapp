/**
 * 索引源：查询公开种子站，归一化结果，打分排序。
 *
 * 源列表：
 * - apibay（The Pirate Bay 的公开 API）：直连可用，覆盖英文电影与剧集。
 * - torrents-csv：直连可用，覆盖部分中文内容。
 * - nyaa：动漫资源最全，但实测在受限网络下不可达，只有配置了「网络代理」才启用。
 *
 * 本模块保存最近 10 分钟的结果，避免同一个关键词反复打站点。
 */
import { httpFetch } from './tmdb.mjs';
import { getSettings } from './settings.mjs';
import { log } from './log.mjs';

// 盒子上单次 connect 实测 7–12 秒，所以单源给 9 秒、只试一次；
// 再叠一个总时限：到点先用已返回的源出结果，慢源报告成「超时未返回」，
// 不让它拖住整次搜索（实测一个慢源能把一次搜索拖到 30–65 秒）。
const SOURCE_TIMEOUT_MS = 9000;
const SOURCE_ATTEMPTS = 1;
const SEARCH_DEADLINE_MS = 12000;
const SEARCH_CACHE_TTL_MS = 10 * 60 * 1000;
const SEARCH_CACHE_MAX = 120;
const searchCache = new Map();

const UA = 'Mozilla/5.0 (compatible; wanspilot/1.0; +https://github.com/wans/wanspilot)';

/* ------------------------------------------------------------ 标题解析 */

const RESOLUTIONS = [
  { key: '2160p', re: /(2160p|4k|uhd)/i, rank: 4 },
  { key: '1440p', re: /(1440p|2k)/i, rank: 3 },
  { key: '1080p', re: /1080p/i, rank: 3 },
  { key: '720p', re: /720p/i, rank: 2 },
  { key: '480p', re: /(480p|sd)/i, rank: 1 },
];

const CODECS = [
  { key: 'H265', re: /(x265|h\.?265|hevc)/i },
  { key: 'AV1', re: /av1/i },
  { key: 'H264', re: /(x264|h\.?264|avc)/i },
];

const SOURCES = [
  { key: 'Remux', re: /remux/i },
  { key: 'BluRay', re: /(bluray|blu-ray|bdrip|brrip)/i },
  { key: 'WEB', re: /(web-?dl|webrip|web)/i },
  { key: 'HDTV', re: /(hdtv|pdtv)/i },
  { key: 'DVDRip', re: /(dvdrip|dvd)/i },
];

function detect(list, text) {
  for (const item of list) if (item.re.test(text)) return item;
  return null;
}

/** 从种子标题里提取结构化字段。 */
export function parseTitle(title) {
  const text = String(title || '');
  const out = {
    resolution: '',
    resolutionRank: 0,
    codec: '',
    sourceTag: '',
    season: null,
    episode: null,
    episodeList: [],
    isSeasonPack: false,
  };

  const res = detect(RESOLUTIONS, text);
  if (res) {
    out.resolution = res.key;
    out.resolutionRank = res.rank;
  }
  const codec = detect(CODECS, text);
  if (codec) out.codec = codec.key;
  const src = detect(SOURCES, text);
  if (src) out.sourceTag = src.key;

  // 季集：支持 S01E02、S01E01E02、S01E01-E03、1x02、第1季第2集
  const multi = /S(\d{1,2})E(\d{1,3})((?:[-.]?E?\d{1,3})*)/i.exec(text);
  if (multi) {
    const season = Number.parseInt(multi[1], 10);
    const first = Number.parseInt(multi[2], 10);
    out.season = season;
    out.episode = first;
    const eps = new Set([first]);
    const rest = multi[3] || '';
    for (const m of rest.matchAll(/(\d{1,3})/g)) eps.add(Number.parseInt(m[1], 10));
    out.episodeList = [...eps].sort((a, b) => a - b);
  } else {
    const alt = /(\d{1,2})x(\d{1,3})/.exec(text);
    if (alt) {
      out.season = Number.parseInt(alt[1], 10);
      out.episode = Number.parseInt(alt[2], 10);
      out.episodeList = [out.episode];
    } else {
      const cn = /第\s*(\d{1,2})\s*季/.exec(text);
      if (cn) out.season = Number.parseInt(cn[1], 10);
      const cnEp = /第\s*(\d{1,3})\s*[集话話期]/.exec(text);
      if (cnEp) {
        out.episode = Number.parseInt(cnEp[1], 10);
        out.episodeList = [out.episode];
      }
    }
  }

  // 只有裸季号（S01）而没有集号 → 也是整季包
  if (out.season === null) {
    const bareSeason = /(?:^|[^a-z0-9])s(\d{1,2})(?![0-9ex])/i.exec(text);
    if (bareSeason) out.season = Number.parseInt(bareSeason[1], 10);
  }

  // 有季号但没有集号，且不是「全集/合集」以外的歧义情况 → 视作整季包
  const hasSeasonWord = /(complete|season\s*\d|全集|全\d+集|s\d{1,2}\b(?!e))/i.test(text);
  if (out.season !== null && out.episode === null) {
    out.isSeasonPack = true;
  } else if (out.season === null && hasSeasonWord) {
    out.isSeasonPack = true;
  } else if (/完整版|全集|合集|complete\s*series/i.test(text)) {
    out.isSeasonPack = true;
  }

  return out;
}

/* --------------------------------------------------------------- 索引源 */

function magnetFor(infoHash, name, trackers) {
  const hash = String(infoHash || '').trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(hash)) return '';
  const dn = encodeURIComponent(String(name || '').slice(0, 120));
  const tr = (trackers || [
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://open.tracker.cl:1337/announce',
    'udp://tracker.openbittorrent.com:6969/announce',
    'udp://exodus.desync.com:6969/announce',
    'udp://tracker.torrent.eu.org:451/announce',
  ])
    .map((t) => `&tr=${encodeURIComponent(t)}`)
    .join('');
  return `magnet:?xt=urn:btih:${hash}&dn=${dn}${tr}`;
}

function baseItem({ infoHash, title, indexer, indexerName, sizeBytes, seeders, leechers, publishedAt }) {
  const parsed = parseTitle(title);
  const hash = String(infoHash || '').toLowerCase();
  const item = {
    id: `${indexer}:${hash}`,
    title: String(title || '').trim(),
    indexer,
    indexerName,
    infoHash: hash,
    magnet: magnetFor(hash, title),
    sizeBytes: Number(sizeBytes) || 0,
    seeders: Number(seeders) || 0,
    leechers: Number(leechers) || 0,
    publishedAt: publishedAt ? new Date(publishedAt).toISOString() : '',
    ...parsed,
    score: 0,
  };
  item.trust = trustScore(item, parsed);
  item.trustLabel = trustLabel(item.trust);
  return item;
}

const CATEGORY_ALL = 0;
const CATEGORY_TV = 205;
const CATEGORY_ANIME = 208;

async function searchApibay(query, context) {
  const cat = context.type === 'tv' || context.type === 'anime' ? CATEGORY_TV : CATEGORY_ALL;
  const url = `https://apibay.org/q.php?q=${encodeURIComponent(query)}&cat=${cat}`;
  const res = await httpFetch(url, { headers: { 'user-agent': UA }, timeoutMs: SOURCE_TIMEOUT_MS, attempts: SOURCE_ATTEMPTS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data
    .filter((r) => r && r.info_hash && !/^0+$/.test(r.info_hash))
    .map((r) =>
      baseItem({
        infoHash: r.info_hash,
        title: r.name,
        indexer: 'apibay',
        indexerName: 'The Pirate Bay',
        sizeBytes: r.size,
        seeders: r.seeders,
        leechers: r.leechers,
        publishedAt: Number(r.added) > 0 ? Number(r.added) * 1000 : 0,
      }),
    );
}

async function searchTorrentsCsv(query, context) {
  const size = context.type === 'movie' ? 60 : 120;
  const url = `https://torrents-csv.com/service/search?q=${encodeURIComponent(query)}&size=${size}`;
  const res = await httpFetch(url, { headers: { 'user-agent': UA }, timeoutMs: SOURCE_TIMEOUT_MS, attempts: SOURCE_ATTEMPTS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const list = Array.isArray(data) ? data : data.torrents || [];
  return list.map((r) =>
    baseItem({
      infoHash: r.infohash,
      title: r.name,
      indexer: 'torrents-csv',
      indexerName: 'Torrents-CSV',
      sizeBytes: r.size_bytes,
      seeders: r.seeders,
      leechers: r.leechers,
      publishedAt: Number(r.created_unix) > 0 ? Number(r.created_unix) * 1000 : 0,
    }),
  );
}

/** nyaa 只提供 RSS，做最小化解析。仅在配置了代理时启用。 */
async function searchNyaa(query, context) {
  const cat = context.type === 'anime' ? '1_2' : '1_0';
  const url = `https://nyaa.si/?page=rss&q=${encodeURIComponent(query)}&c=${cat}&f=0`;
  const res = await httpFetch(url, { headers: { 'user-agent': UA }, timeoutMs: SOURCE_TIMEOUT_MS, attempts: SOURCE_ATTEMPTS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  const items = [];
  for (const block of xml.split('<item>').slice(1)) {
    const title = (/<title><!\[CDATA\[(.*?)\]\]><\/title>/.exec(block) || /<title>(.*?)<\/title>/.exec(block) || [])[1] || '';
    const link = (/<link>(.*?)<\/link>/.exec(block) || [])[1] || '';
    const hashMatch = /urn:btih:([a-fA-F0-9]{40})/.exec(block) || /btih:([a-fA-F0-9]{40})/.exec(link);
    const sizeMatch = /<nyaa:size>(.*?)<\/nyaa:size>/.exec(block);
    const seedMatch = /<nyaa:seeders>(\d+)<\/nyaa:seeders>/.exec(block);
    const leechMatch = /<nyaa:leechers>(\d+)<\/nyaa:leechers>/.exec(block);
    const dateMatch = /<pubDate>(.*?)<\/pubDate>/.exec(block);
    if (!hashMatch) continue;
    items.push(
      baseItem({
        infoHash: hashMatch[1],
        title,
        indexer: 'nyaa',
        indexerName: 'Nyaa',
        sizeBytes: parseHumanSize(sizeMatch ? sizeMatch[1] : ''),
        seeders: seedMatch ? seedMatch[1] : 0,
        leechers: leechMatch ? leechMatch[1] : 0,
        publishedAt: dateMatch ? Date.parse(dateMatch[1]) : 0,
      }),
    );
  }
  return items;
}

function parseHumanSize(text) {
  const m = /([\d.]+)\s*(TiB|GiB|MiB|KiB|TB|GB|MB|KB|B)/i.exec(String(text || ''));
  if (!m) return 0;
  const value = Number.parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  const factor = { B: 1, KB: 1e3, KIB: 1024, MB: 1e6, MIB: 1024 ** 2, GB: 1e9, GIB: 1024 ** 3, TB: 1e12, TIB: 1024 ** 4 }[unit] || 1;
  return Math.round(value * factor);
}

/* ------------------------------------------------------------ 打分与筛选 */

const QUALITY_RANK = { any: 0, '480p': 1, '720p': 2, '1080p': 3, '2160p': 4 };

/**
 * 打分规则：画质是否符合偏好最重要，其次是做种数，最后看体积是否合理。
 * 结果会按分数降序返回，前端直接按顺序展示。
 */
/**
 * 资源可信度：把发布组、命名规范度、做种数、体积合理性合成 0–100。
 * 只作为界面上的提示，不参与排序；排序仍按画质偏好与做种数。
 */
export function trustScore(item, parsed) {
  let score = 48;
  score += Math.min(18, Math.round(Math.log10(Math.max(1, item.seeders)) * 7));
  if (parsed.resolution) score += 4;
  if (parsed.codec) score += 4;
  if (parsed.sourceTag) score += 4;
  if (/-[A-Za-z0-9]{2,20}$/.test(String(item.title || ''))) score += 6;
  if (/\b(cam|hdcam|telesync|ts|枪版|抢先)\b/i.test(String(item.title || ''))) score -= 28;
  if (/\bsample\b/i.test(String(item.title || ''))) score -= 12;
  const gb = Number(item.sizeBytes || 0) / 1024 ** 3;
  if (parsed.resolution === '2160p' && gb > 0 && gb < 4) score -= 14;
  if (parsed.resolution === '1080p' && gb > 0 && gb < 0.8) score -= 10;
  return Math.max(0, Math.min(100, Math.round(score)));
}

/** 可信度的文字档位，界面直接显示。 */
export function trustLabel(score) {
  if (score >= 85) return '高';
  if (score >= 70) return '较高';
  if (score >= 55) return '一般';
  return '低';
}

function scoreItem(item, context) {
  const settings = getSettings();
  const prefer = context.qualityPreference || settings.qualityPreference || '1080p';
  let score = 0;

  if (prefer !== 'any') {
    if (item.resolution === prefer) score += 50;
    else if (item.resolutionRank > 0) score -= Math.abs(QUALITY_RANK[prefer] - item.resolutionRank) * 10;
  } else {
    score += item.resolutionRank * 5;
  }

  // 做种数用对数缩放，避免大量种子把画质差异压过去
  score += Math.min(30, Math.log10(Math.max(1, item.seeders)) * 12);

  // 上下文匹配：季集对得上再加分
  if (context.season !== undefined && context.season !== null && item.season !== null && item.season !== context.season) {
    // 明确指向别的季，直接压到列表底部
    score -= 40;
  }
  if (context.season !== undefined && context.season !== null && item.season === context.season) {
    score += 12;
    if (context.episode !== undefined && context.episode !== null) {
      if (item.episodeList.includes(context.episode)) score += 15;
      else if (item.isSeasonPack) score += 6;
      else score -= 10;
    } else if (item.isSeasonPack) {
      score += 8;
    }
  }

  // 体积是否落在可接受区间
  const maxBytes = settings.maxSizeGB * 1024 ** 3;
  if (item.sizeBytes > maxBytes) score -= 25;
  else if (item.sizeBytes > 0 && item.sizeBytes < 50 * 1024 ** 2) score -= 15;

  // 明显无关的条目（音乐、软件包等）降权
  if (/\b(mp3|flac|discography|album|software|ebook|epub|pdf|xxx|porn)\b/i.test(item.title)) score -= 60;

  return Math.round(score * 10) / 10;
}

/* ------------------------------------------------------------------ 入口 */

const REGISTRY = [
  { id: 'apibay', name: 'The Pirate Bay', run: searchApibay },
  { id: 'torrents-csv', name: 'Torrents-CSV', run: searchTorrentsCsv },
  { id: 'nyaa', name: 'Nyaa', run: searchNyaa, needsProxy: true },
];

function buildQueries(context) {
  const raw = String(context.q || '').trim();
  if (!raw) return [];
  const queries = [raw];
  const hasSeason = context.season !== undefined && context.season !== null;

  if (hasSeason) {
    const s = String(context.season).padStart(2, '0');
    if (context.episode !== undefined && context.episode !== null) {
      const e = String(context.episode).padStart(2, '0');
      queries.push(`${raw} S${s}E${e}`);
    } else {
      queries.push(`${raw} S${s}`);
    }
  }
  // 加年份能显著提高电影命中率
  if (context.year) queries.push(`${raw} ${context.year}`);
  return [...new Set(queries)];
}

export function activeSources() {
  const { proxy } = getSettings();
  return REGISTRY.filter((s) => !s.needsProxy || proxy);
}

/** 查一个源的全部查询词，把结果与报告写进传入的两个数组。 */
async function runSource(source, runQueries, context, collected, sourceReports) {
  const sourceStarted = Date.now();
  let count = 0;
  let error = '';
  for (const q of runQueries) {
    try {
      const batch = await source.run(q, context);
      collected.push(...batch);
      count += batch.length;
    } catch (err) {
      if (!error) error = err.message;
      log.warn(`[sources] ${source.id} 查询失败: ${err.message}`);
    }
  }
  sourceReports.push({
    id: source.id,
    name: source.name,
    ok: !error,
    count,
    latencyMs: Date.now() - sourceStarted,
    error,
  });
}

/**
 * 并发查询所有启用源；总时限内没返回的源本次跳过，先用已有结果出列表。
 * @param {object} context { q, type, season, episode, year, qualityPreference }
 */
export async function searchResources(context) {
  const queries = buildQueries(context);
  const sources = activeSources();
  const settings = getSettings();

  if (!queries.length) {
    return { query: '', sources: [], items: [] };
  }
  // 季集查询已经含季号，额外再跑一次裸标题能捞到整季包
  const runQueries = queries.slice(0, 2);

  // 同一个关键词 10 分钟内直接复用：订阅检查会对同一部剧反复搜，
  // 命中缓存能把一次检查从两分钟压到几秒。
  const cacheKey = JSON.stringify({
    q: runQueries,
    type: context.type || '',
    season: context.season === undefined ? '' : context.season,
    episode: context.episode === undefined ? '' : context.episode,
    year: context.year || '',
    quality: context.qualityPreference || '',
    sources: sources.map((source) => source.id),
  });
  const hit = searchCache.get(cacheKey);
  if (hit && Date.now() - hit.at < SEARCH_CACHE_TTL_MS) {
    return Object.assign({}, hit.payload, { cached: true });
  }

  const started = Date.now();
  const sourceReports = [];
  const collected = [];

  const work = sources.map((source) => runSource(source, runQueries, context, collected, sourceReports));

  // 总时限到点就用已有结果，不再等慢源；没回来的源在报告里标成超时
  await Promise.race([
    Promise.allSettled(work),
    new Promise((resolve) => setTimeout(resolve, SEARCH_DEADLINE_MS)),
  ]);
  const reported = new Set(sourceReports.map((report) => report.id));
  for (const source of sources) {
    if (reported.has(source.id)) continue;
    sourceReports.push({
      id: source.id,
      name: source.name,
      ok: false,
      count: 0,
      latencyMs: Date.now() - started,
      error: `超过 ${Math.round(SEARCH_DEADLINE_MS / 1000)} 秒未返回，本次跳过`,
    });
    log.warn(`[sources] ${source.id} 超过总时限未返回，本次搜索先跳过它`);
  }

  // 按 infoHash 去重，保留做种更多的那个
  const byHash = new Map();
  for (const item of collected) {
    if (!item.infoHash) continue;
    const prev = byHash.get(item.infoHash);
    if (!prev || prev.seeders < item.seeders) byHash.set(item.infoHash, item);
  }

  let items = [...byHash.values()];
  // 上下文相关性粗筛：标题里必须出现关键词首词，避免站点把无关内容一起返回
  const keywords = String(context.q || '')
    .toLowerCase()
    .split(/[\s:：\-]+/)
    .filter((w) => w.length >= 2)
    .slice(0, 3);
  if (keywords.length) {
    items = items.filter((it) => {
      const t = it.title.toLowerCase();
      return keywords.some((k) => t.includes(k)) || it.seeders > 200;
    });
  }

  for (const item of items) item.score = scoreItem(item, context);
  items.sort((a, b) => b.score - a.score || b.seeders - a.seeders);

  const payload = {
    query: runQueries[0],
    sources: sourceReports.sort((a, b) => a.id.localeCompare(b.id)),
    items: items.slice(0, Math.max(30, settings.minSeeders > 0 ? 60 : 60)),
  };
  // 只缓存有结果的搜索：空的可能只是某个源当时不可用，别把「没找到」钉住 10 分钟
  if (payload.items.length) {
    if (searchCache.size >= SEARCH_CACHE_MAX) {
      const oldest = searchCache.keys().next();
      if (!oldest.done) searchCache.delete(oldest.value);
    }
    searchCache.set(cacheKey, { at: Date.now(), payload });
  }
  return payload;
}

/** 各源连通性自检，供设置页显示。 */
export async function sourcesStatus() {
  const sources = activeSources();
  return Promise.all(
    sources.map(async (source) => {
      const started = Date.now();
      try {
        const results = await source.run('ubuntu', { type: 'movie', q: 'ubuntu' });
        return { id: source.id, name: source.name, ok: true, latencyMs: Date.now() - started, message: `返回 ${results.length} 条` };
      } catch (err) {
        return { id: source.id, name: source.name, ok: false, latencyMs: Date.now() - started, message: err.message };
      }
    }),
  );
}
