/**
 * TMDB 客户端。
 *
 * 设计要点：
 * 1. 接口地址与图片地址都可配置。默认值是为受限网络实测出来的可用地址，
 *    见 settings.mjs 的注释。
 * 2. 图片一律由后端代理并落地缓存：容器与用户浏览器未必都能直连 TMDB 图片域名，
 *    经后端转发后前端只访问同源地址。
 * 3. 代理设置通过 undici 的 ProxyAgent 生效，同时作用于 TMDB 与索引源。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Agent, ProxyAgent, fetch as undiciFetch } from 'undici';
import { getSettings, cacheDir } from './settings.mjs';
import { log } from './log.mjs';

const IMAGE_SIZES = new Set(['w92', 'w154', 'w185', 'w342', 'w500', 'w780', 'original']);
const DEFAULT_TIMEOUT_MS = 20000;

// 实测（2026-10-14，盒子侧）：出网偶发慢连接，TMDB 8 次探测有 1 次 12 秒超时，
// torrents-csv 单次 TCP connect 要 7.4 秒。连接超时按 10 秒会让这类抖动直接变成
// 用户可见的 500，因此放宽到 30 秒，并在传输层失败时做指数退避重试。
const CONNECT_TIMEOUT_MS = 30000;
const DEFAULT_ATTEMPTS = 3;
const RETRY_BASE_MS = 500;

let directAgent = new Agent({ connect: { timeout: CONNECT_TIMEOUT_MS } });
let proxyAgent = null;
let proxyAgentFor = '';

/** 按当前设置取 dispatcher。代理地址变化时重建。 */
function dispatcher() {
  const { proxy } = getSettings();
  if (!proxy) return directAgent;
  if (proxyAgent && proxyAgentFor === proxy) return proxyAgent;
  try {
    proxyAgent = new ProxyAgent({ uri: proxy, connect: { timeout: CONNECT_TIMEOUT_MS } });
    proxyAgentFor = proxy;
    log.info(`[tmdb] 已启用网络代理 ${proxy}`);
    return proxyAgent;
  } catch (err) {
    log.error(`[tmdb] 代理地址无效，回退直连: ${err.message}`);
    proxyAgent = null;
    proxyAgentFor = '';
    return directAgent;
  }
}

/**
 * 统一的出站请求。所有对外请求都应走这里，保证代理、超时与重试行为一致。
 *
 * 重试只针对连接失败、超时与 5xx：这类失败多为网络抖动，重试一次就能恢复；
 * 4xx 是确定的客户端错误，重试没有意义，直接返回给调用方。
 * 每次尝试都用新的超时信号，避免多次尝试共享同一个 deadline。
 *
 * @param {object} [options]
 * @param {number} [options.timeoutMs] 单次尝试的超时
 * @param {number} [options.attempts] 总尝试次数，含首次
 * @returns {Promise<Response>}
 */
export async function httpFetch(url, options = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, attempts = DEFAULT_ATTEMPTS, ...rest } = options;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await undiciFetch(url, {
        ...rest,
        dispatcher: dispatcher(),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status < 500 || attempt >= attempts) return res;
      await res.body?.cancel().catch(() => {});
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
      if (attempt >= attempts) break;
    }
    const waitMs = RETRY_BASE_MS * 2 ** (attempt - 1);
    log.warn(`[http] 第 ${attempt} 次尝试失败，${waitMs}ms 后重试：${String(url).slice(0, 96)} — ${lastError.message}`);
    await new Promise((r) => setTimeout(r, waitMs));
  }
  throw lastError;
}

/** 判断 Key 是 v3 的 api_key 还是 v4 的 Bearer Token。 */
function isBearerToken(key) {
  return typeof key === 'string' && key.split('.').length === 3 && key.length > 80;
}

function requireKey() {
  const { tmdbApiKey } = getSettings();
  if (!tmdbApiKey) {
    const err = new Error('尚未填写 TMDB API Key，请先到「设置」页填写');
    err.statusCode = 428;
    throw err;
  }
  return tmdbApiKey;
}

/**
 * 影视资料只读且短时间内不变：缓存住之后，来回切换影视墙、搜索与详情页时不再等 TMDB。
 * 键里带上接口地址与 Key 的指纹，改了设置就不会命中旧数据。
 */
const RESPONSE_TTL_MS = 10 * 60 * 1000;
const RESPONSE_CACHE_MAX = 400;
const responseCache = new Map();

