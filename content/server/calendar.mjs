/**
 * 更新日历。
 *
 * 把订阅里的剧集按 TMDB 的播出日期摊到日历上，标出已下载与漏看的集数。
 * 每部剧每季的数据在内存里缓存 6 小时，避免翻月时反复打 TMDB。
 */
import * as tmdb from './tmdb.mjs';
import { listSubscriptions } from './subscriptions.mjs';
import { log } from './log.mjs';

const CACHE_TTL_MS = 6 * 3600 * 1000;
const seasonCache = new Map();

function epKey(season, episode) {
  return `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
}

async function seasonEpisodes(tmdbId, seasonNumber) {
  const key = `${tmdbId}:${seasonNumber}`;
  const hit = seasonCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.episodes;
  try {
    const data = await tmdb.season({ id: tmdbId, season: seasonNumber });
    const episodes = (data && data.episodes) || [];
    seasonCache.set(key, { at: Date.now(), episodes });
    return episodes;
  } catch (err) {
    log.warn(`[calendar] 第 ${seasonNumber} 季信息获取失败：${err.message}`);
    seasonCache.set(key, { at: Date.now(), episodes: [] });
    return [];
  }
}

const detailCache = new Map();

/** 按订阅里的季号取；没选季的（海报上点订阅 = 追全部季）回落到 TMDB 的季信息。 */
async function seasonsFor(sub, monthKey) {
  if (Array.isArray(sub.seasons) && sub.seasons.length) return sub.seasons;
  const cacheKey = `detail:${sub.tmdbId}`;
  const hit = detailCache.get(cacheKey);
  let detail = hit && Date.now() - hit.at < CACHE_TTL_MS ? hit.value : null;
  if (!detail) {
    try {
      detail = await tmdb.detail({ type: 'tv', id: sub.tmdbId });
      detailCache.set(cacheKey, { at: Date.now(), value: detail });
    } catch (err) {
      log.warn(`[calendar] ${sub.title || sub.tmdbId} 季信息获取失败：${err.message}`);
      detailCache.set(cacheKey, { at: Date.now(), value: null });
      return [];
    }
  }
  const all = ((detail && detail.seasons) || []).filter((season) => Number(season.seasonNumber) > 0);
  // 当月以前开播的最后两季就够覆盖「这个月更新什么」，避免把整部剧的季全拉一遍
  const started = all.filter((season) => !season.airDate || String(season.airDate) <= monthKey + '-31');
  const picked = started.length ? started : all;
  return picked.slice(-2).map((season) => Number(season.seasonNumber));
}

/**
 * 取某个月的更新：YYYY-MM。
 * @returns {{month: string, days: Array<{date: string, items: Array}>, total: number}}
 */
export async function month(monthKey) {
  const key = /^\d{4}-\d{2}$/.test(String(monthKey || '')) ? String(monthKey) : new Date().toISOString().slice(0, 7);
  const subs = (listSubscriptions().items || []).filter((item) => item.type !== 'movie' && item.enabled !== false);
  const days = new Map();

  for (const sub of subs) {
    const seasons = await seasonsFor(sub, key);
    const downloaded = new Set(sub.downloadedKeys || []);
    for (const seasonNumber of seasons) {
      const episodes = await seasonEpisodes(sub.tmdbId, seasonNumber);
      for (const episode of episodes) {
        const airDate = String(episode.airDate || '');
        if (!airDate.startsWith(key)) continue;
        const status = downloaded.has(epKey(seasonNumber, episode.episodeNumber)) ? 'downloaded' : 'missing';
        const entry = {
          subscriptionId: sub.id,
          tmdbId: sub.tmdbId,
          type: 'tv',
          title: sub.title,
          posterPath: sub.posterPath || '',
          season: seasonNumber,
          episode: episode.episodeNumber,
          episodeName: episode.name || '',
          airDate,
          status,
        };
        if (!days.has(airDate)) days.set(airDate, []);
        days.get(airDate).push(entry);
      }
    }
  }

  const ordered = [...days.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, items]) => ({ date, items }));
  return {
    month: key,
    days: ordered,
    total: ordered.reduce((sum, day) => sum + day.items.length, 0),
    missing: ordered.reduce((sum, day) => sum + day.items.filter((i) => i.status === 'missing').length, 0),
  };
}