function responseCacheKey(apiPath, params, apiBase, apiKey) {
  const fingerprint = crypto.createHash('sha1').update(`${apiBase}|${apiKey}`).digest('hex').slice(0, 8);
  const query = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([name, value]) => `${name}=${value}`)
    .sort()
    .join('&');
  return `${fingerprint}|${apiPath}|${query}`;
}

function rememberResponse(cacheKey, payload) {
  if (responseCache.size >= RESPONSE_CACHE_MAX) {
    const oldest = responseCache.keys().next();
    if (!oldest.done) responseCache.delete(oldest.value);
  }
  responseCache.set(cacheKey, { at: Date.now(), payload });
}

/**
 * 调用 TMDB 接口，命中缓存时直接返回上次的结果。
 * @param {string} apiPath 形如 `/movie/popular`
 * @param {Record<string, any>} [params]
 */
export async function tmdbGet(apiPath, params = {}) {
  const key = requireKey();
  const { tmdbApiBase } = getSettings();
  const cacheKey = responseCacheKey(apiPath, params, tmdbApiBase, key);
  const cached = responseCache.get(cacheKey);
  if (cached && Date.now() - cached.at < RESPONSE_TTL_MS) return cached.payload;

  let url;
  try {
    url = new URL(`${tmdbApiBase.replace(/\/+$/, '')}${apiPath}`);
  } catch {
    // 设置里填错接口地址时，给出可读原因，而不是让 URL 构造异常直接冒到 500
    const err = new Error(`TMDB 接口地址无效：${tmdbApiBase}`);
    err.statusCode = 502;
    throw err;
  }
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    url.searchParams.set(k, String(v));
  }

  const headers = { accept: 'application/json' };
  if (isBearerToken(key)) headers.authorization = `Bearer ${key}`;
  else url.searchParams.set('api_key', key);

  const res = await httpFetch(url.toString(), { headers, timeoutMs: 15000 });
  const text = await res.text();

  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    // 非 JSON 响应通常是网络中间设备返回的错误页
    const err = new Error(`TMDB 返回了非 JSON 响应（HTTP ${res.status}）`);
    err.statusCode = 502;
    throw err;
  }

  if (!res.ok) {
    const msg = payload?.status_message || `HTTP ${res.status}`;
    const err = new Error(`TMDB 请求失败: ${msg}`);
    err.statusCode = res.status === 401 ? 401 : 502;
    throw err;
  }
  rememberResponse(cacheKey, payload);
  return payload;
}

/* ------------------------------------------------------------------ 归一化 */

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function yearOf(dateStr) {
  const m = /^(\d{4})/.exec(String(dateStr || ''));
  return m ? m[1] : '';
}

/** TMDB 原始条目 → MediaCard。 */
function toCard(raw, forceType) {
  const type = forceType || (raw.media_type === 'tv' || raw.first_air_date ? 'tv' : 'movie');
  const title = raw.title || raw.name || raw.original_title || raw.original_name || '';
  return {
    id: num(raw.id),
    type,
    title,
    originalTitle: raw.original_title || raw.original_name || '',
    year: yearOf(raw.release_date || raw.first_air_date),
    posterPath: raw.poster_path || '',
    backdropPath: raw.backdrop_path || '',
    voteAverage: Math.round(num(raw.vote_average) * 10) / 10,
    overview: raw.overview || '',
    // 关键词搜索模式下的筛选在前端做，所以卡片要带上风格与原始语种
    genreIds: Array.isArray(raw.genre_ids) ? raw.genre_ids : (raw.genres || []).map((g) => num(g.id)),
    language: raw.original_language || '',
  };
}

function pickTrailer(list) {
  const found = (Array.isArray(list) ? list : []).find(
    (v) => v && v.site === 'YouTube' && (v.type === 'Trailer' || v.type === 'Teaser'),
  );
  return found ? found.key || '' : '';
}

/** 动漫：TMDB 侧等同剧集 + 动画类型（16）+ 日语原声。 */
function animeParams(base) {
  return { ...base, with_genres: '16', with_original_language: 'ja', include_adult: 'false' };
}

const BROWSE_PATHS = {
  movie: {
    popular: '/movie/popular',
    top_rated: '/movie/top_rated',
    now_playing: '/movie/now_playing',
    upcoming: '/movie/upcoming',
  },
  tv: {
    popular: '/tv/popular',
    top_rated: '/tv/top_rated',
    airing_today: '/tv/airing_today',
    on_the_air: '/tv/on_the_air',
  },
};

/** 影视墙区块定义。id 与前端约定一致。 */
const HOME_BLOCKS = [
  { id: 'movie-trending', type: 'movie', title: '热门电影', kind: 'trending' },
  { id: 'tv-trending', type: 'tv', title: '热门剧集', kind: 'trending' },
  { id: 'anime-trending', type: 'anime', title: '热门动漫', kind: 'trending' },
  { id: 'movie-top', type: 'movie', title: '高分电影', kind: 'browse', category: 'top_rated' },
  { id: 'tv-top', type: 'tv', title: '高分剧集', kind: 'browse', category: 'top_rated' },
];

async function trending(type, page = 1) {
  if (type === 'anime') {
    const data = await tmdbGet('/discover/tv', animeParams({ page, sort_by: 'popularity.desc' }));
    return (data.results || []).map((r) => toCard(r, 'tv'));
  }
  const data = await tmdbGet(`/trending/${type}/week`, { page, language: 'zh-CN' });
  return (data.results || []).map((r) => toCard(r, type));
}

/**
 * 首页影视墙：并发取回全部区块，单个区块失败不影响其他区块。
 * 但缺 Key 时直接报错，因为此时没有任何区块能成功，前端应该引导用户去配置。
 */
export async function getHome() {
  requireKey();
  const blocks = await Promise.all(
    HOME_BLOCKS.map(async (def) => {
      try {
        let items;
        if (def.kind === 'trending') {
          items = await trending(def.type, 1);
        } else if (def.type === 'anime') {
          const data = await tmdbGet('/discover/tv', animeParams({ page: 1, sort_by: 'vote_average.desc', 'vote_count.gte': 200 }));
          items = (data.results || []).map((r) => toCard(r, 'tv'));
        } else {
          const apiPath = BROWSE_PATHS[def.type][def.category];
          const data = await tmdbGet(apiPath, { page: 1, language: 'zh-CN' });
          items = (data.results || []).map((r) => toCard(r, def.type));
        }
        return { id: def.id, type: def.type, title: def.title, items: items.slice(0, 20) };
      } catch (err) {
        log.warn(`[tmdb] 影视墙区块 ${def.id} 获取失败: ${err.message}`);
        return { id: def.id, type: def.type, title: def.title, items: [], error: err.message };
      }
    }),
  );
  return { blocks };
}

export async function browse({ type, category, page }) {
  const p = Math.max(1, Math.min(500, Number.parseInt(page, 10) || 1));
  if (type === 'anime') {
    const sort = category === 'top_rated' ? 'vote_average.desc' : 'popularity.desc';
    const extra = category === 'top_rated' ? { 'vote_count.gte': 200 } : {};
    const data = await tmdbGet('/discover/tv', animeParams({ page: p, sort_by: sort, ...extra }));
    return { items: (data.results || []).map((r) => toCard(r, 'tv')), page: data.page || p, totalPages: Math.min(data.total_pages || 1, 500) };
  }
  const table = BROWSE_PATHS[type] || BROWSE_PATHS.movie;
  const apiPath = table[category] || table.popular;
  const data = await tmdbGet(apiPath, { page: p, language: 'zh-CN' });
  return { items: (data.results || []).map((r) => toCard(r, type)), page: data.page || p, totalPages: Math.min(data.total_pages || 1, 500) };
}

export async function search({ q, type, page }) {
  const p = Math.max(1, Math.min(500, Number.parseInt(page, 10) || 1));
  const query = String(q || '').trim();
  if (!query) return { items: [], page: 1, totalPages: 1 };

  if (type === 'anime') {
    const data = await tmdbGet('/search/tv', animeParams({ query, page: p }));
    return { items: (data.results || []).map((r) => toCard(r, 'tv')), page: data.page || p, totalPages: Math.min(data.total_pages || 1, 500) };
  }
  if (type === 'movie' || type === 'tv') {
    const data = await tmdbGet(`/search/${type}`, { query, page: p, language: 'zh-CN' });
    return { items: (data.results || []).map((r) => toCard(r, type)), page: data.page || p, totalPages: Math.min(data.total_pages || 1, 500) };
  }
  const data = await tmdbGet('/search/multi', { query, page: p, language: 'zh-CN' });
  const items = (data.results || [])
    .filter((r) => r.media_type === 'movie' || r.media_type === 'tv')
    .map((r) => toCard(r, r.media_type));
  return { items, page: data.page || p, totalPages: Math.min(data.total_pages || 1, 500) };
}

export async function detail({ type, id }) {
  const mediaType = type === 'tv' || type === 'anime' ? 'tv' : 'movie';
  // 剧照与预告片要单独取：append_to_response 里的 images/videos 会被 language=zh-CN 过滤掉，
  // 中文剧照与中文预告片本来就没有，结果就是一片空白。
  const [raw, images, videos] = await Promise.all([
    tmdbGet(`/${mediaType}/${id}`, {
      language: 'zh-CN',
      append_to_response: 'external_ids,credits,recommendations,similar',
    }),
    tmdbGet(`/${mediaType}/${id}/images`, { include_image_language: 'null,zh,en' }).catch(() => ({})),
    tmdbGet(`/${mediaType}/${id}/videos`, { language: 'zh-CN' }).catch(() => ({})),
  ]);

  const base = {
    id: num(raw.id),
    type: mediaType,
    title: raw.title || raw.name || '',
    originalTitle: raw.original_title || raw.original_name || '',
    overview: raw.overview || '',
    tagline: raw.tagline || '',
    posterPath: raw.poster_path || '',
    backdropPath: raw.backdrop_path || '',
    releaseDate: raw.release_date || raw.first_air_date || '',
    year: yearOf(raw.release_date || raw.first_air_date),
    voteAverage: Math.round(num(raw.vote_average) * 10) / 10,
    voteCount: num(raw.vote_count),
    runtime: num(raw.runtime) || num((raw.episode_run_time || [])[0]),
    genres: (raw.genres || []).map((g) => g.name),
    status: raw.status || '',
    tmdbUrl: `https://www.themoviedb.org/${mediaType}/${raw.id}`,
    imdbId: raw.imdb_id || raw.external_ids?.imdb_id || '',
    seasons: [],
    numberOfEpisodes: 0,
    numberOfSeasons: 0,
    lastEpisode: null,
    episodeRuntime: raw.episode_run_time || [],
    taglineText: raw.tagline || '',
    cast: (raw.credits?.cast || []).slice(0, 12).map((c) => ({
      name: c.name || '',
      character: c.character || '',
      profilePath: c.profile_path || '',
    })),
    crew: (raw.credits?.crew || [])
      .filter((c) => ['Director', 'Writer', 'Screenplay', 'Original Music Composer'].includes(c.job))
      .slice(0, 6)
      .map((c) => ({ name: c.name || '', job: c.job || '' })),
    // 剧照墙优先用 backdrop（横图更整齐），不足时补 still
    stills: [...(images.backdrops || []), ...(images.stills || [])]
      .slice(0, 12)
      .map((i) => i.file_path)
      .filter(Boolean),
    trailerKey: pickTrailer(videos.results) || '',
    related: (() => {
      const seen = new Set();
      const list = [];
      for (const item of [...(raw.recommendations?.results || []), ...(raw.similar?.results || [])]) {
        if (!item || !item.id || seen.has(item.id)) continue;
        seen.add(item.id);
        list.push(toCard(item, mediaType));
        if (list.length >= 12) break;
      }
      return list;
    })(),
  };

  if (!base.trailerKey) {
    try {
      const en = await tmdbGet(`/${mediaType}/${id}/videos`, { language: 'en-US' });
      base.trailerKey = pickTrailer(en.results) || '';
    } catch {
      base.trailerKey = '';
    }
  }

  if (mediaType === 'tv') {
    const seasons = (raw.seasons || [])
      .filter((s) => num(s.season_number) > 0)
      .map((s) => ({
        seasonNumber: num(s.season_number),
        name: s.name || `第 ${s.season_number} 季`,
        episodeCount: num(s.episode_count),
        airDate: s.air_date || '',
        posterPath: s.poster_path || '',
      }));
    base.seasons = seasons;
    base.numberOfEpisodes = num(raw.number_of_episodes);
    base.numberOfSeasons = num(raw.number_of_seasons);
    const le = raw.last_episode_to_air;
    if (le) {
      base.lastEpisode = {
        season: num(le.season_number),
        episode: num(le.episode_number),
        airDate: le.air_date || '',
      };
    }
  }
  return base;
}

export async function season({ id, season }) {
  const sn = Math.max(0, Number.parseInt(season, 10) || 1);
  const raw = await tmdbGet(`/tv/${id}/season/${sn}`, { language: 'zh-CN' });
  return {
    seasonNumber: num(raw.season_number, sn),
    name: raw.name || `第 ${sn} 季`,
    airDate: raw.air_date || '',
    episodes: (raw.episodes || []).map((e) => ({
      episodeNumber: num(e.episode_number),
      name: e.name || '',
      airDate: e.air_date || '',
      stillPath: e.still_path || '',
      overview: e.overview || '',
      runtime: num(e.runtime),
    })),
  };
}

/* --------------------------------------------------------------- 图片代理 */

const PLACEHOLDER = `<svg xmlns="http://www.w3.org/2000/svg" width="342" height="513" viewBox="0 0 342 513">
<rect width="342" height="513" fill="#16171c"/>
<g fill="#3a3d47"><rect x="121" y="216" width="100" height="74" rx="6"/><circle cx="171" cy="253" r="16" fill="#16171c"/></g>
<text x="171" y="330" font-family="system-ui,sans-serif" font-size="15" fill="#6a6f7d" text-anchor="middle">暂无海报</text>
</svg>`;

/* ------------------------------------------------------------ 筛选浏览 */

/** 排序键按媒体类型映射到 TMDB 的 sort_by。 */
const SORT_KEYS = {
  popularity: { movie: 'popularity.desc', tv: 'popularity.desc' },
  rating: { movie: 'vote_average.desc', tv: 'vote_average.desc' },
  newest: { movie: 'primary_release_date.desc', tv: 'first_air_date.desc' },
  oldest: { movie: 'primary_release_date.asc', tv: 'first_air_date.asc' },
  revenue: { movie: 'revenue.desc', tv: 'popularity.desc' },
};

/** 常用语种，界面直接用中文名，不再多打一次 TMDB 接口。 */
export const LANGUAGES = [
  { code: 'zh', name: '中文' }, { code: 'en', name: '英语' }, { code: 'ja', name: '日语' },
  { code: 'ko', name: '韩语' }, { code: 'fr', name: '法语' }, { code: 'de', name: '德语' },
  { code: 'es', name: '西班牙语' }, { code: 'it', name: '意大利语' }, { code: 'pt', name: '葡萄牙语' },
  { code: 'ru', name: '俄语' }, { code: 'hi', name: '印地语' }, { code: 'th', name: '泰语' },
  { code: 'tr', name: '土耳其语' }, { code: 'sv', name: '瑞典语' }, { code: 'da', name: '丹麦语' },
  { code: 'nl', name: '荷兰语' }, { code: 'pl', name: '波兰语' }, { code: 'ar', name: '阿拉伯语' },
];

export function languages() {
  return LANGUAGES;
}

/** 类型列表用于筛选栏，走 TMDB 官方分类，名字跟着界面语言走。 */
export async function genres(type) {
  const mediaType = type === 'tv' || type === 'anime' ? 'tv' : 'movie';
  const data = await tmdbGet(`/genre/${mediaType}/list`, { language: 'zh-CN' });
  return (data.genres || []).map((g) => ({ id: num(g.id), name: g.name || '' }));
}

/**
 * 带筛选条件的浏览。类型、风格、语种、年份区间、评分下限、排序都映射到 TMDB discover。
 * 动漫等同剧集加动画类型；用户显式选了语种或风格时以用户为准。
 */
export async function discover({
  type = 'movie', genre, language, yearFrom, yearTo, minRating, sort, page = 1, keyword,
}) {
  const anime = type === 'anime';
  const mediaType = type === 'tv' || anime ? 'tv' : 'movie';
  const sortKey = SORT_KEYS[sort] ? SORT_KEYS[sort][mediaType] : SORT_KEYS.popularity[mediaType];

  const params = {
    page: Math.max(1, Math.min(500, num(page) || 1)),
    sort_by: sortKey,
    language: 'zh-CN',
    include_adult: 'false',
  };

  const genreId = num(genre);
  if (anime && !genreId) params.with_genres = '16';
  else if (genreId) params.with_genres = String(genreId);
  if (anime && !language) params.with_original_language = 'ja';
  if (language) params.with_original_language = String(language).slice(0, 2);
  if (num(minRating) > 0) {
    params['vote_average.gte'] = String(num(minRating));
    params['vote_count.gte'] = '50';
  }
  const from = num(yearFrom);
  const to = num(yearTo);
  if (from && to && from === to) {
    if (mediaType === 'movie') params.primary_release_year = String(from);
    else params.first_air_date_year = String(from);
  } else {
    if (from) {
      if (mediaType === 'movie') params['primary_release_date.gte'] = `${from}-01-01`;
      else params['first_air_date.gte'] = `${from}-01-01`;
    }
    if (to) {
      if (mediaType === 'movie') params['primary_release_date.lte'] = `${to}-12-31`;
      else params['first_air_date.lte'] = `${to}-12-31`;
    }
  }
  if (keyword) params.with_keywords = String(keyword).trim().replace(/\s+/g, '|').slice(0, 120);

  const data = await tmdbGet(`/discover/${mediaType}`, params);
  return {
    items: (data.results || []).map((r) => toCard(r, anime ? 'tv' : mediaType)),
    page: num(data.page, 1),
    totalPages: Math.min(num(data.total_pages, 1), 500),
  };
}

export function placeholderImage() {
  return { body: Buffer.from(PLACEHOLDER, 'utf8'), contentType: 'image/svg+xml; charset=utf-8' };
}

const inflight = new Map();

/**
 * 取回 TMDB 图片。同一路径的并发请求会合并。
 * @returns {Promise<{body: Buffer, contentType: string}>}
 */
export async function fetchImage(rawPath, rawSize) {
  const size = IMAGE_SIZES.has(rawSize) ? rawSize : 'w342';
  const safePath = String(rawPath || '').trim();
  if (!/^\/[A-Za-z0-9._\-\/]+$/.test(safePath)) return placeholderImage();

  const key = `${size}${safePath}`;
  const cacheFile = path.join(cacheDir(), `${crypto.createHash('sha1').update(key).digest('hex')}.img`);

  try {
    const st = fs.statSync(cacheFile);
    if (st.size > 0) {
      return { body: fs.readFileSync(cacheFile), contentType: guessImageType(cacheFile) };
    }
  } catch {
    // 未命中缓存
  }

  if (inflight.has(key)) return inflight.get(key);

  const task = (async () => {
    const { tmdbImageBase } = getSettings();
    // TMDB 图片地址约定为 <图片前缀>/<尺寸><文件路径>，例如
    // https://tmdb-image-prod.b-cdn.net/t/p + /w342 + /pB8.jpg
    const base = tmdbImageBase.replace(/\/+$/, '');
    const sized = `${base}/${size}${safePath.startsWith('/') ? safePath : `/${safePath}`}`;
    // 海报是批量加载，失败由前端按需重取，这里只重试一次，避免整墙变慢。
    const res = await httpFetch(sized, { timeoutMs: 20000, attempts: 2 });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error('空响应');
    const contentType = res.headers.get('content-type') || 'image/jpeg';
    try {
      fs.writeFileSync(cacheFile, buf);
    } catch (err) {
      log.warn(`[tmdb] 图片缓存写入失败: ${err.message}`);
    }
    return { body: buf, contentType };
  })()
    .catch((err) => {
      log.warn(`[tmdb] 图片 ${size}${safePath} 获取失败: ${err.message}`);
      return placeholderImage();
    })
    .finally(() => inflight.delete(key));

  inflight.set(key, task);
  return task;
}

function guessImageType(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(12);
    fs.readSync(fd, head, 0, 12, 0);
    fs.closeSync(fd);
    if (head[0] === 0x89 && head[1] === 0x50) return 'image/png';
    if (head[0] === 0x52 && head[1] === 0x49) return 'image/webp';
    if (head[0] === 0x47 && head[1] === 0x49) return 'image/gif';
  } catch {
    // 忽略
  }
  return 'image/jpeg';
}

/* ------------------------------------------------------------------- 自检 */

export async function tmdbStatus() {
  const settings = getSettings();
  const out = { tmdbKeySet: Boolean(settings.tmdbApiKey), tmdbOk: false, tmdbMessage: '', tmdbImageOk: false, tmdbImageMessage: '' };

  if (!out.tmdbKeySet) {
    out.tmdbMessage = '尚未填写 TMDB API Key';
    out.tmdbImageMessage = '尚未填写 TMDB API Key';
    return out;
  }
  try {
    const data = await tmdbGet('/configuration');
    const bases = (data.images && data.images.secure_base_url) || '';
    out.tmdbOk = true;
    out.tmdbMessage = `TMDB 连接正常${bases ? `（官方图片前缀 ${bases}）` : ''}`;
  } catch (err) {
    out.tmdbMessage = err.message;
  }
  try {
    const probe = await fetchImage('/pB8BM7pdSp6B6Ih7QZ4DrQ3PmJK.jpg', 'w92');
    const isPlaceholder = String(probe.contentType).includes('svg');
    out.tmdbImageOk = !isPlaceholder;
    out.tmdbImageMessage = isPlaceholder ? '海报源不可达，请检查「TMDB 图片地址」设置' : '海报源连接正常';
  } catch (err) {
    out.tmdbImageMessage = err.message;
  }
  return out;
}
