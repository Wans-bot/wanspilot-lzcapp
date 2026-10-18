/* WansPilot 前端入口。
 * 无构建步骤：浏览器把它当 ES 模块直接加载，接口契约见仓库根目录 API.md。
 */
import { LUCIDE_ICONS } from './vendor/lucide-icons.js';

const API_ROOT = '/api';

/* 官方网盘选择器把选中项放在 /files/home 下；桥接前缀取自 lzc-manifest.yml。 */
const BRIDGE_ROOT = '/__lazycat_file_bridge';
const HOME_PREFIXES = ['/_lzc/files/home/', '/files/home/', '/_lzc/home/'];

const ACTIVE_TASK_STATES = ['queued', 'fetching-metadata', 'downloading', 'seeding'];

/* 挑选可用值时的字段优先级：路径优先，name 只是最后兜底。 */
const PICKED_VALUE_KEYS = [
  'path', 'filename', 'webkitRelativePath', 'url', 'fileUrl', 'fullPath',
  'filePath', 'savePath', 'relativePath', 'name', 'fileName'
];

const QUALITY_OPTIONS = ['2160p', '1080p', '720p', '480p'];

const TYPE_LABELS = { movie: '电影', tv: '剧集', anime: '动漫', multi: '全部' };

const TASK_STATES = {
  queued: { label: '排队中', kind: 'info' },
  'fetching-metadata': { label: '获取元数据', kind: 'info' },
  downloading: { label: '下载中', kind: 'info' },
  seeding: { label: '做种中', kind: 'ok' },
  paused: { label: '已暂停', kind: 'warn' },
  completed: { label: '已完成', kind: 'ok' },
  error: { label: '出错', kind: 'err' }
};

const SUB_STATES = {
  watching: { label: '跟踪中', kind: 'ok' },
  idle: { label: '无更新', kind: 'info' },
  paused: { label: '已暂停', kind: 'warn' },
  error: { label: '出错', kind: 'err' }
};

/* 浏览分类取 API.md 允许的取值。 */
const CATEGORIES = {
  movie: [['popular', '热门'], ['top_rated', '高分'], ['now_playing', '正在上映'], ['upcoming', '即将上映']],
  tv: [['popular', '热门'], ['top_rated', '高分'], ['airing_today', '今日播出'], ['on_the_air', '正在播出']],
  anime: [['popular', '热门'], ['top_rated', '高分'], ['on_the_air', '正在播出']]
};

const PAGE_TITLES = {
  home: '影视墙', search: '搜索', subscribe: '订阅', calendar: '更新日历',
  tasks: '下载任务', settings: '设置', detail: '影视详情', resources: '资源'
};

/* ---------- 图标（全部内联 SVG，不依赖任何外域资源） ---------- */

/* 图标统一来自内置的 Lucide 子集（ISC 许可，原文见 vendor/LICENSE-lucide.txt）。
 * 键名沿用原手写版本的命名，icon('search') 这类调用处都不用改。 */
const ICON = LUCIDE_ICONS;

const SVG_NS = 'http://www.w3.org/2000/svg';
const iconBodies = new Map();

/** 图标体只在第一次用到时解析成节点，之后克隆；图标素材来自仓库自带的 Lucide 子集。 */
function iconBodyNodes(name) {
  if (!iconBodies.has(name)) {
    let list = [];
    try {
      const doc = new DOMParser().parseFromString('<svg xmlns="' + SVG_NS + '">' + (ICON[name] || '') + '</svg>', 'image/svg+xml');
      list = Array.prototype.slice.call(doc.documentElement.childNodes)
        .map(function (node) { return document.importNode(node, true); });
    } catch {
      list = [];
    }
    iconBodies.set(name, list);
  }
  return iconBodies.get(name).map(function (node) { return node.cloneNode(true); });
}

function iconNode(name, cls) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'icon' + (cls ? ' ' + cls : ''));
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  iconBodyNodes(name).forEach(function (node) { svg.append(node); });
  return svg;
}

/* ---------- 工具函数 ---------- */

/** 建一个元素。props 认 class / text / dataset / attrs / on 以及其它属性；children 收节点或字符串。 */
function el(tag, props, children) {
  const node = document.createElement(tag);
  applyProps(node, props);
  return appendAll(node, children);
}

function applyProps(node, props) {
  if (!props) return node;
  Object.keys(props).forEach(function (key) {
    const value = props[key];
    if (value === undefined || value === null || value === false) return;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'dataset') {
      Object.keys(value).forEach(function (name) { node.dataset[name] = String(value[name]); });
    } else if (key === 'attrs') {
      Object.keys(value).forEach(function (name) { node.setAttribute(name, String(value[name])); });
    } else if (key === 'on') {
      Object.keys(value).forEach(function (name) { node.addEventListener(name, value[name]); });
    } else {
      node.setAttribute(key, value === true ? '' : String(value));
    }
  });
  return node;
}

function appendAll(node, children) {
  if (children === undefined || children === null || children === false) return node;
  (Array.isArray(children) ? children : [children]).forEach(function (child) {
    if (child === undefined || child === null || child === false) return;
    // 允许直接塞一层数组（例如 children.map(...)），省掉到处 flat
    if (Array.isArray(child)) { appendAll(node, child); return; }
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  });
  return node;
}

function frag(children) { return appendAll(document.createDocumentFragment(), children); }

/** 换掉节点的全部子节点，用在原来写 innerHTML 的地方。 */
function fill(node, children) { node.replaceChildren(); return appendAll(node, children); }

/** 图标 + 文字的按钮 / 链接，界面上大半按钮都是这个形状。 */
function buttonEl(props, iconName, label) {
  const node = el('button', Object.assign({ type: 'button' }, props));
  if (iconName) node.append(iconNode(iconName));
  if (label !== undefined && label !== null) node.append(el('span', { text: label }));
  return node;
}

function linkEl(props, iconName, label) {
  const node = el('a', props);
  if (iconName) node.append(iconNode(iconName));
  if (label !== undefined && label !== null) node.append(el('span', { text: label }));
  return node;
}

/** 一组属性：class 按条件拼，省掉一堆三元表达式。 */
function classNames() {
  return Array.prototype.slice.call(arguments).filter(Boolean).join(' ');
}

/* 页面上反复出现的几种容器 */
function pageEl(children) { return el('div', { class: 'page' }, children); }
/* 横向滑动条：鼠标移上去出现左右按钮，两端渐隐；
   按钮的可用状态按滚动位置更新，节点已被换掉时就把自己从登记表里摘掉。 */
const railUpdaters = new Set();

window.addEventListener('resize', function () {
  railUpdaters.forEach(function (update) { update(); });
});

function railEl(children) {
  const track = el('div', { class: 'rail' }, children);
  const prev = buttonEl({ class: 'rail__nav rail__nav--prev', 'aria-label': '向左翻' }, 'chevron-left');
  const next = buttonEl({ class: 'rail__nav rail__nav--next', 'aria-label': '向右翻' }, 'chevron-right');
  const wrap = el('div', { class: 'rail-wrap' }, [track, prev, next]);

  const update = function () {
    if (!wrap.isConnected) { railUpdaters.delete(update); return; }
    const max = track.scrollWidth - track.clientWidth;
    wrap.classList.toggle('is-start', track.scrollLeft <= 2);
    wrap.classList.toggle('is-end', track.scrollLeft >= max - 2);
  };
  const step = function (direction) {
    track.scrollBy({ left: direction * Math.max(240, track.clientWidth * 0.8), behavior: 'smooth' });
  };
  prev.addEventListener('click', function () { step(-1); });
  next.addEventListener('click', function () { step(1); });
  track.addEventListener('scroll', update, { passive: true });
  railUpdaters.add(update);
  requestAnimationFrame(update);
  // 图是懒加载的，图到了宽度才准，过一会儿再校准一次
  setTimeout(update, 800);
  return wrap;
}

function gridEl(children, extraClass) { return el('div', { class: classNames('grid', extraClass) }, children); }

/** 首页与详情页里的「区块」：标题 + 右侧「查看全部」+ 内容。 */
function blockEl(title, body, more) {
  return el('section', { class: 'block' }, [
    el('header', { class: 'block__head' }, [
      el('h2', { class: 'block__title', text: title }),
      more || null,
    ]),
    body,
  ]);
}

function blockMoreEl(href, label) {
  return el('a', { class: 'block__more', href: href, text: label });
}

/** 键值行，运行状况与设置的自检都用它。 */
function kvRowEl(key, value) {
  return el('div', { class: 'kv__row' }, [
    el('span', { class: 'kv__key', text: key }),
    el('span', { class: 'kv__value', text: value }),
  ]);
}

function $(selector, root) { return (root || document).querySelector(selector); }

function fmtBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
  return (value >= 100 || i === 0 ? value.toFixed(0) : value.toFixed(1)) + ' ' + units[i];
}

function fmtRate(bytesPerSecond) {
  const n = Number(bytesPerSecond);
  if (!Number.isFinite(n) || n <= 0) return '—';
  return fmtBytes(n) + '/s';
}

function fmtSeconds(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return '—';
  const hours = Math.floor(n / 3600);
  const minutes = Math.floor((n % 3600) / 60);
  const rest = Math.floor(n % 60);
  if (hours > 0) return hours + ' 小时 ' + minutes + ' 分';
  if (minutes > 0) return minutes + ' 分 ' + rest + ' 秒';
  return rest + ' 秒';
}

/* 片长/集长用分钟展示：139 -> 2 小时 19 分，50 -> 50 分钟。 */
function fmtMinutes(minutes) {
  const n = Number(minutes);
  if (!Number.isFinite(n) || n <= 0) return '—';
  const hours = Math.floor(n / 60);
  const rest = Math.round(n % 60);
  return hours > 0 ? hours + ' 小时 ' + rest + ' 分' : rest + ' 分钟';
}

function fmtUptime(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return '—';
  const days = Math.floor(n / 86400);
  const hours = Math.floor((n % 86400) / 3600);
  const minutes = Math.floor((n % 3600) / 60);
  if (days > 0) return days + ' 天 ' + hours + ' 小时';
  if (hours > 0) return hours + ' 小时 ' + minutes + ' 分';
  return Math.max(1, minutes) + ' 分钟';
}

function pad2(value) { return String(value).padStart(2, '0'); }

function fmtDateTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate())
    + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes());
}

function fmtDate(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
}

/* 所有海报、剧照、背景图都经后端图片接口，前端不直连图片站点。 */
function imageUrl(path, size) {
  if (!path) return '';
  return API_ROOT + '/image?path=' + encodeURIComponent(path)
    + '&size=' + encodeURIComponent(size || 'w342');
}

function posterEl(path, alt, size) {
  const url = imageUrl(path, size || 'w342');
  if (!url) return el('span', { class: 'poster__empty', text: '暂无海报' });
  return el('img', {
    src: url, alt: alt, loading: 'lazy', decoding: 'async', width: '342', height: '513',
  });
}

function backdropEl(path, alt) {
  const url = imageUrl(path, 'w780');
  if (!url) return null;
  return el('img', { src: url, alt: alt, decoding: 'async' });
}

function typeLabel(type) { return TYPE_LABELS[type] || '影视'; }

/* ---------- 内存缓存 ---------- */

/* 切页不再重新打接口：同一份数据在 5 分钟内直接用内存里的结果，
   影视墙与搜索结果因此回到页面时立刻出图，不再闪一遍骨架屏。 */
const VIEW_CACHE_MS = 30 * 60 * 1000;
const viewCache = new Map();

function cachedPayload(path, ttlMs) {
  const hit = viewCache.get(path);
  const ttl = ttlMs === undefined ? VIEW_CACHE_MS : ttlMs;
  if (!hit || (ttl > 0 && Date.now() - hit.at >= ttl)) return null;
  return hit.payload;
}

async function cachedApi(path, ttlMs) {
  const hit = cachedPayload(path, ttlMs);
  if (hit) return hit;
  const payload = await api(path);
  viewCache.set(path, { at: Date.now(), payload: payload });
  return payload;
}

/* 订阅状态：影视墙、搜索与详情页都要知道哪些作品已订阅，统一放在这里，
   卡片上的收藏图标才能一次渲染成实心或空心。 */
const SUB_CACHE_MS = 30 * 1000;
const subState = { items: [], at: 0, pending: null, pendingAt: 0 };

function normalizeType(type) { return type === 'movie' ? 'movie' : 'tv'; }

function subscribedFor(type, id) {
  const want = normalizeType(type);
  return subState.items.filter(function (item) {
    return String(item.tmdbId) === String(id) && normalizeType(item.type) === want;
  })[0] || null;
}

async function loadSubscriptionsCached(force) {
  const fresh = subState.at > 0 && Date.now() - subState.at < SUB_CACHE_MS;
  if (!force && fresh) return subState.items;
  const inFlightFresh = subState.pending && Date.now() - subState.pendingAt < SUB_CACHE_MS;
  if (!force && inFlightFresh) return subState.pending;
  subState.pendingAt = Date.now();
  subState.pending = api('/subscriptions').then(function (data) {
    subState.items = (data && data.items) || [];
    subState.at = Date.now();
    subState.pending = null;
    return subState.items;
  }, function (error) {
    subState.pending = null;
    throw error;
  });
  return subState.pending;
}

function rememberSubscription(item) {
  if (!item) return;
  subState.items = subState.items.filter(function (entry) { return entry.id !== item.id; });
  subState.items.push(item);
  subState.at = Date.now();
}

/* 卡片上的按钮要拿完整条目才能订阅，渲染时顺手登记，点击时按 key 取回。 */
const cardIndex = new Map();

function cardKey(type, id) { return normalizeType(type) + ':' + id; }

/** 取消订阅：海报卡与详情页共用，先确认再删；返回是否真的删掉了。 */
/* 取消订阅只删订阅记录：已下载的文件与正在下载的任务都不动。
   直接生效，不再弹确认框（点实心收藏图标 = 取消，用户要求行为直白）。 */
async function removeSubscription(id, label) {
  if (!id) return false;
  try {
    await api('/subscriptions/' + encodeURIComponent(id), { method: 'DELETE' });
    subState.items = subState.items.filter(function (entry) { return entry.id !== id; });
    subState.at = Date.now();
    dropStash('subscribe');
    dropStash('calendar');
    toast('已取消订阅（已下载的文件与正在下载的任务都不动）', 'ok');
    return true;
  } catch (error) {
    toast(error.message, 'error');
    return false;
  }
}

/** 海报上点订阅：电影按设置里的默认条件直接订阅；剧集与动漫先弹窗选季，再按弹窗里的条件订阅。 */
async function cardSubscribe(button) {
  const item = cardIndex.get(button.getAttribute('data-key'));
  if (!item) return;
  // 剧集与动漫往往有多季（第一季、第二季…）：先取详情，弹窗里让用户选季，再按选中的季订阅
  if (normalizeType(item.type) === 'tv') {
    button.disabled = true;
    let detail = null;
    try {
      detail = await cachedApi('/tmdb/detail?type=tv&id=' + encodeURIComponent(item.tmdbId));
    } catch (error) {
      toast(error.message, 'error');
    }
    button.disabled = false;
    openSubscribeDialog(Object.assign({}, item, detail || {}), {
      onDone: function () { paintSubButton(button, item, true); },
    });
    return;
  }
  button.disabled = true;
  try {
    const result = await api('/subscriptions', {
      method: 'POST',
      body: {
        type: item.type,
        tmdbId: item.tmdbId,
        title: item.title,
        originalTitle: item.originalTitle,
        year: item.year,
        posterPath: item.posterPath,
        seasons: null,
      },
    });
    rememberSubscription(result && result.item);
    dropStash('subscribe');
    dropStash('calendar');
    paintSubButton(button, item, true);
    toast('已订阅「' + item.title + '」，季与清晰度可在订阅页调整', 'ok');
  } catch (error) {
    button.disabled = false;
    toast(error.message, 'error');
  }
}

/** 海报上点已订阅的实心图标：确认后取消订阅。 */
async function cardUnsubscribe(button) {
  const item = cardIndex.get(button.getAttribute('data-key'));
  const record = item ? subscribedFor(item.type, item.tmdbId) : null;
  if (!item || !record) return;
  const removed = await removeSubscription(record.id, item.title);
  if (!removed) return;
  paintSubButton(button, item, false);
}

/** 订阅状态变了就地把按钮改成另一种样子：不重排整张卡，也不重建 DOM 片段。 */
function paintSubButton(button, item, subscribed) {
  // 订阅请求期间按钮是禁用的，落定后要放开，否则这颗图标以后再点不动
  button.disabled = false;
  const acts = button.closest('.card__acts');
  if (acts) acts.classList.toggle('is-pinned', subscribed);
  button.classList.toggle('is-on', subscribed);
  button.setAttribute('data-action', subscribed ? 'card-unsubscribe' : 'card-subscribe');
  button.setAttribute('title', subscribed ? '已订阅，点击取消订阅' : '订阅');
  button.setAttribute('aria-label', (subscribed ? '取消订阅' : '订阅') + (item.title || ''));
  const svg = button.querySelector('svg');
  if (svg) svg.classList.toggle('icon--solid', subscribed);
}

/** 海报上的订阅按钮：已订阅是实心收藏，未订阅是空心收藏。 */
function subButtonEl(type, id, title, subscribed) {
  return el('button', {
    type: 'button',
    class: classNames('card__act', 'card__act--sub', subscribed && 'is-on'),
    'data-action': subscribed ? 'card-unsubscribe' : 'card-subscribe',
    'data-key': cardKey(type, id),
    title: subscribed ? '已订阅，点击取消订阅' : '订阅',
    'aria-label': (subscribed ? '取消订阅' : '订阅') + (title || ''),
  }, iconNode('bookmark', subscribed ? 'icon--solid' : ''));
}

/* ---------- 接口层 ---------- */

/* 请求都要有超时：没有超时的话，一次被网关丢掉响应的请求会让「在飞的 Promise」
   永远悬着（例如 subState.pending），详情页就会一直停在骨架屏、订阅也点不动。
   自检与资源搜索本来就要打外网，单独给更长预算。 */
const API_TIMEOUT_MS = 20000;
const API_SLOW_RULES = [
  { pattern: /^\/settings\//, ms: 60000 },
  { pattern: /^\/resources\b/, ms: 60000 },
  { pattern: /^\/health\/report\b/, ms: 60000 },
  { pattern: /^\/organizer\/run\b/, ms: 180000 }
];

function apiTimeoutMs(path, options) {
  const asked = Number((options || {}).timeoutMs);
  if (asked > 0) return asked;
  for (let i = 0; i < API_SLOW_RULES.length; i += 1) {
    if (API_SLOW_RULES[i].pattern.test(path)) return API_SLOW_RULES[i].ms;
  }
  return API_TIMEOUT_MS;
}

function api(path, options) {
  const opts = options || {};
  const timeoutMs = apiTimeoutMs(path, opts);
  const init = {
    method: opts.method || 'GET',
    headers: { Accept: 'application/json' },
    credentials: 'same-origin'
  };
  if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  if (controller) init.signal = controller.signal;
  const timer = setTimeout(function () {
    if (controller) controller.abort();
  }, timeoutMs);
  const finish = function () { clearTimeout(timer); };
  return fetch(API_ROOT + path, init).then(function (response) {
    return response.text().then(function (text) {
      let data = null;
      if (text) {
        try { data = JSON.parse(text); } catch { data = text; }
      }
      if (!response.ok) {
        const message = (data && typeof data === 'object' && data.error)
          || (typeof data === 'string' && data.trim())
          || ('请求失败（HTTP ' + response.status + '）');
        const error = new Error(message);
        error.status = response.status;
        error.data = data;
        throw error;
      }
      return data;
    });
  }, function (_error) {
    if (controller && controller.signal.aborted) {
      throw new Error('请求超时（' + Math.round(timeoutMs / 1000) + ' 秒没等到后端回应），请重试');
    }
    throw new Error('无法连接后端服务，请确认应用已启动');
  }).then(function (value) { finish(); return value; }, function (error) { finish(); throw error; });
}

function apiText(path, options) {
  const opts = options || {};
  return fetch(API_ROOT + path, { method: opts.method || 'GET', credentials: 'same-origin' })
    .then(function (response) {
      return response.text().then(function (text) {
        if (!response.ok) throw new Error('请求失败（HTTP ' + response.status + '）');
        return text;
      });
    }, function () {
      throw new Error('无法连接后端服务，请确认应用已启动');
    });
}

/* ---------- 提示、空态与错误态 ---------- */

function toast(message, kind) {
  const host = $('#toasts');
  if (!host) return;
  const tone = kind || 'info';
  const mark = tone === 'error' ? 'alert' : tone === 'ok' ? 'check' : 'info';
  const node = el('div', { class: 'toast toast--' + tone, role: tone === 'error' ? 'alert' : 'status' }, [
    el('span', { class: 'toast__icon' }, iconNode(mark)),
    el('span', { class: 'toast__text', text: String(message || '') }),
  ]);
  host.append(node);
  const life = kind === 'error' ? 6500 : 3400;
  setTimeout(function () {
    node.classList.add('toast--out');
    setTimeout(function () { node.remove(); }, 320);
  }, life);
}

/** 数据还在读时的中性占位：别把「正在读」画成「请求失败」。 */
function loadingEl(message) {
  return el('p', { class: 'field__hint', text: message || '读取中…' });
}

function errorEl(message) {
  return el('div', { class: 'notice notice--err' }, [
    el('p', { class: 'notice__title' }, [iconNode('alert'), el('span', { text: '请求失败' })]),
    el('p', { class: 'notice__text', text: String(message || '未知错误') }),
    buttonEl({ class: 'btn btn--sm', 'data-action': 'retry' }, null, '重试'),
  ]);
}

function emptyEl(text) {
  return el('div', { class: 'notice notice--muted' }, el('p', { class: 'notice__text', text: String(text) }));
}

function skeletonCardsEl(count) {
  const list = [];
  for (let i = 0; i < count; i += 1) {
    list.push(el('div', { class: 'card' }, [
      el('div', { class: 'card__poster sk' }),
      el('div', { class: 'sk sk-line' }),
      el('div', { class: 'sk sk-line sk-line--short' }),
    ]));
  }
  return frag(list);
}

function skeletonRowsEl(count) {
  const list = [];
  for (let i = 0; i < count; i += 1) list.push(el('div', { class: 'sk', style: 'height:86px' }));
  return frag(list);
}

/* ---------- 卡片 ---------- */

/* 资源页用片名与年份预填关键词，后端仍以 tmdbId 为准。 */
function resourceQuery(item, year) {
  const title = item.originalTitle || item.title || '';
  const params = new URLSearchParams();
  if (title) params.set('title', title);
  if (year) params.set('year', String(year));
  const text = params.toString();
  return text ? '?' + text : '';
}

/* 海报上的两个按钮：找资源与订阅。已订阅的作品收藏图标实心常显，
   没订阅的只显示海报，鼠标移上来（或键盘聚焦）才出现两个图标。 */
function mediaCardEl(item, options) {
  const opts = options || {};
  const rawType = item.type || opts.type || 'tv';
  const type = normalizeType(rawType);
  const title = item.title || item.originalTitle || '未命名';
  const year = item.year || (item.releaseDate ? String(item.releaseDate).slice(0, 4) : '');
  const vote = Number(item.voteAverage);
  const subtitle = [year, typeLabel(rawType)].filter(Boolean).join(' · ');
  const detailHref = '#/detail/' + type + '/' + item.id;
  cardIndex.set(cardKey(type, item.id), {
    type: type, tmdbId: item.id, title: title,
    originalTitle: item.originalTitle || '', year: year, posterPath: item.posterPath || '',
  });
  const subscribed = subscribedFor(type, item.id);
  const poster = el('div', { class: 'card__poster' }, [
    el('a', { class: 'card__poster-link', href: detailHref, 'aria-label': title }, [
      posterEl(item.posterPath, title + ' 海报', 'w342'),
      opts.showType ? el('span', { class: 'card__badge', text: typeLabel(rawType) }) : null,
      Number.isFinite(vote) && vote > 0
        ? el('span', { class: 'card__vote' }, [iconNode('star'), String(vote.toFixed(1))])
        : null,
    ]),
    el('div', { class: classNames('card__acts', subscribed && 'is-pinned') }, [
      el('a', {
        class: 'card__act card__act--find',
        href: '#/resources/' + type + '/' + item.id + resourceQuery(item, year),
        title: '找资源',
        'aria-label': '为' + title + '找资源',
      }, iconNode('search')),
      subButtonEl(type, item.id, title, subscribed),
    ]),
  ]);
  return el('article', { class: 'card' }, [
    poster,
    el('a', { class: 'card__link', href: detailHref }, [
      el('span', { class: 'card__title', text: title }),
      el('span', { class: 'card__sub', text: subtitle }),
    ]),
  ]);
}

function chipEl(text, kind) {
  return el('span', { class: classNames('chip', kind && 'chip--' + kind), text: String(text) });
}

/* ---------- 路由 ---------- */

function parseRoute() {
  const raw = String(location.hash || '').replace(/^#/, '');
  const parts = raw.split('?');
  const segments = String(parts[0] || '').split('/').filter(Boolean);
  return {
    name: segments[0] || 'home',
    segments: segments,
    params: new URLSearchParams(parts[1] || '')
  };
}

function navigate(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

function setActiveNav(name) {
  const items = document.querySelectorAll('[data-nav]');
  for (let i = 0; i < items.length; i += 1) {
    items[i].classList.toggle('is-active', items[i].getAttribute('data-nav') === name);
  }
}

let currentActions = {};

/* 视图是异步的：切页太快时，先发起的视图可能后写入 DOM，把新页面盖掉
   （表现为地址栏是任务页、画面却是设置页）。用自增令牌 + 写入门闩，
   只允许最近一次 render 发起的视图落地。 */
let renderToken = 0;

/* 过期视图不能再往页面里写东西：删除节点的方法与写入属性的入口一起挡掉。 */
const HOST_MUTATORS = ['append', 'appendChild', 'insertBefore', 'prepend', 'replaceChildren',
  'removeChild', 'replaceWith', 'replaceChildren'];

function guardedHost(host, token) {
  const stale = function () { return token !== renderToken; };
  return new Proxy(host, {
    get: function (target, prop) {
      const value = target[prop];
      if (typeof value !== 'function') return value;
      if (HOST_MUTATORS.indexOf(prop) >= 0) {
        return function () {
          if (stale()) return null;
          return value.apply(target, arguments);
        };
      }
      return value.bind(target);
    },
    set: function (target, prop, value) {
      if ((prop === 'innerHTML' || prop === 'textContent') && stale()) return true;
      return Reflect.set(target, prop, value);
    }
  });
}

/* 上一次渲染好的页面连同它的处理函数、滚动位置一起留着。
   回到同一页时直接把 DOM 贴回去：不重打接口、不重建节点、图片也不用再解一遍，
   所以来回切页不再有「进去就重新缓存/重新闪一下」的感觉。 */
const viewStash = new Map();
let displayedSignature = '';
let displayedActions = null;

function routeSignature(route) {
  if (route.name === 'search') return 'search:' + String(location.hash || '');
  if (route.name === 'detail') {
    return 'detail:' + (route.segments[1] || '') + '/' + (route.segments[2] || '');
  }
  if (route.name === 'calendar') return 'calendar:' + (calendarMonth || '');
  return route.name;
}

/** 哪些页面适合留着：数据型页面留着；任务页有实时推送、设置页要现场自检，都现渲染。 */
const STASHABLE = new Set(['home', 'search', 'detail', 'subscribe', 'calendar']);

function stashDisplayed(host) {
  const node = host.firstElementChild;
  if (!node || !displayedSignature) return;
  // 还在骨架屏（数据没到位）时不留：留着会把加载态还原回去
  if (node.querySelector('.sk')) return;
  viewStash.set(displayedSignature, {
    at: Date.now(),
    node: node,
    actions: displayedActions || {},
    scrollY: window.scrollY,
  });
}

/** 数据变了就把相关页面作废，避免贴回旧内容。 */
function dropStash(prefix) {
  viewStash.forEach(function (value, key) {
    if (!prefix || key.indexOf(prefix) === 0) viewStash.delete(key);
  });
}

function render() {
  const route = parseRoute();
  const host = $('#view');
  if (!host) return;
  const signature = routeSignature(route);
  const keep = STASHABLE.has(route.name) && displayedSignature !== signature;
  if (keep) stashDisplayed(host);

  const token = ++renderToken;
  const ctxHost = guardedHost(host, token);
  currentActions = { retry: function () { render(); } };
  // 海报卡上的按钮出现在每个视图里，统一在这里注册；卡片索引按次渲染重建
  currentActions['card-subscribe'] = cardSubscribe;
  currentActions['card-unsubscribe'] = cardUnsubscribe;
  cardIndex.clear();
  setActiveNav(route.name);
  document.title = (PAGE_TITLES[route.name] || '影视墙') + ' · WansPilot';

  const stashed = STASHABLE.has(route.name) ? viewStash.get(signature) : null;
  if (stashed && Date.now() - stashed.at < VIEW_CACHE_MS) {
    host.replaceChildren(stashed.node);
    Object.assign(currentActions, stashed.actions);
    displayedSignature = signature;
    displayedActions = currentActions;
    window.scrollTo(0, stashed.scrollY || 0);
    return;
  }

  const view = VIEWS[route.name] || VIEWS.home;
  const fail = function (error) {
    if (token === renderToken) host.replaceChildren(pageEl(errorEl(error && error.message)));
  };
  try {
    Promise.resolve(view({ host: ctxHost, route: route })).catch(fail);
  } catch (error) {
    fail(error);
  }
  displayedSignature = signature;
  // 视图是异步的，处理函数要等它跑完才算齐；这里只记token，取的时候按当时的值
  const actionsAtRender = currentActions;
  Promise.resolve().then(function () {
    if (displayedSignature === signature) displayedActions = currentActions || actionsAtRender;
  });
  window.scrollTo(0, 0);
}

/* 没有 TMDB Key 时不要去打 TMDB 接口：那会在浏览器控制台留下 4xx 报错，
   而这属于正常的首次使用状态，不是故障。这里统一改成先渲染引导，再让用户去设置。 */
function tmdbReady() {
  return Boolean(appState.settings && appState.settings.tmdbApiKey);
}

function tmdbKeyMissingEl(withRetry) {
  return pageEl(el('div', { class: 'notice notice--warn' }, [
    el('p', { class: 'notice__title' }, [iconNode('alert'), el('span', { text: '还没有填写 TMDB API Key' })]),
    el('p', {
      class: 'notice__text',
      text: '影视墙、搜索与详情页的数据都来自 TMDB。'
        + '到 TMDB 账号设置里申请 API Key（v3 auth），填进「设置」页第一项即可。',
    }),
    el('div', { class: 'row row--wrap' }, [
      linkEl({ class: 'btn btn--primary', href: '#/settings?focus=key' }, null, '去填写 Key'),
      withRetry ? buttonEl({ class: 'btn', 'data-action': 'retry' }, null, '重试') : null,
    ]),
  ]));
}

/* ---------- 视图：影视墙 ---------- */

/** 影视墙的骨架，只在真的没有缓存数据时出现。 */
function homeSkeletonEl() {
  const one = function () {
    return blockEl('正在加载影视墙', railEl(skeletonCardsEl(7)));
  };
  return pageEl([one(), one()]);
}

function homeBlocksEl(data) {
  const blocks = data && Array.isArray(data.blocks) ? data.blocks : [];
  if (!blocks.length) {
    return pageEl(emptyEl('影视墙暂时没有内容。请先在设置里填写 TMDB API Key。'));
  }
  return pageEl(blocks.map(function (block) {
    const type = block.type === 'movie' ? 'movie' : (block.type === 'anime' ? 'anime' : 'tv');
    const category = String(block.id || '').indexOf('top') >= 0 ? 'top_rated' : 'popular';
    const items = Array.isArray(block.items) ? block.items : [];
    const body = items.length
      ? railEl(items.map(function (item) { return mediaCardEl(item, { type: type }); }))
      : emptyEl('这个区块暂时没有内容');
    return blockEl(block.title || '影视区块', body,
      blockMoreEl('#/search?type=' + encodeURIComponent(type)
        + '&category=' + encodeURIComponent(category), '查看全部'));
  }));
}

async function viewHome(ctx) {
  if (!tmdbReady()) {
    fill(ctx.host, tmdbKeyMissingEl(false));
    return;
  }
  // 数据和订阅状态都在内存里时直接出图，不再重打接口、不再闪骨架屏
  const cached = cachedPayload('/tmdb/home');
  const instant = Boolean(cached) && subState.at > 0;
  fill(ctx.host, instant ? homeBlocksEl(cached) : homeSkeletonEl());
  try {
    const [data] = await Promise.all([cachedApi('/tmdb/home'), loadSubscriptionsCached()]);
    if (!instant) fill(ctx.host, homeBlocksEl(data));
  } catch (error) {
    if (instant) toast(error.message, 'error');
    else fill(ctx.host, pageEl(errorEl(error.message)));
  }
}

/* ---------- 视图：搜索与浏览 ---------- */

const SORT_OPTIONS = [
  ['popularity', '热度'], ['rating', '评分'], ['newest', '最新'],
  ['oldest', '最早'], ['revenue', '票房'],
];

const RATING_OPTIONS = ['6', '7', '8', '9'];

const filterOptions = { genres: {}, languages: [] };

function searchHash(state) {
  const params = new URLSearchParams();
  if (state.q) params.set('q', state.q);
  params.set('type', state.type || 'multi');
  if (state.page && state.page > 1) params.set('page', String(state.page));
  if (state.genre) params.set('genre', String(state.genre));
  if (state.lang) params.set('lang', String(state.lang));
  if (state.years) params.set('years', String(state.years));
  if (state.rating) params.set('rating', String(state.rating));
  if (state.sort && state.sort !== 'popularity') params.set('sort', state.sort);
  return '#/search?' + params.toString();
}

function readFilters(params) {
  const years = String(params.get('years') || '');
  let yearFrom = '';
  let yearTo = '';
  if (years === '..1989') yearTo = '1989';
  else if (/^\d{4}-\d{4}$/.test(years)) {
    yearFrom = years.slice(0, 4);
    yearTo = years.slice(5);
  }
  return {
    genre: String(params.get('genre') || ''),
    lang: String(params.get('lang') || ''),
    years: years,
    yearFrom: yearFrom,
    yearTo: yearTo,
    rating: String(params.get('rating') || ''),
    sort: String(params.get('sort') || 'popularity'),
  };
}

function hasFilters(filters) {
  return Boolean(filters.genre || filters.lang || filters.years || filters.rating
    || (filters.sort && filters.sort !== 'popularity'));
}

const YEAR_RANGES = [
  { value: '', label: '不限' },
  { value: '2020-2029', label: '2020 年代' },
  { value: '2010-2019', label: '2010 年代' },
  { value: '2000-2009', label: '2000 年代' },
  { value: '1990-1999', label: '1990 年代' },
  { value: '..1989', label: '1989 以前' },
];

/** 风格与语种的候选值，按类型缓存，避免每次进搜索页都打接口。 */
async function loadFilterOptions(browseType) {
  const key = browseType === 'tv' ? 'tv' : 'movie';
  if (!filterOptions.genres[key]) {
    try {
      const data = await api('/tmdb/genres?type=' + key);
      filterOptions.genres[key] = data.genres || [];
    } catch {
      filterOptions.genres[key] = [];
    }
  }
  if (!filterOptions.languages.length) {
    try {
      const data = await api('/tmdb/languages');
      filterOptions.languages = data.languages || [];
    } catch {
      filterOptions.languages = [];
    }
  }
  return filterOptions.genres[key];
}

function frowEl(label, chips, extraClass) {
  return el('div', { class: classNames('frow', extraClass) }, [
    el('span', { class: 'frow__label', text: label || '' }),
    el('div', { class: 'frow__chips' }, chips),
  ]);
}

function filterRowEl(label, key, options, current) {
  const active = String(current || '');
  return frowEl(label, options.map(function (entry) {
    const value = String(entry.value);
    const on = value === active;
    return buttonEl({
      class: classNames('chip', on && 'chip--active'),
      'data-action': 'filter-set',
      'data-key': key,
      'data-value': value,
      'aria-pressed': on ? 'true' : 'false',
    }, null, String(entry.label));
  }));
}

/* 类型（电影 / 剧集 / 动漫）与风格、语种一样是筛选条件，所以并到同一组 chips 里，
   不再单独占一行。关键词搜索时多一个「全部」。 */
const TYPE_TABS = {
  browse: [['movie', '电影'], ['tv', '剧集'], ['anime', '动漫']],
  search: [['multi', '全部'], ['movie', '电影'], ['tv', '剧集'], ['anime', '动漫']],
};

function typeRowEl(state, searching) {
  const tabs = searching ? TYPE_TABS.search : TYPE_TABS.browse;
  return frowEl('类型', tabs.map(function (entry) {
    const on = entry[0] === state.type;
    return el('a', {
      class: classNames('chip', on && 'chip--accent'),
      href: searchHash(Object.assign({}, state, { type: entry[0], page: 1 })),
      'aria-current': on ? 'true' : null,
      text: entry[1],
    });
  }));
}

/** 筛选条件全部平铺成 chips：类型、风格、语种、年份、评分、排序，不用下拉。 */
function filterBarEl(state, genres, searching) {
  const genreOptions = [{ value: '', label: '全部' }].concat(
    genres.map(function (g) { return { value: String(g.id), label: g.name }; }),
  );
  const langOptions = [{ value: '', label: '全部' }].concat(
    filterOptions.languages.map(function (l) { return { value: l.code, label: l.name }; }),
  );
  const ratingOptions = [{ value: '', label: '不限' }].concat(
    RATING_OPTIONS.map(function (r) { return { value: r, label: r + ' 分以上' }; }),
  );
  const sortOptions = SORT_OPTIONS.map(function (entry) { return { value: entry[0], label: entry[1] }; });
  const box = el('div', { class: 'filters' }, typeRowEl(state, searching));
  // 关键词搜索只走 TMDB 的关键词接口，其余条件在这里筛不了，所以搜索模式下只留类型行
  if (searching) return box;
  box.append(
    filterRowEl('风格', 'genre', genreOptions, state.genre),
    filterRowEl('语种', 'lang', langOptions, state.lang),
    filterRowEl('年份', 'years', YEAR_RANGES, state.years),
    filterRowEl('评分', 'rating', ratingOptions, state.rating),
    filterRowEl('排序', 'sort', sortOptions, state.sort || 'popularity'),
  );
  if (hasFilters(state)) {
    box.append(frowEl('', [
      el('button', { type: 'button', class: 'chip chip--ghost', 'data-action': 'filter-reset' }, [
        iconNode('close'),
        el('span', { text: '清除筛选' }),
      ]),
    ], 'frow--reset'));
  }
  return box;
}

async function viewSearch(ctx) {
  const params = ctx.route.params;
  const query = String(params.get('q') || '').trim();
  const searching = query.length > 0;
  let type = String(params.get('type') || '');
  if (!searching) type = type === 'movie' || type === 'tv' || type === 'anime' ? type : 'movie';
  else if (type !== 'movie' && type !== 'tv' && type !== 'anime') type = 'multi';
  const page = Math.max(1, parseInt(params.get('page') || '1', 10) || 1);
  const browseType = type === 'multi' ? 'movie' : type;
  // 关键词搜索不做本地过滤，带过来的筛选参数直接忽略，避免地址栏里留着不起作用的条件
  const filters = searching ? readFilters(new URLSearchParams()) : readFilters(params);
  const state = Object.assign({ q: query, type: type, page: page }, filters);

  // 先出筛选区与骨架卡片，避免搜索时空白一片；类型行与其它筛选条件同处一组
  // 搜索框放在页头右上角，下面整块地方留给筛选与结果
  const form = el('form', { class: 'toolbar toolbar--head', id: 'search-form', role: 'search' }, [
    el('input', {
      type: 'search', name: 'q', value: query,
      placeholder: '片名、原名或演员', autocomplete: 'off',
    }),
    buttonEl({ type: 'submit', class: 'btn btn--primary' }, 'search', '搜索'),
  ]);
  const filterHost = el('div', { class: 'filters', id: 'filter-host' }, typeRowEl(state, searching));
  const hint = el('div', { class: 'loading-hint', id: 'search-hint' }, [
    iconNode('loading', 'icon--spin'),
    el('span', { text: '正在加载…' }),
  ]);
  const results = el('div', { id: 'search-results' }, gridEl(skeletonCardsEl(12)));

  fill(ctx.host, pageEl([
    el('header', { class: 'page__head' }, [
      el('div', {}, [
        el('h1', { text: '搜索' }),
        el('p', {
          class: 'page__sub',
          text: searching
            ? '关键词搜索按片名、原名或演员匹配；想按风格、语种、年份、评分筛，清空关键词即可浏览。'
            : '按关键词找片，或用类型、风格、语种、年份、评分筛选；点海报上的搜索图标就能找资源。',
        }),
      ]),
      form,
    ]),
    filterHost,
    hint,
    results,
  ]));

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    const value = String(form.elements.q.value || '').trim();
    // 有关键词就是关键词搜索，不带筛选；清空关键词回到浏览模式，保留原来的筛选条件
    navigate(value
      ? searchHash({ q: value, type: type === 'multi' ? 'multi' : type })
      : searchHash(Object.assign({}, filters, { q: '', type: browseType })));
  });

  if (!tmdbReady()) {
    hint.remove();
    fill(results, tmdbKeyMissingEl(false));
    return;
  }

  const genres = await loadFilterOptions(browseType);
  fill(filterHost, filterBarEl(state, genres, searching));

  // 点一下就是一次筛选：再点同一个值等于取消
  currentActions['filter-set'] = function (button) {
    const key = button.getAttribute('data-key');
    const value = button.getAttribute('data-value');
    const next = Object.assign({}, filters);
    next[key] = String(next[key] || '') === value ? '' : value;
    navigate(searchHash(Object.assign({ q: query, type: type }, next)));
  };
  currentActions['filter-reset'] = function () {
    navigate(searchHash({ q: query, type: type }));
  };
  const endpointFor = function (target) {
    return searching
      ? '/tmdb/search?q=' + encodeURIComponent(query) + '&type=' + encodeURIComponent(type) + '&page=' + target
      : '/tmdb/discover?type=' + encodeURIComponent(browseType)
        + '&genre=' + encodeURIComponent(filters.genre)
        + '&language=' + encodeURIComponent(filters.lang)
        + '&yearFrom=' + encodeURIComponent(filters.yearFrom)
        + '&yearTo=' + encodeURIComponent(filters.yearTo)
        + '&minRating=' + encodeURIComponent(filters.rating)
        + '&sort=' + encodeURIComponent(filters.sort)
        + '&page=' + target;
  };
  const endpoint = endpointFor(page);

  let data;
  try {
    // 订阅状态与结果一起就绪，卡片上的收藏图标才能一次画对；
    // 结果走内存缓存，回到上一次的筛选条件时直接出图。
    const subs = loadSubscriptionsCached().catch(function () { return null; });
    [data] = await Promise.all([cachedApi(endpoint), subs]);
  } catch (error) {
    hint.remove();
    fill(results, errorEl(error.message));
    return;
  }
  hint.remove();

  const items = data && Array.isArray(data.items) ? data.items : [];

  if (!items.length) {
    fill(results, emptyEl(searching
      ? '没有找到与「' + query + '」匹配的影视'
      : '这组筛选条件下暂时没有内容'));
    return;
  }

  const totalPages = Number(data.totalPages) || 1;
  const pageHref = function (target) {
    return searchHash(Object.assign({}, filters, { q: query, type: type, page: target }));
  };
  // 上一页 / 页码 / 下一页 整组靠右
  const pager = el('div', { class: 'row row--wrap pager' }, [
    page > 1 ? linkEl({ class: 'btn btn--sm', href: pageHref(page - 1) }, 'chevron-left', '上一页') : null,
    el('span', { class: 'pager__count', text: '第 ' + page + ' / ' + totalPages + ' 页' }),
    page < totalPages ? linkEl({ class: 'btn btn--sm', href: pageHref(page + 1) }, null, '下一页') : null,
  ]);

  const grid = gridEl(items.map(function (item) { return mediaCardEl(item, { showType: type === 'multi' }); }));
  fill(results, [grid, pager]);
  // 一页 20 条常常排不满最后一行，这里从下一页补几张，做到每行数量一致
  topUpLastRow(grid, items.length, page, totalPages, endpointFor, { showType: type === 'multi' });
}

/** 末行不满时，用下一页的头几张补满最后一行；补不齐就不动。 */
async function topUpLastRow(grid, shownCount, page, totalPages, endpointFor, cardOptions) {
  if (page >= totalPages || window.innerWidth < 700) return;
  await new Promise(function (resolve) { requestAnimationFrame(function () { resolve(); }); });
  const tops = new Map();
  Array.prototype.forEach.call(grid.children, function (card) {
    const top = Math.round(card.getBoundingClientRect().top);
    tops.set(top, (tops.get(top) || 0) + 1);
  });
  const columns = tops.size ? Math.max.apply(null, Array.from(tops.values())) : 0;
  if (columns < 2) return;
  const deficit = (columns - (shownCount % columns)) % columns;
  if (!deficit) return;
  try {
    const next = await cachedApi(endpointFor(page + 1));
    const extra = (next && Array.isArray(next.items) ? next.items : []).slice(0, deficit);
    if (extra.length < deficit) return;
    extra.forEach(function (item) { grid.append(mediaCardEl(item, cardOptions || {})); });
  } catch {
    // 补不满就保持原样，不影响已经显示的结果
  }
}

/* ---------- 视图：详情 ---------- */

async function viewDetail(ctx) {
  const type = ctx.route.segments[1] === 'movie' ? 'movie' : 'tv';
  const id = ctx.route.segments[2] || '';
  let detail = cachedPayload('/tmdb/detail?type=' + encodeURIComponent(type) + '&id=' + encodeURIComponent(id));
  const subsReady = subState.at > 0;
  if (!detail || !subsReady) {
    fill(ctx.host, pageEl(el('div', { class: 'hero' }, el('div', { class: 'hero__inner' }, [
      el('div', { class: 'hero__poster sk' }),
      el('div', { class: 'hero__info' }, [
        el('div', { class: 'sk sk-line', style: 'height:26px;width:60%' }),
        el('div', { class: 'sk sk-line', style: 'width:35%' }),
        el('div', { class: 'sk sk-line', style: 'width:80%' }),
        el('div', { class: 'sk sk-line', style: 'width:70%' }),
      ]),
    ]))));
  }

  if (!tmdbReady()) {
    fill(ctx.host, tmdbKeyMissingEl(false));
    return;
  }

  try {
    const loaded = await Promise.all([
      cachedApi('/tmdb/detail?type=' + encodeURIComponent(type) + '&id=' + encodeURIComponent(id)),
      loadSubscriptionsCached().catch(function () { return null; }),
    ]);
    detail = loaded[0];
  } catch (error) {
    fill(ctx.host, pageEl(errorEl(error.message)));
    return;
  }

  const isTv = type === 'tv';
  const title = detail.title || detail.originalTitle || '未命名';
  const year = detail.year || (detail.releaseDate ? String(detail.releaseDate).slice(0, 4) : '');
  const vote = Number(detail.voteAverage);
  const facts = [];
  if (year) facts.push(year);
  if (Number(detail.runtime) > 0) facts.push(fmtMinutes(detail.runtime));
  if (isTv && Number(detail.numberOfSeasons) > 0) facts.push(detail.numberOfSeasons + ' 季');
  if (isTv && Number(detail.numberOfEpisodes) > 0) facts.push(detail.numberOfEpisodes + ' 集');
  if (detail.status) facts.push(detail.status);

  const genres = (Array.isArray(detail.genres) ? detail.genres : []).map(function (genre) {
    return chipEl(genre);
  });

  const seasons = Array.isArray(detail.seasons) ? detail.seasons : [];
  const lastEpisode = detail.lastEpisode || null;

  const resourceQuery = '?title=' + encodeURIComponent(detail.originalTitle || title)
    + '&year=' + encodeURIComponent(year);

  const seasonsBlock = isTv
    ? blockEl('分季剧集', [
      seasons.length
        ? el('div', { class: 'seasons', id: 'season-picker' }, seasons.map(function (season) {
          return el('button', {
            type: 'button',
            class: 'season-chip',
            'data-action': 'season',
            'data-season': season.seasonNumber,
          }, [
            season.name || ('第 ' + season.seasonNumber + ' 季'),
            el('small', {
              text: (season.episodeCount || 0) + ' 集' + (season.airDate ? ' · ' + season.airDate : ''),
            }),
          ]);
        }))
        : emptyEl('没有获取到分季信息'),
      el('div', { id: 'season-panel' }),
    ])
    : null;

  const castBlock = Array.isArray(detail.cast) && detail.cast.length
    ? blockEl('演职员', el('div', { class: 'cast' }, detail.cast.map(function (person) {
      const avatar = el('div', { class: 'cast__avatar' });
      if (person.profilePath) {
        const img = el('img', {
          src: imageUrl(person.profilePath, 'w185'),
          alt: '', loading: 'lazy', decoding: 'async',
        });
        img.addEventListener('error', function () { avatar.classList.add('is-broken'); });
        avatar.append(img);
      } else {
        avatar.append(iconNode('users'));
      }
      return el('article', { class: 'cast__item' }, [
        avatar,
        el('p', { class: 'cast__name', text: person.name }),
        person.character ? el('p', { class: 'cast__role', text: person.character }) : null,
      ]);
    })), el('span', { class: 'block__hint', text: detail.cast.length + ' 位' }))
    : null;

  const stillsBlock = Array.isArray(detail.stills) && detail.stills.length
    ? blockEl('剧照', el('div', { class: 'stills' }, detail.stills.map(function (file, index) {
      const item = el('button', {
        type: 'button',
        class: 'stills__item',
        'data-action': 'still',
        'data-index': index,
        'data-src': imageUrl(file, 'w780'),
        'aria-label': '查看第 ' + (index + 1) + ' 张剧照',
      });
      const img = el('img', { src: imageUrl(file, 'w342'), alt: '', loading: 'lazy', decoding: 'async' });
      img.addEventListener('error', function () { item.classList.add('is-broken'); });
      item.append(img);
      return item;
    })))
    : null;

  const subscribed = subscribedFor(type, detail.id || id);

  const relatedBlock = Array.isArray(detail.related) && detail.related.length
    ? blockEl('相关推荐', railEl(detail.related.map(function (item) { return mediaCardEl(item); })),
      el('span', { class: 'block__hint', text: '按 TMDB 推荐与相似度' }))
    : null;

  const hero = el('article', { class: 'hero' }, [
    el('div', { class: 'hero__bg' }, backdropEl(detail.backdropPath, title + ' 背景图')),
    el('div', { class: 'hero__inner' }, [
      el('div', { class: 'hero__poster' }, [
        posterEl(detail.posterPath, title + ' 海报', 'w500'),
        Number.isFinite(vote) && vote > 0
          ? el('span', { class: 'hero__badge' }, [iconNode('star'), String(vote.toFixed(1))])
          : null,
      ]),
      el('div', { class: 'hero__info' }, [
        el('h1', { class: 'hero__title', text: title }),
        detail.originalTitle && detail.originalTitle !== title
          ? el('p', { class: 'hero__original', text: detail.originalTitle })
          : null,
        detail.tagline ? el('p', { class: 'hero__tagline', text: detail.tagline }) : null,
        el('div', { class: 'hero__facts' }, [
          chipEl(typeLabel(detail.type || type), 'accent'),
          Number.isFinite(vote) && vote > 0
            ? el('span', { class: 'chip' }, [
              iconNode('star'),
              String(vote.toFixed(1))
                + (Number(detail.voteCount) > 0 ? '（' + Number(detail.voteCount) + ' 票）' : ''),
            ])
            : null,
          facts.map(function (fact) { return chipEl(fact); }),
          genres,
          detail.imdbId ? el('span', { class: 'chip', text: detail.imdbId }) : null,
        ]),
        lastEpisode
          ? el('p', {
            class: 'field__hint',
            text: '最新一集：第 ' + lastEpisode.season + ' 季 第 ' + lastEpisode.episode + ' 集'
              + (lastEpisode.airDate ? '（' + lastEpisode.airDate + '）' : ''),
          })
          : null,
        el('p', { class: 'hero__overview', text: detail.overview || '暂无简介。' }),
        el('div', { class: 'hero__actions' }, [
          subscribed
            ? buttonEl({
              class: 'btn btn--danger',
              'data-action': 'unsubscribe',
              'data-id': subscribed.id,
            }, 'bookmark', '已订阅，取消订阅')
            : buttonEl({ class: 'btn btn--primary', 'data-action': 'subscribe' }, 'plus', '订阅'),
          linkEl({
            class: 'btn',
            href: '#/resources/' + type + '/' + (detail.id || id) + resourceQuery,
          }, 'search', '找资源'),
          detail.trailerKey
            ? linkEl({
              class: 'btn btn--ghost',
              href: 'https://www.youtube.com/watch?v=' + detail.trailerKey,
              target: '_blank',
              rel: 'noopener noreferrer',
            }, 'play', '预告片')
            : null,
          detail.tmdbUrl
            ? linkEl({
              class: 'btn btn--ghost',
              href: detail.tmdbUrl,
              target: '_blank',
              rel: 'noopener noreferrer',
            }, 'link', 'TMDB 页面')
            : null,
        ]),
      ]),
    ]),
  ]);

  fill(ctx.host, pageEl([
    el('div', { class: 'crumb' }, linkEl({ href: '#/search' }, 'back', '返回列表')),
    hero,
    stillsBlock,
    castBlock,
    relatedBlock,
    seasonsBlock,
  ]));

  currentActions.subscribe = async function () {
    openSubscribeDialog(detail);
  };
  currentActions.unsubscribe = async function (button) {
    await removeSubscription(button.getAttribute('data-id'), title);
    render();
  };
  currentActions.season = function (button) { loadSeason(detail, button.getAttribute('data-season')); };
  currentActions.still = function (button) {
    const src = button.getAttribute('data-src');
    if (!src) return;
    openModal({
      title: title + ' 剧照',
      size: 'lg',
      body: el('div', { class: 'lightbox' }, el('img', { src: src, alt: title + ' 剧照' })),
    });
  };
  if (seasons.length) {
    const preferred = seasons[seasons.length - 1];
    if (preferred) loadSeason(detail, String(preferred.seasonNumber));
  }
}

async function loadSeason(detail, seasonNumber) {
  const panel = $('#season-panel');
  if (!panel) return;
  const picker = $('#season-picker');
  if (picker) {
    const chips = picker.querySelectorAll('.season-chip');
    for (let i = 0; i < chips.length; i += 1) {
      chips[i].classList.toggle('is-active', chips[i].getAttribute('data-season') === String(seasonNumber));
    }
  }
  fill(panel, el('div', { class: 'episodes' }, skeletonRowsEl(3)));
  let data;
  try {
    data = await api('/tmdb/season?type=tv&id=' + encodeURIComponent(detail.id)
      + '&season=' + encodeURIComponent(seasonNumber));
  } catch (error) {
    fill(panel, errorEl(error.message));
    return;
  }
  const episodes = data && Array.isArray(data.episodes) ? data.episodes : [];
  if (!episodes.length) {
    fill(panel, emptyEl('这一季没有剧集信息'));
    return;
  }
  const resourceQuery = '?title=' + encodeURIComponent(detail.originalTitle || detail.title || '')
    + '&year=' + encodeURIComponent(detail.year || '');
  fill(panel, el('div', { class: 'episodes' }, episodes.map(function (episode) {
    const meta = [episode.airDate || '', Number(episode.runtime) > 0 ? fmtMinutes(episode.runtime) : '']
      .filter(Boolean).join(' · ');
    return el('article', { class: 'episode' }, [
      el('div', { class: 'episode__still' },
        posterEl(episode.stillPath, '第 ' + episode.episodeNumber + ' 集剧照', 'w185')),
      el('div', { class: 'episode__body' }, [
        el('div', { class: 'episode__head' }, [
          el('span', { class: 'episode__no', text: '第 ' + episode.episodeNumber + ' 集' }),
          el('span', { class: 'episode__name', text: episode.name || '未命名' }),
        ]),
        el('p', { class: 'episode__meta', text: meta }),
        episode.overview ? el('p', { class: 'episode__text', text: episode.overview }) : null,
        el('div', {}, linkEl({
          class: 'btn btn--sm',
          href: '#/resources/tv/' + detail.id + resourceQuery
            + '&season=' + seasonNumber + '&episode=' + episode.episodeNumber,
        }, 'search', '找资源')),
      ]),
    ]);
  })));
}
/* ---------- 视图：运行状况 ---------- */

async function viewHealth(ctx) {
  fill(ctx.host, pageEl([
    el('header', { class: 'page__head' }, el('div', {}, [
      el('h1', { text: '运行状况' }),
      el('p', { class: 'page__sub', text: 'TMDB、索引源、磁盘、任务与 AI 一页看全。' }),
    ])),
    gridEl(skeletonCardsEl(6), 'grid--cards'),
  ]));

  let report;
  try {
    report = await api('/health/report');
  } catch (error) {
    fill(ctx.host, pageEl(errorEl(error.message)));
    return;
  }

  function card(title, rows, tone) {
    return el('article', { class: classNames('panel', tone && 'panel--' + tone) }, [
      el('h2', { class: 'panel__title', text: title }),
      rows.map(function (row) { return kvRowEl(row[0], row[1]); }),
    ]);
  }

  const tmdb = report.tmdb || {};
  const cap = report.capacity || {};
  const tasks = report.tasks || {};

  const panels = [
    card('TMDB', [
      ['状态', tmdb.ok ? '连通' : (tmdb.message || '未配置')],
      ['接口', getSettingsCached() && getSettingsCached().tmdbApiBase ? String(getSettingsCached().tmdbApiBase).replace(/^https?:\/\//, '') : '—'],
    ], tmdb.ok ? 'ok' : 'warn'),
    card('索引源', (report.sources || []).map(function (source) {
      return [source.name, source.ok ? '可用 · ' + source.latencyMs + ' ms' : '不可用 · ' + (source.message || '')];
    }).concat([['代理', (getSettingsCached() && getSettingsCached().proxy) ? '已配置' : '未配置']]), (report.sources || []).every(function (s) { return s.ok; }) ? 'ok' : 'warn'),
    card('磁盘', [
      ['剩余', fmtBytes(cap.freeBytes || 0)],
      ['配额上限', cap.quotaGB ? cap.quotaGB + ' GB' : '不限'],
      ['下载目录', cap.downloadDir || ''],
    ]),
    card('任务', [
      ['进行中', String(tasks.active || 0)],
      ['下载速率', fmtRate(tasks.rateDown || 0)],
      ['累计大小', fmtBytes(tasks.totalSizeBytes || 0)],
    ]),
  ];

  fill(ctx.host, pageEl([
    el('div', { class: 'crumb' }, linkEl({ href: '#/settings' }, 'back', '返回设置')),
    el('header', { class: 'page__head' }, [
      el('div', {}, [
        el('h1', { text: '运行状况' }),
        el('p', {
          class: 'page__sub',
          text: '采集时间 ' + String(report.at || '').replace('T', ' ').slice(0, 19),
        }),
      ]),
      buttonEl({ class: 'btn', 'data-action': 'health-refresh' }, 'refresh', '重新采集'),
    ]),
    gridEl(panels, 'grid--cards'),
  ]));

  currentActions['health-refresh'] = function () { render(); };
}

let settingsCache = null;
function getSettingsCached() {
  return settingsCache || appState.settings || null;
}

/* ---------- 视图：资源搜索 ---------- */

/* 资源列表的排序与筛选：都在前端对已取回的结果做，不再打接口。 */
const resFilters = { sort: '', res: '', size: '', seeders: '', trust: '' };

const RES_SORTS = [
  ['', '推荐'], ['seeders', '做种最多'], ['leechers', '下载最多'],
  ['size', '体积最大'], ['resolution', '清晰度最高'], ['trust', '可信度最高'],
];
const RES_RESOLUTIONS = [['', '不限'], ['2160p', '2160p'], ['1080p', '1080p'], ['720p', '720p'], ['480p', '480p']];
const RES_SIZES = [
  ['', '不限'], ['lt2', '< 2 GB'], ['2to10', '2–10 GB'], ['10to30', '10–30 GB'], ['gt30', '> 30 GB'],
];
const RES_SEEDERS = [['', '不限'], ['5', '≥ 5'], ['20', '≥ 20'], ['100', '≥ 100']];
const RES_TRUST = [['', '不限'], ['55', '≥ 55'], ['70', '≥ 70'], ['85', '≥ 85']];

/** 可信度分档：四档各自一种颜色，不再出现「有的带色有的不带色」。 */
function trustBand(score) {
  const value = Number(score);
  if (!Number.isFinite(value)) return '';
  if (value >= 85) return 'ok';
  if (value >= 70) return 'info';
  if (value >= 55) return 'warn';
  return 'err';
}

function trustChipEl(item) {
  const band = trustBand(item.trust);
  return el('span', {
    class: classNames('chip', band && 'chip--' + band),
    title: '可信度按发布组、命名规范度、做种数与体积合理性合成，85 分以上很可信，55 分以下谨慎',
  }, [iconNode('shield'), '可信度 ' + item.trust + '（' + (item.trustLabel || '') + '）']);
}

/** 体积筛选：四档区间，未知体积（0）只在「不限」时保留。 */
function sizeInBucket(sizeBytes, bucket) {
  if (!bucket) return true;
  const bytes = Number(sizeBytes || 0);
  const GB = 1024 * 1024 * 1024;
  if (bucket === 'lt2') return bytes > 0 && bytes < 2 * GB;
  if (bucket === '2to10') return bytes >= 2 * GB && bytes <= 10 * GB;
  if (bucket === '10to30') return bytes > 10 * GB && bytes <= 30 * GB;
  if (bucket === 'gt30') return bytes > 30 * GB;
  return true;
}

function filteredResources() {
  const minSeeders = Number(resFilters.seeders) || 0;
  const minTrust = Number(resFilters.trust) || 0;
  const rows = resourceItems.map(function (item, index) { return { item: item, index: index }; })
    .filter(function (entry) {
      const item = entry.item;
      if (resFilters.res && item.resolution !== resFilters.res) return false;
      if (!sizeInBucket(item.sizeBytes, resFilters.size)) return false;
      if (minSeeders && Number(item.seeders || 0) < minSeeders) return false;
      if (minTrust && Number(item.trust || 0) < minTrust) return false;
      return true;
    });
  const sorters = {
    seeders: function (a, b) { return Number(b.item.seeders || 0) - Number(a.item.seeders || 0); },
    leechers: function (a, b) { return Number(b.item.leechers || 0) - Number(a.item.leechers || 0); },
    size: function (a, b) { return Number(b.item.sizeBytes || 0) - Number(a.item.sizeBytes || 0); },
    resolution: function (a, b) { return Number(b.item.resolutionRank || 0) - Number(a.item.resolutionRank || 0); },
    trust: function (a, b) { return Number(b.item.trust || 0) - Number(a.item.trust || 0); },
  };
  const sorter = sorters[resFilters.sort];
  return sorter ? rows.slice().sort(sorter) : rows;
}

/** 排序与筛选两组 chips；选中值再点一次等于取消。 */
function resourceFilterBarEl(state, shownCount) {
  const row = function (label, key, options, current) {
    return frowEl(label, options.map(function (entry) {
      const value = String(entry[0]);
      const on = String(current || '') === value;
      return buttonEl({
        class: classNames('chip', on && 'chip--active'),
        'data-action': 'res-set',
        'data-key': key,
        'data-value': value,
        'aria-pressed': on ? 'true' : 'false',
      }, null, entry[1]);
    }));
  };
  return [
    row('排序', 'sort', RES_SORTS, state.sort),
    row('清晰度', 'res', RES_RESOLUTIONS, state.res),
    row('体积', 'size', RES_SIZES, state.size),
    row('做种', 'seeders', RES_SEEDERS, state.seeders),
    row('可信度', 'trust', RES_TRUST, state.trust),
    el('div', { class: 'frow frow--note' }, el('span', {
      class: 'field__hint',
      text: shownCount === undefined ? '按上面的条件在已取回的结果里排序与筛选' : '符合条件 ' + shownCount + ' 条',
    })),
  ];
}

/** 一条资源：标题 + 标签（含四档可信度）+ 元信息 + 加入下载。 */
function resourceRowEl(item, index) {
  const tags = [];
  if (item.resolution) tags.push(el('span', { class: 'tag tag--accent', text: item.resolution }));
  if (item.codec) tags.push(el('span', { class: 'tag', text: item.codec }));
  if (item.sourceTag) tags.push(el('span', { class: 'tag', text: item.sourceTag }));
  if (item.isSeasonPack) tags.push(el('span', { class: 'tag tag--accent', text: '整季合集' }));
  if (!item.isSeasonPack && item.season && item.episode) {
    tags.push(el('span', { class: 'tag', text: 'S' + pad2(item.season) + 'E' + pad2(item.episode) }));
  }
  if (Number.isFinite(item.trust)) tags.push(trustChipEl(item));
  const meta = [
    el('span', {}, ['大小 ', el('strong', { text: item.sizeBytes ? fmtBytes(item.sizeBytes) : '未知' })]),
    el('span', {}, ['做种 ', el('strong', { text: String(item.seeders || 0) })]),
    el('span', {}, ['下载 ', el('strong', { text: String(item.leechers || 0) })]),
    el('span', { text: item.indexerName || item.indexer || '未知来源' }),
    el('span', { text: item.publishedAt ? fmtDate(item.publishedAt) : '发布时间未知' }),
  ];
  const disabled = !item.magnet && !item.infoHash;
  return el('article', { class: 'res' }, [
    el('div', { class: 'res__main' }, [
      el('h3', { class: 'res__title', text: item.title || '未命名资源' }),
      el('div', { class: 'res__tags' }, tags),
      el('div', { class: 'res__meta' }, meta),
    ]),
    buttonEl({
      class: 'btn btn--primary',
      disabled: disabled ? true : null,
      'data-action': 'add-resource',
      'data-index': index,
    }, 'plus', disabled ? '没有链接' : '加入下载'),
  ]);
}


let resourceItems = [];

async function viewResources(ctx) {
  const type = ctx.route.segments[1] === 'movie' ? 'movie' : 'tv';
  const id = ctx.route.segments[2] || '';
  const params = ctx.route.params;
  const title = String(params.get('title') || '');
  const keyword = params.has('q') ? String(params.get('q') || '') : title;
  const season = String(params.get('season') || '');
  const episode = String(params.get('episode') || '');
  const year = String(params.get('year') || '');

  const heading = (title || keyword || ('TMDB #' + id))
    + (season ? ' · 第 ' + season + ' 季' : '')
    + (episode ? ' 第 ' + episode + ' 集' : '');

  const form = el('form', { class: 'toolbar', id: 'resource-form' }, [
    el('label', { class: 'field field--grow' }, [
      el('span', { class: 'field__label', text: '关键词' }),
      el('input', {
        type: 'search', name: 'q', value: keyword,
        placeholder: '片名或发布组', autocomplete: 'off',
      }),
    ]),
    el('label', { class: 'field' }, [
      el('span', { class: 'field__label', text: '季' }),
      el('input', { type: 'number', name: 'season', min: '0', step: '1', value: season }),
    ]),
    el('label', { class: 'field' }, [
      el('span', { class: 'field__label', text: '集' }),
      el('input', { type: 'number', name: 'episode', min: '0', step: '1', value: episode }),
    ]),
    buttonEl({ type: 'submit', class: 'btn btn--primary' }, 'search', '搜索资源'),
  ]);
  const sourceHost = el('div', { class: 'sources', id: 'resource-sources' });
  const filterHost = el('div', { class: 'filters', id: 'resource-filters' },
    resourceFilterBarEl(resFilters));
  const list = el('div', { class: 'res-list', id: 'resource-list' }, skeletonRowsEl(4));

  fill(ctx.host, pageEl([
    el('header', { class: 'page__head' }, el('div', {}, [
      el('div', { class: 'crumb' }, linkEl({ href: '#/detail/' + type + '/' + id }, 'back', '返回详情')),
      el('h1', { text: '找资源' }),
      el('p', { class: 'page__sub', text: heading }),
    ])),
    form,
    filterHost,
    sourceHost,
    list,
  ]));

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    const next = new URLSearchParams();
    next.set('title', title);
    next.set('year', year);
    next.set('q', String(form.elements.q.value || '').trim());
    if (form.elements.season.value) next.set('season', String(form.elements.season.value));
    if (form.elements.episode.value) next.set('episode', String(form.elements.episode.value));
    navigate('#/resources/' + type + '/' + id + '?' + next.toString());
  });

  const search = new URLSearchParams();
  search.set('q', keyword);
  search.set('type', type);
  if (season) search.set('season', season);
  if (episode) search.set('episode', episode);
  if (year) search.set('year', year);
  if (id) search.set('tmdbId', id);

  let data;
  try {
    data = await api('/resources?' + search.toString());
  } catch (error) {
    fill(list, errorEl(error.message));
    return;
  }

  const sources = Array.isArray(data && data.sources) ? data.sources : [];
  fill(sourceHost, sources.map(function (source) {
    const ok = source.ok === true;
    const text = ok
      ? (source.name || source.id) + ' · ' + (source.count || 0) + ' 条 · ' + (source.latencyMs || 0) + ' ms'
      : (source.name || source.id) + ' · ' + (source.error || '不可用');
    return chipEl(text, ok ? 'ok' : 'err');
  }));

  resourceItems = data && Array.isArray(data.items) ? data.items : [];
  if (!resourceItems.length) {
    fill(list, emptyEl('没有找到可用资源。可以换个关键词，或调整季/集后重新搜索。'));
    return;
  }

  const paint = function () {
    const shown = filteredResources();
    fill(filterHost, resourceFilterBarEl(resFilters, shown.length));
    if (!shown.length) {
      fill(list, emptyEl('当前筛选条件下没有资源。放宽「清晰度 / 做种 / 可信度」再试。'));
      return;
    }
    fill(list, shown.map(function (entry) { return resourceRowEl(entry.item, entry.index); }));
  };
  currentActions['res-set'] = function (button) {
    const key = button.getAttribute('data-key');
    const value = button.getAttribute('data-value');
    resFilters[key] = String(resFilters[key] || '') === value ? '' : value;
    paint();
  };

  paint();

  currentActions['add-resource'] = async function (button) {
    const item = resourceItems[Number(button.getAttribute('data-index'))];
    if (!item) return;
    button.disabled = true;
    let body = null;
    if (item.magnet) body = { magnet: item.magnet };
    else if (item.infoHash) body = { infoHash: item.infoHash };
    if (!body) {
      toast('这条资源既没有磁力链接也没有 infoHash', 'error');
      button.disabled = false;
      return;
    }
    try {
      await api('/tasks', { method: 'POST', body: body });
      button.classList.add('btn--done');
      fill(button, [iconNode('check'), el('span', { text: '已加入' })]);
      toast('已加入下载队列', 'ok');
    } catch (error) {
      button.disabled = false;
      toast(error.message, 'error');
    }
  };
}

/* ---------- 视图：下载任务 ---------- */

const live = {
  mode: 'idle',
  failures: 0,
  source: null,
  retryTimer: null,
  pollTimer: null
};

const taskState = { items: [], stats: null };
const taskNodes = new Map();

function activeTaskCount() {
  return taskState.items.filter(function (item) {
    return ACTIVE_TASK_STATES.indexOf(item.state) >= 0;
  }).length;
}

function updateNavBadge() {
  const count = activeTaskCount();
  const nodes = document.querySelectorAll('[data-nav="tasks"]');
  for (let i = 0; i < nodes.length; i += 1) {
    let badge = nodes[i].querySelector('.nav__badge');
    if (count > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'nav__badge';
        nodes[i].appendChild(badge);
      }
      badge.textContent = String(count);
      badge.hidden = false;
    } else if (badge) {
      badge.hidden = true;
    }
  }
}

function applyTasks(data) {
  if (!data || !Array.isArray(data.items)) return;
  taskState.items = data.items;
  taskState.stats = data.stats || null;
  updateNavBadge();
  paintTasks();
}

function startLive() {
  stopLive();
  connectLive();
}

function stopLive() {
  if (live.source) { live.source.close(); live.source = null; }
  clearTimeout(live.retryTimer);
  clearInterval(live.pollTimer);
  live.retryTimer = null;
  live.pollTimer = null;
}

function connectLive() {
  live.mode = 'sse';
  setLiveNote();
  let source;
  try {
    source = new EventSource(API_ROOT + '/tasks/events');
  } catch {
    live.failures = 2;
    usePolling();
    return;
  }
  live.source = source;
  source.onopen = function () {
    live.failures = 0;
    live.mode = 'sse';
    setLiveNote();
  };
  source.onmessage = function (event) {
    let payload = null;
    try { payload = JSON.parse(event.data); } catch { return; }
    applyTasks(payload);
  };
  source.onerror = function () {
    // EventSource 默认自动重连，这里手动管理，便于统计连续失败次数并降级。
    if (live.source) { live.source.close(); live.source = null; }
    live.failures += 1;
    if (live.failures >= 2) { usePolling(); return; }
    live.mode = 'retrying';
    setLiveNote();
    clearTimeout(live.retryTimer);
    live.retryTimer = setTimeout(connectLive, 3000);
  };
}

function usePolling() {
  if (live.source) { live.source.close(); live.source = null; }
  clearTimeout(live.retryTimer);
  live.mode = 'polling';
  setLiveNote();
  pollTasks();
  if (!live.pollTimer) live.pollTimer = setInterval(pollTasks, 3000);
}

async function pollTasks() {
  try {
    applyTasks(await api('/tasks'));
  } catch {
    // 保留上一次数据，不打断界面。
  }
}

function setLiveNote() {
  const note = $('#live-note');
  if (!note) return;
  if (live.mode === 'polling') {
    note.hidden = false;
    fill(note, [
      iconNode('alert'),
      el('span', { text: '实时推送不可用，已改为每 3 秒轮询一次。' }),
      buttonEl({ class: 'btn btn--sm', 'data-action': 'live-retry' }, null, '重试实时推送'),
    ]);
  } else if (live.mode === 'retrying') {
    note.hidden = false;
    fill(note, [iconNode('alert'), el('span', { text: '实时连接断开，正在重连…' })]);
  } else {
    note.hidden = true;
    note.replaceChildren();
  }
}

function taskSignature(task) {
  return [task.state, task.name, task.sizeBytes, task.error || '', task.savePath || '',
    Array.isArray(task.files) ? task.files.length : 0].join('|');
}

function taskRowEl(task) {
  const state = TASK_STATES[task.state] || { label: task.state || '未知', kind: 'info' };
  const total = Number(task.sizeBytes) || 0;
  const done = Number(task.downloadedBytes) || 0;
  const progress = Number.isFinite(Number(task.progress)) ? Math.max(0, Math.min(1, Number(task.progress))) : 0;
  const percent = (progress * 100).toFixed(1);
  const barKind = task.state === 'error' ? 'bar--err' : (task.state === 'completed' || task.state === 'seeding' ? 'bar--ok' : '');
  const canResume = task.state === 'paused' || task.state === 'error';
  const canPause = ACTIVE_TASK_STATES.indexOf(task.state) >= 0;
  return frag([
    el('div', { class: 'task__head' }, [
      el('h3', { class: 'task__name', text: task.name || task.id }),
      el('span', { class: classNames('chip', 'chip--' + state.kind), text: state.label }),
    ]),
    el('div', { class: classNames('bar', barKind) }, el('i', {
      'data-progress': true,
      style: 'width:' + percent + '%',
    })),
    el('div', { class: 'task__meta' }, [
      el('span', { 'data-size': true, text: fmtBytes(done) + ' / ' + fmtBytes(total) + '（' + percent + '%）' }),
      el('span', { 'data-rate': true, text: '↓ ' + fmtRate(task.rateDown) }),
      el('span', { 'data-peers': true, text: String(task.peers || 0) + ' 个节点' }),
      el('span', { 'data-eta': true, text: '剩余 ' + fmtSeconds(task.etaSeconds) }),
    ]),
    el('div', { class: 'task__foot' }, [
      el('span', { class: 'task__path', text: task.savePath || '' }),
      el('div', { class: 'task__actions' }, [
        canPause ? buttonEl({
          class: 'btn btn--sm', 'data-action': 'task-pause', 'data-id': task.id,
        }, 'pause', '暂停') : null,
        canResume ? buttonEl({
          class: 'btn btn--sm', 'data-action': 'task-resume', 'data-id': task.id,
        }, 'play', '继续') : null,
        buttonEl({
          class: 'btn btn--sm btn--danger', 'data-action': 'task-delete', 'data-id': task.id,
        }, 'trash', '删除'),
      ]),
    ]),
    task.error ? el('p', { class: 'task__error', text: task.error }) : null,
  ]);
}

function paintTasks() {
  const list = $('#task-list');
  const statsHost = $('#task-stats');
  if (!list || !statsHost) return;

  const stats = taskState.stats || {};
  fill(statsHost, [
    ['进行中', Number(stats.active) || activeTaskCount()],
    ['已完成', Number(stats.completed) || 0],
    ['下载速率', fmtRate(stats.rateDown)],
    ['上传速率', fmtRate(stats.rateUp)],
    ['累计大小', fmtBytes(stats.totalSizeBytes)]
  ].map(function (entry) {
    return el('div', { class: 'stat' }, [
      el('span', { class: 'stat__value', text: entry[1] }),
      el('span', { class: 'stat__label', text: entry[0] }),
    ]);
  }));

  const stale = list.querySelector('.notice');
  if (stale) stale.remove();

  const seen = new Set();
  taskState.items.forEach(function (task, index) {
    seen.add(task.id);
    let node = taskNodes.get(task.id);
    if (!node) {
      node = document.createElement('article');
      node.className = 'task';
      taskNodes.set(task.id, node);
    }
    const signature = taskSignature(task);
    if (node.getAttribute('data-signature') !== signature) {
      fill(node, taskRowEl(task));
      node.setAttribute('data-signature', signature);
    } else {
      const progress = Number(task.progress) || 0;
      const bar = node.querySelector('[data-progress]');
      if (bar) bar.style.width = (progress * 100).toFixed(1) + '%';
      const size = node.querySelector('[data-size]');
      if (size) {
        size.textContent = fmtBytes(task.downloadedBytes) + ' / ' + fmtBytes(task.sizeBytes)
          + '（' + (progress * 100).toFixed(1) + '%）';
      }
      const rate = node.querySelector('[data-rate]');
      if (rate) rate.textContent = '↓ ' + fmtRate(task.rateDown);
      const peers = node.querySelector('[data-peers]');
      if (peers) peers.textContent = String(task.peers || 0) + ' 个节点';
      const eta = node.querySelector('[data-eta]');
      if (eta) eta.textContent = '剩余 ' + fmtSeconds(task.etaSeconds);
    }
    const current = list.children[index];
    if (current !== node) list.insertBefore(node, current || null);
  });

  taskNodes.forEach(function (node, id) {
    if (!seen.has(id)) { node.remove(); taskNodes.delete(id); }
  });

  if (!taskState.items.length) {
    fill(list, emptyEl('还没有下载任务。点右上角「导入任务」粘贴磁力链接或选择种子文件。'));
  }
}

async function viewTasks(ctx) {
  fill(ctx.host, pageEl([
    el('header', { class: 'page__head' }, [
      el('div', {}, [
        el('h1', { text: '下载任务' }),
        el('p', { class: 'page__sub', text: '进度实时推送，断开后自动重连并在连续失败时降级为轮询。' }),
      ]),
      el('div', { class: 'page__actions' }, [
        buttonEl({ class: 'btn btn--primary', 'data-action': 'import' }, 'plus', '导入任务'),
        buttonEl({ class: 'btn', 'data-action': 'refresh' }, 'refresh', '刷新'),
      ]),
    ]),
    el('p', { id: 'live-note', class: 'live-note', hidden: true }),
    el('div', { id: 'task-stats', class: 'stats' }),
    el('div', { id: 'task-list', class: 'task-list' }),
  ]));

  taskNodes.clear();
  paintTasks();
  setLiveNote();
  if (live.mode === 'idle') startLive();

  try {
    applyTasks(await api('/tasks'));
  } catch (error) {
    if (!taskState.items.length) {
      fill($('#task-list'), errorEl(error.message));
    } else {
      toast(error.message, 'error');
    }
  }

  currentActions.refresh = async function () {
    try { applyTasks(await api('/tasks')); toast('已刷新', 'ok'); }
    catch (error) { toast(error.message, 'error'); }
  };
  currentActions.import = function () { openImportDialog(''); };
  currentActions['live-retry'] = function () { live.failures = 0; startLive(); };
  currentActions['task-pause'] = function (button) { changeTask(button, 'pause'); };
  currentActions['task-resume'] = function (button) { changeTask(button, 'resume'); };
  currentActions['task-delete'] = function (button) { deleteTask(button.getAttribute('data-id')); };
}

async function changeTask(button, what) {
  const id = button.getAttribute('data-id');
  button.disabled = true;
  try {
    const result = await api('/tasks/' + encodeURIComponent(id) + '/' + what, { method: 'POST' });
    if (result && result.task) {
      const index = taskState.items.findIndex(function (item) { return item.id === result.task.id; });
      if (index >= 0) taskState.items[index] = result.task;
      paintTasks();
    }
    toast(what === 'pause' ? '任务已暂停' : '任务已继续', 'ok');
  } catch (error) {
    toast(error.message, 'error');
    button.disabled = false;
  }
}

async function deleteTask(id) {
  const task = taskState.items.find(function (item) { return item.id === id; });
  let deleteFiles = false;
  const confirmed = await confirmDialog({
    title: '删除任务',
    message: '确定要删除「' + ((task && task.name) || id) + '」吗？',
    confirmText: '删除',
    danger: true,
    extra: el('label', { class: 'switch' }, [
      el('input', { type: 'checkbox', id: 'delete-files' }),
      ' 同时删除已下载的文件',
    ]),
    onMount: function (panel) {
      const checkbox = panel.querySelector('#delete-files');
      checkbox.addEventListener('change', function () { deleteFiles = checkbox.checked; });
    }
  });
  if (!confirmed) return;
  try {
    await api('/tasks/' + encodeURIComponent(id) + '?deleteFiles=' + (deleteFiles ? '1' : '0'), { method: 'DELETE' });
    taskState.items = taskState.items.filter(function (item) { return item.id !== id; });
    paintTasks();
    updateNavBadge();
    toast('任务已删除', 'ok');
  } catch (error) {
    toast(error.message, 'error');
  }
}

/* ---------- 视图：订阅 ---------- */

let subscriptionItems = [];

/* 订阅页只列「自己订阅了什么」，按电影与剧集分档；每天更新哪些在「更新日历」页。 */
let subscribeTab = 'auto';

async function viewSubscribe(ctx) {
  const wanted = String(ctx.route.params.get('type') || '');
  subscribeTab = wanted === 'movie' || wanted === 'tv' ? wanted : 'auto';

  const fileInput = el('input', {
    class: 'hidden-input',
    type: 'file',
    id: 'sub-import-file',
    accept: '.json,application/json',
  });
  fill(ctx.host, pageEl([
    el('header', { class: 'page__head' }, [
      el('div', {}, [
        el('h1', { text: '订阅' }),
        el('p', {
          class: 'page__sub',
          text: '这里是你订阅的电影与剧集；想看每天更新哪些，去「更新日历」。',
        }),
      ]),
      el('div', { class: 'page__actions' }, [
        linkEl({
          class: 'btn',
          href: API_ROOT + '/subscriptions/export',
          download: 'wanspilot-订阅.json',
        }, 'upload', '导出到网盘'),
        buttonEl({ class: 'btn btn--primary', 'data-action': 'sub-import' }, 'plus', '导入订阅'),
        fileInput,
      ]),
    ]),
    el('div', { class: 'sub-tabs', id: 'sub-tabs' }),
    el('div', { class: 'sub-list', id: 'sub-list' }, skeletonRowsEl(3)),
  ]));
  fileInput.addEventListener('change', async function () {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    let text = '';
    try {
      text = await file.text();
    } catch {
      toast('读取文件失败', 'error');
      return;
    }
    try {
      const result = await api('/subscriptions/import', { method: 'POST', body: { json: text } });
      toast('已导入 ' + ((result && result.imported) || 0) + ' 条，跳过 ' + ((result && result.skipped) || 0) + ' 条', 'ok');
      dropStash('subscribe');
      loadSubscriptions(true);
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  // 订阅卡：右击（触屏点三个点、键盘回车）出操作菜单
  const list = $('#sub-list');
  const itemOf = function (node) {
    return subscriptionItems.find(function (entry) { return entry.id === node.getAttribute('data-id'); });
  };
  if (list) {
    list.addEventListener('contextmenu', function (event) {
      const card = event.target.closest && event.target.closest('.sub-card');
      if (!card) return;
      event.preventDefault();
      const item = itemOf(card);
      if (item) openSubMenu(item, event);
    });
    list.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const card = event.target.closest && event.target.closest('.sub-card');
      if (!card) return;
      event.preventDefault();
      const item = itemOf(card);
      if (item) openSubMenu(item, { currentTarget: card });
    });
  }
  currentActions['sub-menu'] = function (button) {
    const item = itemOf(button);
    if (item) openSubMenu(item, { currentTarget: button });
  };
  currentActions['sub-import'] = function () { fileInput.click(); };
  currentActions['sub-upgrade'] = async function (button) {
    button.disabled = true;
    try {
      await api('/subscriptions/' + encodeURIComponent(button.getAttribute('data-id')) + '/upgrade', { method: 'POST' });
      toast('已加入更好的版本', 'ok');
      loadSubscriptions(true);
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  };
  currentActions['sub-upgrade-skip'] = async function (button) {
    try {
      await api('/subscriptions/' + encodeURIComponent(button.getAttribute('data-id')) + '/upgrade', { method: 'DELETE' });
      toast('已忽略这次提示', 'ok');
      loadSubscriptions(true);
    } catch (error) {
      toast(error.message, 'error');
    }
  };
  currentActions['sub-check'] = async function (button) {
    const id = button.getAttribute('data-id');
    button.disabled = true;
    try {
      const result = await api('/subscriptions/' + encodeURIComponent(id) + '/check', { method: 'POST' });
      toast((result && result.message) || '检查完成', 'ok');
      dropStash('subscribe');
      loadSubscriptions(true);
    } catch (error) {
      toast(error.message, 'error');
      button.disabled = false;
    }
  };
  currentActions['sub-toggle'] = async function (button) {
    const id = button.getAttribute('data-id');
    const next = button.getAttribute('data-next') === '1';
    button.disabled = true;
    try {
      await api('/subscriptions/' + encodeURIComponent(id), { method: 'PATCH', body: { enabled: next } });
      dropStash('subscribe');
      toast(next ? '订阅已启用' : '订阅已暂停', 'ok');
      loadSubscriptions(true);
    } catch (error) {
      toast(error.message, 'error');
      button.disabled = false;
    }
  };
  currentActions['sub-edit'] = function (button) { openSubscriptionEditor(button.getAttribute('data-id')); };
  currentActions['sub-delete'] = async function (button) {
    const id = button.getAttribute('data-id');
    const item = subscriptionItems.find(function (entry) { return entry.id === id; });
    try {
      await api('/subscriptions/' + encodeURIComponent(id), { method: 'DELETE' });
      dropStash('subscribe');
      toast('已取消订阅「' + ((item && item.title) || id) + '」（下载不受影响）', 'ok');
      loadSubscriptions(true);
    } catch (error) {
      toast(error.message, 'error');
    }
  };

  await loadSubscriptions(true);
  loadCalendar();
}

let calendarMonth = '';

/* 周一开头，与国内日历习惯一致。 */
const CAL_WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

/* 一天最多先列 3 张海报，多出来的折进「还有 N 条」，避免某天把整行撑高。 */
const CAL_MAX_ITEMS = 3;

function thisMonth() { return new Date().toISOString().slice(0, 7); }

function weekdayOf(date) {
  return (new Date(date + 'T00:00:00Z').getUTCDay() + 6) % 7;
}

/** 把某个月的更新摊成周一到周日排布的方格，首尾补空格。 */
function calendarCells(monthKey, days) {
  const parts = monthKey.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(parts[0], parts[1], 0)).getUTCDate();
  const offset = weekdayOf(monthKey + '-01');
  const byDate = new Map();
  (days || []).forEach(function (day) { byDate.set(day.date, day.items || []); });
  const cells = [];
  for (let i = 0; i < offset; i += 1) cells.push(null);
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = monthKey + '-' + pad2(day);
    cells.push({ date: date, day: day, items: byDate.get(date) || [] });
  }
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

function calendarItemEl(item) {
  const done = item.status === 'downloaded';
  const label = '第 ' + item.season + ' 季 第 ' + item.episode + ' 集';
  const type = item.type === 'movie' ? 'movie' : 'tv';
  // 海报直接放进日期框：海报 + 角标（第几集）+ 剧名，一眼看出今天更新的是哪部
  const poster = el('span', { class: 'cal__poster' });
  if (item.posterPath) {
    poster.append(el('img', {
      src: imageUrl(item.posterPath, 'w154'), alt: '', loading: 'lazy', decoding: 'async',
    }));
  } else {
    poster.append(iconNode('film'));
  }
  poster.append(el('span', {
    class: 'cal__ep',
    text: 'S' + pad2(item.season) + 'E' + pad2(item.episode),
  }));
  // 片名不再挤在海报下面（会截成「安迪·科…」），改成悬停提示里完整给出
  return el('a', {
    class: classNames('cal__item', done ? 'is-done' : 'is-missing'),
    href: '#/detail/' + type + '/' + (item.tmdbId || ''),
    title: item.title + ' · ' + label + (item.episodeName ? ' ' + item.episodeName : '')
      + (done ? ' · 已下载' : ' · 缺这一集'),
  }, poster);
}

function calendarCellEl(cell, todayKey) {
  if (!cell) return el('div', { class: 'cal__cell cal__cell--blank', 'aria-hidden': 'true' });
  const hidden = cell.items.length - CAL_MAX_ITEMS;
  const moreLabel = '还有 ' + hidden + ' 条';
  return el('div', {
    class: classNames('cal__cell',
      cell.date === todayKey && 'is-today',
      !cell.items.length && 'cal__cell--empty'),
  }, [
    el('div', { class: 'cal__date' }, [
      el('span', { class: 'cal__day', text: cell.day }),
      el('span', { class: 'cal__weekday', text: '周' + CAL_WEEKDAYS[weekdayOf(cell.date)] }),
      cell.date === todayKey ? el('span', { class: 'cal__today', text: '今天' }) : null,
      cell.items.length ? el('span', { class: 'cal__count', text: cell.items.length }) : null,
    ]),
    cell.items.length
      ? el('div', { class: 'cal__items' }, [
        cell.items.map(function (item) { return calendarItemEl(item); }),
        hidden > 0
          ? buttonEl({
            class: 'cal__more', 'data-action': 'cal-more', 'data-more': moreLabel,
          }, null, moreLabel)
          : null,
      ])
      : null,
  ]);
}

async function loadCalendar() {
  const body = $('#calendar-body');
  const nav = $('#calendar-nav');
  if (!body || !nav) return;
  calendarMonth = /^\d{4}-\d{2}$/.test(calendarMonth) ? calendarMonth : thisMonth();
  const parts = calendarMonth.split('-').map(Number);
  const prev = new Date(Date.UTC(parts[0], parts[1] - 2, 1)).toISOString().slice(0, 7);
  const next = new Date(Date.UTC(parts[0], parts[1], 1)).toISOString().slice(0, 7);
  const atThisMonth = calendarMonth === thisMonth();
  // 相邻月份写成单独一层 span：手机屏幕窄，只留左右箭头，隐藏这层标签
  const prevButton = buttonEl({
    class: 'btn btn--sm', 'data-action': 'cal-prev',
  }, 'chevron-left');
  prevButton.append(el('span', { class: 'cal__step' }, prev));
  const nextButton = buttonEl({
    class: 'btn btn--sm', 'data-action': 'cal-next',
  });
  nextButton.append(el('span', { class: 'cal__step' }, next), iconNode('chevron-right'));
  const todayButton = buttonEl({
    class: 'btn btn--sm',
    'data-action': 'cal-today',
    disabled: atThisMonth ? true : null,
  }, null, '今天');
  const legend = el('span', { class: 'cal__legend' }, [
    el('i', { class: 'cal__dot is-done' }), '已下载',
    el('i', { class: 'cal__dot is-missing' }), '缺这一集',
  ]);
  fill(nav, [
    prevButton,
    el('strong', { class: 'cal__month', text: calendarMonth }),
    nextButton,
    todayButton,
    el('span', { class: 'field__hint', id: 'calendar-count' }),
    legend,
  ]);

  let data;
  try {
    data = await cachedApi('/calendar?month=' + encodeURIComponent(calendarMonth), 60 * 1000);
  } catch (error) {
    fill(body, errorEl(error.message));
    return;
  }
  const days = (data && data.days) || [];
  const count = $('#calendar-count');
  if (count) count.textContent = '本月 ' + (data.total || 0) + ' 集，缺 ' + (data.missing || 0) + ' 集';
  const todayKey = new Date().toISOString().slice(0, 10);
  fill(body, [
    el('div', { class: 'cal__weekdays' }, CAL_WEEKDAYS.map(function (name) {
      return el('span', { text: '周' + name });
    })),
    el('div', { class: 'cal__grid' }, calendarCells(calendarMonth, days).map(function (cell) {
      return calendarCellEl(cell, todayKey);
    })),
    days.length ? null : emptyEl('这个月没有订阅内容的更新'),
  ]);
}

/** 更新日历页：只有日历，不掺订阅管理。 */
async function viewCalendar(ctx) {
  calendarMonth = calendarMonth || thisMonth();
  fill(ctx.host, pageEl([
    el('header', { class: 'page__head' }, [
      el('div', {}, [
        el('h1', { text: '更新日历' }),
        el('p', {
          class: 'page__sub',
          text: '按 TMDB 播出日期列出每天更新哪些剧集；海报在日期框里，绿框是已下载，红框是漏掉的。',
        }),
      ]),
    ]),
    el('section', { class: 'block' }, [
      el('div', { class: 'cal__bar', id: 'calendar-nav' }),
      el('div', { id: 'calendar-body' }, el('div', { class: 'sk', style: 'height:110px' })),
    ]),
  ]));

  function shiftMonth(delta) {
    const parts = (calendarMonth || thisMonth()).split('-').map(Number);
    calendarMonth = new Date(Date.UTC(parts[0], parts[1] - 1 + delta, 1)).toISOString().slice(0, 7);
    loadCalendar();
  }

  currentActions['cal-prev'] = function () { shiftMonth(-1); };
  currentActions['cal-next'] = function () { shiftMonth(1); };
  currentActions['cal-today'] = function () { calendarMonth = thisMonth(); loadCalendar(); };
  currentActions['cal-more'] = function (button) {
    const cell = button.closest('.cal__cell');
    if (!cell) return;
    const open = cell.classList.toggle('is-open');
    button.textContent = open ? '收起' : (button.getAttribute('data-more') || '');
  };

  await loadCalendar();
}

/** 三个点的「更多」图标：内置图标集里没有省略号，这里现画一个。 */
function moreIconNode() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  [5, 12, 19].forEach(function (cx) {
    const dot = document.createElementNS(SVG_NS, 'circle');
    dot.setAttribute('cx', String(cx));
    dot.setAttribute('cy', '12');
    dot.setAttribute('r', '1.8');
    svg.append(dot);
  });
  return svg;
}

/** 订阅就只显示海报：片名一行 + 状态，其余信息与按钮在右击菜单里。 */
function subCardEl(item) {
  const state = SUB_STATES[item.state] || { label: item.state || '未知', kind: 'info' };
  const type = item.type === 'movie' ? 'movie' : 'tv';
  const more = buttonEl({
    class: 'sub-card__more',
    'data-action': 'sub-menu',
    'data-id': item.id,
    'aria-label': '打开操作菜单',
  });
  more.append(moreIconNode());
  return el('article', {
    class: 'card sub-card',
    'data-id': item.id,
    tabindex: '0',
    'aria-label': (item.title || '订阅') + '，右击查看操作',
  }, [
    el('a', { class: 'card__poster', href: '#/detail/' + type + '/' + item.tmdbId },
      posterEl(item.posterPath, (item.title || '订阅') + ' 海报', 'w342')),
    el('div', { class: 'sub-card__meta' }, [
      el('span', { class: 'card__title', text: item.title || '未命名' }),
      chipEl(state.label, state.kind),
    ]),
    more,
  ]);
}

/** 右击（或在触屏上点三个点）弹出的订阅操作菜单：按钮都在这里，平时不占地方。 */
function openSubMenu(item, event) {
  closeSubMenu();
  const state = SUB_STATES[item.state] || { label: item.state || '未知', kind: 'info' };
  const type = item.type === 'movie' ? 'movie' : 'tv';
  const seasons = Array.isArray(item.seasons) && item.seasons.length
    ? '第 ' + item.seasons.join('、') + ' 季'
    : (type === 'movie' ? '' : '全部季');
  const keys = Array.isArray(item.downloadedKeys) ? item.downloadedKeys : [];
  const facts = [
    typeLabel(type),
    seasons,
    item.qualityPreference || '1080p',
    '做种 ≥ ' + (item.minSeeders === undefined ? 5 : item.minSeeders),
    '≤ ' + (item.maxSizeGB === undefined ? 30 : item.maxSizeGB) + ' GB',
    item.autoDownload ? '自动下载' : '仅通知',
  ].filter(Boolean).join(' · ');

  const menu = el('div', { class: 'sub-menu', role: 'menu', id: 'sub-menu' }, [
    el('div', { class: 'sub-menu__head' }, [
      el('span', { class: 'sub-menu__title', text: item.title || '未命名' }),
      chipEl(state.label, state.kind),
    ]),
    el('p', { class: 'sub-menu__facts', text: facts }),
    el('p', {
      class: 'sub-menu__facts',
      text: '上次检查 ' + (item.lastCheckAt ? fmtDateTime(item.lastCheckAt) : '尚未检查')
        + ' · 已下载 ' + keys.length + ' 项',
    }),
    item.lastMessage ? el('p', { class: 'sub-menu__msg', text: item.lastMessage }) : null,
    el('div', { class: 'sub-menu__items' }, [
      buttonEl({ class: 'sub-menu__item', 'data-action': 'sub-check', 'data-id': item.id }, 'refresh', '立即检查'),
      buttonEl({ class: 'sub-menu__item', 'data-action': 'sub-edit', 'data-id': item.id }, null, '编辑'),
      buttonEl({
        class: 'sub-menu__item',
        'data-action': 'sub-toggle',
        'data-id': item.id,
        'data-next': item.enabled ? '0' : '1',
      }, item.enabled ? 'pause' : 'play', item.enabled ? '暂停' : '启用'),
      buttonEl({
        class: 'sub-menu__item sub-menu__item--danger',
        'data-action': 'sub-delete',
        'data-id': item.id,
      }, 'trash', '删除'),
    ]),
  ]);

  const host = $('#sub-list') || document.body;
  host.append(menu);
  // 贴着鼠标（键盘打开时贴着卡片），并夹在视口内
  const box = menu.getBoundingClientRect();
  let left = event && event.clientX ? event.clientX : 0;
  let top = event && event.clientY ? event.clientY : 0;
  if (!left && !top && event && event.currentTarget && event.currentTarget.getBoundingClientRect) {
    const anchor = event.currentTarget.getBoundingClientRect();
    left = anchor.left;
    top = anchor.bottom;
  }
  menu.style.left = Math.max(8, Math.min(left, window.innerWidth - box.width - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(top, window.innerHeight - box.height - 8)) + 'px';

  setTimeout(function () {
    document.addEventListener('click', closeSubMenu, true);
    document.addEventListener('keydown', onSubMenuKey, true);
    window.addEventListener('scroll', closeSubMenu, true);
  }, 0);
}

function onSubMenuKey(event) {
  if (event.key === 'Escape') { event.stopPropagation(); closeSubMenu(); }
}

function closeSubMenu() {
  const menu = $('#sub-menu');
  if (!menu) return;
  menu.remove();
  document.removeEventListener('click', closeSubMenu, true);
  document.removeEventListener('keydown', onSubMenuKey, true);
  window.removeEventListener('scroll', closeSubMenu, true);
}

/** 订阅页顶部两档：电影 / 剧集，各自带条数。 */
function renderSubscribeTabs(active, movieCount, tvCount) {
  const host = $('#sub-tabs');
  if (!host) return;
  const entry = function (type, label, count) {
    return el('a', {
      class: classNames('chip', type === active && 'chip--active'),
      href: '#/subscribe?type=' + type,
      'aria-current': type === active ? 'true' : null,
    }, [label, el('small', { text: count })]);
  };
  fill(host, [entry('movie', '电影', movieCount), entry('tv', '剧集', tvCount)]);
}

async function loadSubscriptions(force) {
  const list = $('#sub-list');
  if (!list) return;
  try {
    // 与海报卡共用同一份订阅状态，订阅页拿的是最新一份
    subscriptionItems = await loadSubscriptionsCached(force);
  } catch (error) {
    fill(list, errorEl(error.message));
    return;
  }

  // 降档下载后出现更好版本时，在列表上方给一条可操作的提示
  const upgrades = subscriptionItems.filter(function (item) { return item.upgrade && item.upgrade.available; });
  const host = list.parentElement;
  const oldBox = host ? host.querySelector('.upgrade-box') : null;
  if (oldBox) oldBox.remove();
  if (upgrades.length && host) {
    const box = el('div', { class: 'notice notice--accent upgrade-box' }, upgrades.map(function (item) {
      return frag([
        el('p', { class: 'notice__title' }, [
          iconNode('trending'),
          el('span', { text: item.title + '：发现更好的版本' }),
        ]),
        el('p', {
          class: 'notice__text',
          text: ((item.upgrade && item.upgrade.title) || '')
            + '（' + ((item.upgrade && item.upgrade.resolution) || '') + '）',
        }),
        el('div', { class: 'row row--wrap' }, [
          buttonEl({
            class: 'btn btn--sm btn--primary', 'data-action': 'sub-upgrade', 'data-id': item.id,
          }, null, '替换'),
          buttonEl({
            class: 'btn btn--sm', 'data-action': 'sub-upgrade-skip', 'data-id': item.id,
          }, null, '忽略'),
        ]),
      ]);
    }));
    host.insertBefore(box, list);
  }

  const movies = subscriptionItems.filter(function (item) { return item.type === 'movie'; });
  const shows = subscriptionItems.filter(function (item) { return item.type !== 'movie'; });
  // 没指定看哪一档时，默认落在有内容的那一档
  const active = subscribeTab === 'movie' || subscribeTab === 'tv'
    ? subscribeTab
    : (movies.length ? 'movie' : 'tv');
  renderSubscribeTabs(active, movies.length, shows.length);

  if (!subscriptionItems.length) {
    fill(list, emptyEl('还没有订阅。打开任意影视详情页，点「订阅」即可创建。'));
    return;
  }
  const wanted = active === 'movie' ? movies : shows;
  if (!wanted.length) {
    fill(list, emptyEl(active === 'movie' ? '还没有订阅电影。' : '还没有订阅剧集。'));
    return;
  }
  fill(list, wanted.map(subCardEl));
}

function qualitySelectEl(name, value) {
  return el('select', { name: name }, QUALITY_OPTIONS.map(function (option) {
    return el('option', { value: option, selected: option === value ? true : null, text: option });
  }));
}

/** 表单里一行「标签 + 控件」。 */
function fieldEl(label, control) {
  return el('label', { class: 'field' }, [
    el('span', { class: 'field__label', text: label }),
    control,
  ]);
}

function switchEl(control, label) {
  return el('label', { class: 'switch' }, [control, ' ' + label]);
}

function openSubscriptionEditor(id) {
  const item = subscriptionItems.find(function (entry) { return entry.id === id; });
  if (!item) return;
  const isTv = item.type !== 'movie';
  const seasons = Array.isArray(item.seasons) ? item.seasons : [];
  const form = el('form', { class: 'form', id: 'sub-edit-form' }, [
    el('div', { class: 'form-grid' }, [
      fieldEl('清晰度偏好', qualitySelectEl('qualityPreference', item.qualityPreference || '1080p')),
      fieldEl('最低做种数', el('input', {
        type: 'number', name: 'minSeeders', min: '0', step: '1',
        value: item.minSeeders === undefined ? 5 : item.minSeeders,
      })),
      fieldEl('最大体积（GB）', el('input', {
        type: 'number', name: 'maxSizeGB', min: '1', step: '1',
        value: item.maxSizeGB === undefined ? 30 : item.maxSizeGB,
      })),
      isTv
        ? fieldEl('订阅季（逗号分隔）', el('input', {
          type: 'text', name: 'seasons', value: seasons.join(','), placeholder: '例如 5,6',
        }))
        : null,
    ]),
    switchEl(el('input', { type: 'checkbox', name: 'autoDownload', checked: item.autoDownload ? true : null }),
      '发现资源后自动下载'),
    switchEl(el('input', { type: 'checkbox', name: 'enabled', checked: item.enabled ? true : null }), '启用订阅'),
    el('div', { class: 'modal__foot' }, [
      buttonEl({ class: 'btn', 'data-close': true }, null, '取消'),
      buttonEl({ type: 'submit', class: 'btn btn--primary' }, null, '保存'),
    ]),
  ]);
  openModal({
    title: '编辑订阅 · ' + (item.title || ''),
    size: 'md',
    body: form,
    onMount: function (panel) {
      const form = panel.querySelector('#sub-edit-form');
      form.addEventListener('submit', async function (event) {
        event.preventDefault();
        const body = {
          qualityPreference: form.elements.qualityPreference.value,
          minSeeders: Number(form.elements.minSeeders.value) || 0,
          maxSizeGB: Number(form.elements.maxSizeGB.value) || 0,
          autoDownload: form.elements.autoDownload.checked,
          enabled: form.elements.enabled.checked
        };
        if (isTv) {
          const raw = String(form.elements.seasons.value || '');
          body.seasons = raw.split(',').map(function (part) {
            return parseInt(part.trim(), 10);
          }).filter(function (value) { return Number.isFinite(value) && value > 0; });
        }
        try {
          await api('/subscriptions/' + encodeURIComponent(id), { method: 'PATCH', body: body });
          dropStash('subscribe');
          toast('订阅已更新', 'ok');
          closeModal();
          loadSubscriptions(true);
        } catch (error) {
          toast(error.message, 'error');
        }
      });
    }
  });
}

function openSubscribeDialog(detail, options) {
  const opts = options || {};
  const isTv = detail.type === 'tv';
  const settings = appState.settings || {};
  const seasons = Array.isArray(detail.seasons) ? detail.seasons : [];
  const defaultSeason = seasons.length ? seasons[seasons.length - 1].seasonNumber : null;
  const seasonPicker = isTv
    ? el('fieldset', {}, [
      el('legend', { text: '订阅季' }),
      el('div', { class: 'season-picker' }, seasons.length
        ? seasons.map(function (season) {
          return el('label', { class: 'season-option' }, [
            el('input', {
              type: 'checkbox', name: 'seasons', value: season.seasonNumber,
              checked: season.seasonNumber === defaultSeason ? true : null,
            }),
            season.name || ('第 ' + season.seasonNumber + ' 季'),
          ]);
        })
        : el('p', { class: 'field__hint', text: '没有获取到分季信息，将订阅全部季。' })),
    ])
    : null;
  const form = el('form', { class: 'form', id: 'subscribe-form' }, [
    el('p', { class: 'modal__lead', text: '订阅后 WansPilot 会按下面的条件定期检查，发现符合条件的新资源就加入下载。' }),
    el('div', { class: 'form-grid' }, [
      fieldEl('清晰度偏好', qualitySelectEl('qualityPreference', settings.qualityPreference || '1080p')),
      fieldEl('最低做种数', el('input', {
        type: 'number', name: 'minSeeders', min: '0', step: '1',
        value: settings.minSeeders === undefined ? 5 : settings.minSeeders,
      })),
      fieldEl('最大体积（GB）', el('input', {
        type: 'number', name: 'maxSizeGB', min: '1', step: '1',
        value: settings.maxSizeGB === undefined ? 30 : settings.maxSizeGB,
      })),
      el('label', { class: 'switch field' }, [
        el('span', { class: 'field__label', text: '发现资源后' }),
        switchEl(el('input', {
          type: 'checkbox', name: 'autoDownload', checked: settings.autoDownload === false ? null : true,
        }), '自动加入下载'),
      ]),
    ]),
    seasonPicker,
    el('div', { class: 'modal__foot' }, [
      buttonEl({ class: 'btn', 'data-close': true }, null, '取消'),
      buttonEl({ type: 'submit', class: 'btn btn--primary' }, null, '确认订阅'),
    ]),
  ]);
  openModal({
    title: '订阅 · ' + (detail.title || ''),
    size: 'md',
    body: form,
    onMount: function (panel) {
      const form = panel.querySelector('#subscribe-form');
      form.addEventListener('submit', async function (event) {
        event.preventDefault();
        let picked = [];
        if (isTv) {
          const boxes = form.querySelectorAll('input[name="seasons"]:checked');
          picked = Array.prototype.map.call(boxes, function (box) { return Number(box.value); });
        }
        const body = {
          type: isTv ? 'tv' : 'movie',
          tmdbId: Number(detail.id),
          // 带上片名信息：后端搜索要用原名，中文名只作回退
          title: detail.title || '',
          originalTitle: detail.originalTitle || '',
          year: detail.year || '',
          seasons: isTv ? picked : null,
          qualityPreference: form.elements.qualityPreference.value,
          minSeeders: Number(form.elements.minSeeders.value) || 0,
          maxSizeGB: Number(form.elements.maxSizeGB.value) || 0,
          autoDownload: form.elements.autoDownload.checked
        };
        try {
          const created = await api('/subscriptions', { method: 'POST', body: body });
          if (created && created.item) rememberSubscription(created.item);
          dropStash('subscribe');
          dropStash('calendar');
          toast('订阅成功', 'ok');
          closeModal();
          if (typeof opts.onDone === 'function') opts.onDone(created && created.item);
        } catch (error) {
          toast(error.message, 'error');
        }
      });
    }
  });
}

/* ---------- 视图：设置 ---------- */

let settingsStatus = null;

function checkItemEl(name, ok, message, extra) {
  const kind = ok === true ? 'ok' : (ok === false ? 'err' : 'warn');
  return el('li', { class: classNames('check', 'check--' + kind) }, [
    el('span', { class: 'check__icon' }, iconNode(ok === true ? 'check' : 'alert')),
    el('div', { class: 'check__body' }, [
      el('span', { class: 'check__name', text: name }),
      el('span', { class: 'check__msg', text: message || '' }),
    ]),
    extra || null,
  ]);
}

function statusBlockEl(status, pending) {
  if (!status) {
    return el('div', { class: 'panel', id: 'settings-status' }, [
      el('div', { class: 'panel__head' }, el('h2', { class: 'panel__title', text: '自检结果' })),
      pending ? loadingEl('正在自检 TMDB、海报源与索引源…') : errorEl('自检结果不可用'),
    ]);
  }
  const sources = Array.isArray(status.sources) ? status.sources : [];
  return el('div', { class: 'panel', id: 'settings-status' }, [
    el('div', { class: 'panel__head' }, [
      el('h2', { class: 'panel__title', text: '自检结果' }),
      el('div', { class: 'row row--wrap' }, [
        buttonEl({ class: 'btn btn--sm', 'data-action': 'test', 'data-kind': 'tmdb' }, null, '测试 TMDB'),
        buttonEl({ class: 'btn btn--sm', 'data-action': 'test', 'data-kind': 'image' }, null, '测试海报源'),
        buttonEl({ class: 'btn btn--sm', 'data-action': 'test', 'data-kind': 'proxy' }, null, '测试代理'),
      ]),
    ]),
    el('ul', { class: 'checks' }, [
      checkItemEl('TMDB API Key', status.tmdbKeySet === true,
        status.tmdbKeySet === true ? '已填写' : '未填写，影视墙与搜索不可用'),
      checkItemEl('TMDB 接口', status.tmdbOk, status.tmdbMessage),
      checkItemEl('海报图片源', status.tmdbImageOk, status.tmdbImageMessage),
      checkItemEl('下载目录', status.downloadDirOk, status.downloadDirMessage),
      checkItemEl('下载引擎', status.engineReady,
        status.engineReady === true ? '就绪' : '未就绪，下载任务无法开始'),
      sources.map(function (source) {
        const ok = source.ok === true;
        const message = ok
          ? '可用 · 延迟 ' + (source.latencyMs || 0) + ' ms'
          : (source.message || source.error || '不可用');
        return checkItemEl('索引源 · ' + (source.name || source.id), ok, message,
          buttonEl({
            class: 'btn btn--sm', 'data-action': 'test', 'data-kind': 'source', 'data-id': source.id,
          }, null, '重测'));
      }),
    ]),
  ]);
}

function hintEl(text) {
  return el('span', { class: 'field__hint', text: text });
}

function checkboxEl(props) { return el('input', Object.assign({ type: 'checkbox' }, props)); }

function inputEl(type, props) { return el('input', Object.assign({ type: type }, props)); }

/** 设置页那一大张表单。字段顺序与保存时读取的顺序一致，方便对照。 */
function settingsFormEl(settings, highlightKey) {
  const form = el('form', { class: 'panel', id: 'settings-form' }, [
    el('div', { class: 'panel__head' }, el('h2', { class: 'panel__title', text: '基础设置' })),
    el('div', { class: 'form-grid' }, [
      el('label', {
        class: classNames('field', 'field--full', highlightKey && 'field--highlight'),
        id: 'tmdb-key-field',
      }, [
        el('span', { class: 'field__label', text: 'TMDB API Key' }),
        el('span', { class: 'secret' }, [
          inputEl('password', {
            id: 'set-tmdb-key', name: 'tmdbApiKey', autocomplete: 'off', spellcheck: 'false',
            value: settings.tmdbApiKey || '', placeholder: 'TMDB 账号设置里的 API Key（v3 auth）',
          }),
          buttonEl({
            class: 'btn btn--sm', 'data-action': 'toggle-key', 'aria-label': '显示或隐藏 API Key',
          }, null, '显示'),
        ]),
        hintEl('留空表示不使用 TMDB，影视墙、搜索与详情页都会失效。'),
      ]),
      el('label', { class: 'field field--full' }, [
        el('span', { class: 'field__label', text: 'TMDB 接口地址' }),
        inputEl('text', { name: 'tmdbApiBase', spellcheck: 'false', value: settings.tmdbApiBase || '' }),
        hintEl('后端访问 TMDB 的接口地址，可由后端替换为镜像。'),
      ]),
      el('label', { class: 'field field--full' }, [
        el('span', { class: 'field__label', text: 'TMDB 图片地址' }),
        inputEl('text', { name: 'tmdbImageBase', spellcheck: 'false', value: settings.tmdbImageBase || '' }),
        hintEl('海报与剧照的图片来源，前端只通过 /api/image 取图。'),
      ]),
      el('label', { class: 'field field--full' }, [
        el('span', { class: 'field__label', text: '网络代理' }),
        inputEl('text', {
          name: 'proxy', spellcheck: 'false', value: settings.proxy || '', placeholder: '留空表示不使用代理',
        }),
        hintEl('后端访问 TMDB 与索引源时使用的代理。'),
      ]),
      el('div', { class: 'field field--full' }, [
        el('label', { class: 'field__label', for: 'set-download-dir', text: '下载目录' }),
        el('div', { class: 'row row--wrap' }, [
          inputEl('text', { id: 'set-download-dir', name: 'downloadDir', value: settings.downloadDir || '' }),
          buttonEl({ class: 'btn', 'data-action': 'pick-dir' }, 'folder', '从网盘选择'),
        ]),
        hintEl('相对网盘「我的文档」的路径，例如 下载/wanspilot。'),
      ]),
      fieldEl('默认清晰度偏好', qualitySelectEl('qualityPreference', settings.qualityPreference || '1080p')),
      fieldEl('最低做种数', inputEl('number', {
        name: 'minSeeders', min: '0', step: '1',
        value: settings.minSeeders === undefined ? 5 : settings.minSeeders,
      })),
      fieldEl('单个资源最大体积（GB）', inputEl('number', {
        name: 'maxSizeGB', min: '1', step: '1',
        value: settings.maxSizeGB === undefined ? 30 : settings.maxSizeGB,
      })),
      fieldEl('订阅检查间隔（分钟）', inputEl('number', {
        name: 'checkIntervalMinutes', min: '5', step: '5',
        value: settings.checkIntervalMinutes === undefined ? 60 : settings.checkIntervalMinutes,
      })),
    ]),
    switchEl(checkboxEl({ name: 'autoDownload', checked: settings.autoDownload === false ? null : true }),
      '检查到符合条件的资源时自动下载'),
    el('div', { class: 'row row--wrap' }, [
      buttonEl({ type: 'submit', class: 'btn btn--primary' }, null, '保存设置'),
      buttonEl({ class: 'btn', 'data-action': 'reload' }, null, '重新载入'),
    ]),
    el('h3', { class: 'panel__title', style: 'margin-top:18px', text: '下载与整理' }),
    el('label', { class: 'field' }, [
      el('span', { class: 'field__label', text: '配额上限（GB，0 表示不限）' }),
      inputEl('number', { name: 'quotaGB', min: '0', step: '10', value: settings.quotaGB || 0 }),
      hintEl('加入下载前会先比一次剩余空间与配额，装不下就直接拒绝并说明原因。'),
    ]),
    switchEl(checkboxEl({ name: 'autoOrganize', checked: settings.autoOrganize ? true : null }),
      '下载完成后按「片名 (年份)/」归档'),
    switchEl(checkboxEl({ name: 'writeNfo', checked: settings.writeNfo ? true : null }),
      '同时写 .nfo 与海报，Jellyfin / Emby 可直接识别'),
    switchEl(checkboxEl({ name: 'deleteSamples', checked: settings.deleteSamples === false ? null : true }),
      '整理时清掉样本文件'),
    el('div', { class: 'row row--wrap' }, [
      buttonEl({ class: 'btn', 'data-action': 'organize-now' }, 'folder-plus', '立即整理已完成的任务'),
      el('span', { class: 'field__hint', id: 'organize-result' }),
    ]),
    el('h3', { class: 'panel__title', style: 'margin-top:18px', text: '运维' }),
    el('div', { class: 'row row--wrap', style: 'margin-top:10px' }, [
      linkEl({ class: 'btn', href: '#/health' }, 'activity', '运行状况'),
    ]),
    el('p', { class: 'notice notice--muted', id: 'settings-message', hidden: true }),
  ]);
  return form;
}


/* 设置页先用手上的数据画出来，自检结果晚一步贴上来：
   自检要现场打 TMDB 与索引源，慢的时候十几秒，不能让它挡住整页。 */
const SELFTEST_TTL_MS = 60 * 1000;

async function viewSettings(ctx) {
  const focusKey = ctx.route.params.get('focus') === 'key';
  const cachedSettings = appState.settings || cachedPayload('/settings');
  paintSettings(ctx, cachedSettings || {}, cachedPayload('/settings/status', SELFTEST_TTL_MS) || undefined,
    cachedPayload('/system'), focusKey, true);

  const [settingsRes, statusRes, systemRes] = await Promise.allSettled([
    cachedApi('/settings'),
    cachedApi('/settings/status', SELFTEST_TTL_MS),
    cachedApi('/system'),
  ]);
  const settings = settingsRes.status === 'fulfilled' && settingsRes.value
    ? settingsRes.value
    : (appState.settings || {});
  if (settingsRes.status === 'fulfilled' && settingsRes.value) appState.settings = settingsRes.value;
  settingsCache = appState.settings || null;
  paintSettings(ctx, settings, statusRes.status === 'fulfilled' ? statusRes.value : null,
    systemRes.status === 'fulfilled' ? systemRes.value : null, focusKey, false);
}

/** 画设置页（表单 + 自检 + 系统信息 + 日志），并绑好这一份 DOM 上的处理函数。 */
function paintSettings(ctx, settings, status, system, focusKey, pending) {
  settingsStatus = status === undefined ? settingsStatus : status;
  const keyMissing = !settings.tmdbApiKey;
  const highlightKey = focusKey || keyMissing;

  const callout = highlightKey
    ? el('div', { class: 'notice notice--accent' }, [
      el('p', { class: 'notice__title' }, [
        iconNode('alert'),
        el('span', { text: '先填写 TMDB API Key' }),
      ]),
      el('p', {
        class: 'notice__text',
        text: '影视墙、搜索和详情页的数据都来自 TMDB。请在 TMDB 账号设置里申请 API Key（v3 auth），'
          + '填到下面第一项，保存后点「测试 TMDB」确认可用。如果后端无法直连 TMDB，再填写接口地址或网络代理。',
      }),
    ])
    : null;

  const systemBlock = el('div', { class: 'panel' }, [
    el('div', { class: 'panel__head' }, el('h2', { class: 'panel__title', text: '系统信息' })),
    system
      ? el('div', { class: 'kv' }, [
        kvRowEl('版本', system.version || '未知'),
        kvRowEl('Node', system.nodeVersion || '未知'),
        kvRowEl('数据目录', system.dataDir || ''),
        kvRowEl('下载目录', system.downloadDir || ''),
        kvRowEl('目录可写', system.downloadDirWritable ? '是' : '否'),
        kvRowEl('剩余空间', fmtBytes(system.freeBytes)),
        kvRowEl('已运行', fmtUptime(system.uptimeSeconds)),
        kvRowEl('下载引擎', system.engineReady ? '就绪' : '未就绪'),
      ])
      : (pending ? loadingEl('正在读取系统信息…') : errorEl('系统信息不可用')),
  ]);

  const logsBlock = el('div', { class: 'panel' }, [
    el('div', { class: 'panel__head' }, [
      el('h2', { class: 'panel__title', text: '运行日志' }),
      buttonEl({ class: 'btn btn--sm', 'data-action': 'load-logs' }, 'refresh', '加载日志'),
    ]),
    el('pre', { class: 'debug logs', id: 'logs', text: '点「加载日志」查看后端最近 200 行输出。' }),
  ]);

  fill(ctx.host, pageEl([
    el('header', { class: 'page__head' }, el('div', {}, [
      el('h1', { text: '设置' }),
      el('p', { class: 'page__sub', text: 'TMDB、下载目录、资源筛选条件与自检。' }),
    ])),
    callout,
    el('div', { class: 'settings' }, [
      settingsFormEl(settings, highlightKey),
      statusBlockEl(settingsStatus, pending && !settingsStatus),
      systemBlock,
      logsBlock,
    ]),
  ]));

  const form = $('#settings-form');
  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    const message = $('#settings-message');
    message.hidden = true;
    const body = {
      quotaGB: Number(form.elements.quotaGB.value) || 0,
      autoOrganize: form.elements.autoOrganize.checked,
      writeNfo: form.elements.writeNfo.checked,
      deleteSamples: form.elements.deleteSamples.checked,
      tmdbApiKey: String(form.elements.tmdbApiKey.value || '').trim(),
      tmdbApiBase: String(form.elements.tmdbApiBase.value || '').trim(),
      tmdbImageBase: String(form.elements.tmdbImageBase.value || '').trim(),
      proxy: String(form.elements.proxy.value || '').trim(),
      downloadDir: String(form.elements.downloadDir.value || '').trim(),
      qualityPreference: form.elements.qualityPreference.value,
      minSeeders: Number(form.elements.minSeeders.value) || 0,
      maxSizeGB: Number(form.elements.maxSizeGB.value) || 0,
      checkIntervalMinutes: Number(form.elements.checkIntervalMinutes.value) || 0,
      autoDownload: form.elements.autoDownload.checked
    };
    try {
      const saved = await api('/settings', { method: 'PUT', body: body });
      appState.settings = saved || body;
      dropStash();
      toast('设置已保存', 'ok');
      try {
        settingsStatus = await api('/settings/status');
        const host = $('#settings-status');
        if (host) host.replaceWith(statusBlockEl(settingsStatus, false));
      } catch (error) {
        toast('设置已保存，但自检失败：' + error.message, 'error');
      }
    } catch (error) {
      message.hidden = false;
      message.className = 'notice notice--err';
      message.textContent = '保存失败：' + error.message;
    }
  });

  currentActions.reload = function () { render(); };
  currentActions['toggle-key'] = function (button) {
    const input = $('#set-tmdb-key');
    if (!input) return;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    const label = button && button.querySelector('span');
    if (label) label.textContent = show ? '隐藏' : '显示';
    if (button) button.setAttribute('aria-pressed', show ? 'true' : 'false');
  };
  currentActions['pick-dir'] = async function () {
    const value = await openFilePicker('directory');
    if (!value) return;
    const input = $('#set-download-dir');
    if (input) input.value = relativeHomePath(value);
    toast('已填入所选目录，确认后记得保存', 'ok');
  };
  currentActions.test = async function (button) {
    const kind = button.getAttribute('data-kind') || 'tmdb';
    const body = { kind: kind };
    const sourceId = button.getAttribute('data-id');
    if (sourceId) body.id = sourceId;
    button.disabled = true;
    try {
      const result = await api('/settings/test', { method: 'POST', body: body });
      settingsStatus = Object.assign({}, settingsStatus || {}, result || {});
      const host = $('#settings-status');
      if (host) host.replaceWith(statusBlockEl(settingsStatus));
      toast('测试完成', 'ok');
    } catch (error) {
      toast(error.message, 'error');
      if (document.contains(button)) button.disabled = false;
    }
  };
  currentActions['organize-now'] = async function () {
    const hint = $('#organize-result');
    if (hint) hint.textContent = '正在整理…';
    try {
      const data = await api('/organizer/run', { method: 'POST' });
      const reports = (data && data.reports) || [];
      const moved = reports.reduce(function (sum, item) { return sum + (item.moved || 0); }, 0);
      const skipped = reports.filter(function (item) { return item.skipped; }).length;
      if (hint) hint.textContent = '整理完成：移动 ' + moved + ' 个文件' + (skipped ? '，' + skipped + ' 个任务跳过' : '');
      toast('整理完成', 'ok');
    } catch (error) {
      if (hint) hint.textContent = error.message;
      toast(error.message, 'error');
    }
  };
  currentActions['load-logs'] = async function (button) {
    const pre = $('#logs');
    button.disabled = true;
    try {
      const text = await apiText('/logs?lines=200');
      pre.textContent = text || '（日志为空）';
    } catch (error) {
      pre.textContent = '读取日志失败：' + error.message;
    } finally {
      if (document.contains(button)) button.disabled = false;
    }
  };

  if (highlightKey) {
    const field = $('#tmdb-key-field');
    if (field) {
      field.scrollIntoView({ block: 'center' });
      const input = field.querySelector('input');
      if (input) input.focus({ preventScroll: true });
    }
  }
}

/* ---------- 网盘选择器 ---------- */

function relativeHomePath(value) {
  // 兜一层：万一上游还是给了 JSON 文本，先取出里面的路径
  const unwrapped = unwrapPickedJson(value);
  if (Array.isArray(unwrapped) || (unwrapped && typeof unwrapped === 'object')) {
    return relativeHomePath(pickedValue(unwrapped));
  }
  let path = String(unwrapped == null ? '' : unwrapped).trim();
  if (!path) return path;
  for (let i = 0; i < HOME_PREFIXES.length; i += 1) {
    if (path.indexOf(HOME_PREFIXES[i]) === 0) {
      path = path.slice(HOME_PREFIXES[i].length);
      break;
    }
  }
  return path.replace(/^\/+/, '').replace(/\/+$/, '');
}

function normalizePickedList(detail) {
  if (!detail) return [];
  if (Array.isArray(detail)) {
    const first = detail[0];
    if (first && (Array.isArray(first) || typeof first === 'object')) return normalizePickedList(first);
    return detail;
  }
  if (typeof detail === 'object') {
    const inner = detail.fileList || detail.files || detail.items || detail.list || detail.data;
    if (inner) return normalizePickedList(inner);
    return [detail];
  }
  return [];
}

/* 官方选择器有时把整条记录当成 JSON 字符串塞回来（[{"basename":"下载","filename":"/下载",…}]），
   这里先把它拆开，再按字段优先级取值，避免把整段 JSON 填进输入框。 */
function unwrapPickedJson(value) {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text || (text[0] !== '[' && text[0] !== '{')) return value;
  try { return JSON.parse(text); } catch { return value; }
}

function pickedValue(item) {
  let node = unwrapPickedJson(item);
  if (Array.isArray(node)) node = node[0];
  node = unwrapPickedJson(node);
  if (typeof node === 'string') return node.trim();
  if (!node || typeof node !== 'object') return '';
  for (let i = 0; i < PICKED_VALUE_KEYS.length; i += 1) {
    const value = node[PICKED_VALUE_KEYS[i]];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function stringifyForDebug(value) {
  const seen = new WeakSet();
  let text;
  try {
    text = JSON.stringify(value, function (key, item) {
      if (typeof item === 'function') return '[function]';
      if (typeof File !== 'undefined' && item instanceof File) {
        return '[File ' + item.name + ' ' + item.size + 'B]';
      }
      if (item && typeof item === 'object') {
        if (seen.has(item)) return '[circular]';
        seen.add(item);
      }
      if (typeof item === 'string' && item.length > 800) return item.slice(0, 800) + '…';
      return item;
    }, 2);
  } catch {
    text = String(value);
  }
  if (typeof text !== 'string') text = String(text);
  if (!text) text = String(value);
  return text.length > 4000 ? text.slice(0, 4000) + '\n…（已截断）' : text;
}

function readPickerPayload(event) {
  const source = event && typeof event.detail !== 'undefined' ? event.detail : event;
  const list = normalizePickedList(source);
  let value = '';
  for (let i = 0; i < list.length; i += 1) {
    const candidate = pickedValue(list[i]);
    if (candidate) { value = candidate; break; }
  }
  if (!value && event) {
    for (let i = 0; i < PICKED_VALUE_KEYS.length; i += 1) {
      const fallback = event[PICKED_VALUE_KEYS[i]];
      if (typeof fallback === 'string' && fallback.trim()) { value = fallback.trim(); break; }
    }
  }
  return { value: value, raw: stringifyForDebug(source) };
}

function openFilePicker(kind) {
  return new Promise(function (resolve) {
    const host = $('#picker-host');
    const label = kind === 'directory' ? '选择下载目录' : '选择种子文件';
    fill(host, el('div', { class: 'picker', role: 'dialog', 'aria-modal': 'true', 'aria-label': label }, [
      el('header', { class: 'picker__head' }, [
        el('h2', { text: label }),
        el('button', {
          type: 'button', class: 'icon-btn', id: 'picker-close', 'aria-label': '关闭',
        }, iconNode('close')),
      ]),
      el('div', { class: 'picker__body', id: 'picker-mount' }),
    ]));
    host.hidden = false;

    let settled = false;
    function finish(value) {
      if (settled) return;
      settled = true;
      host.hidden = true;
      host.replaceChildren();
      document.removeEventListener('keydown', onKey, true);
      resolve(value || '');
    }
    function onKey(event) {
      if (event.key === 'Escape') { event.stopPropagation(); finish(''); }
    }
    document.addEventListener('keydown', onKey, true);
    $('#picker-close').addEventListener('click', function () { finish(''); });

    const mount = $('#picker-mount');
    if (!window.customElements || !customElements.get('lzc-file-picker')) {
      fill(mount, el('div', { class: 'notice notice--err' },
        el('p', { class: 'notice__text', text: '网盘选择器脚本没有加载成功，请刷新页面后重试。' })));
      return;
    }

    const element = document.createElement('lzc-file-picker');
    element.setAttribute('type', kind === 'directory' ? 'directory' : 'file');
    if (kind === 'directory') {
      element.setAttribute('title', label);
    } else {
      element.setAttribute('title', label);
      element.setAttribute('extname', 'torrent');
      element.setAttribute('accept', '.torrent');
    }
    mount.appendChild(element);
    if (kind === 'directory') {
      // 组件在挂载时把特性读成字符串，空字符串在组件内部是假值。
      // 因此布尔 prop 必须在挂载后用 JS 属性赋值，才能传成 true。
      element.choiceDirOnly = true;
    }

    element.addEventListener('submit', function (event) {
      const picked = readPickerPayload(event);
      if (picked.value) { finish(picked.value); return; }
      fill(mount, el('div', { class: 'notice notice--warn' }, [
        el('p', { class: 'notice__title' }, [
          iconNode('alert'),
          el('span', { text: '没能识别出文件路径' }),
        ]),
        el('p', {
          class: 'notice__text',
          text: '选择器返回的数据里没有 path / webkitRelativePath / name / url 字段。'
            + '下面是原始内容，请反馈给开发者。',
        }),
        el('pre', { class: 'debug', text: picked.raw }),
        buttonEl({ class: 'btn', id: 'picker-close-2' }, null, '关闭'),
      ]));
      const close2 = $('#picker-close-2');
      if (close2) close2.addEventListener('click', function () { finish(''); });
    });
    element.addEventListener('close', function () { finish(''); });
  });
}

/* ---------- 导入种子对话框 ---------- */

function readFileBase64(file) {
  return new Promise(function (resolve, reject) {
    const reader = new FileReader();
    reader.onload = function () {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : '');
    };
    reader.onerror = function () { reject(new Error('读取本地文件失败')); };
    reader.readAsDataURL(file);
  });
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/* 网盘文件地址转成同源文件桥地址，桥的前缀与语义见 lzc-manifest.yml。 */
function bridgeUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return raw;
  if (raw.indexOf(BRIDGE_ROOT + '/') === 0) return raw;
  for (let i = 0; i < HOME_PREFIXES.length; i += 1) {
    if (raw.indexOf(HOME_PREFIXES[i]) === 0) {
      return BRIDGE_ROOT + '/' + raw.slice(HOME_PREFIXES[i].length);
    }
  }
  if (raw.charAt(0) === '/') return BRIDGE_ROOT + raw;
  let parsed = null;
  try { parsed = new URL(raw); } catch { return raw; }
  let path = parsed.pathname;
  for (let i = 0; i < HOME_PREFIXES.length; i += 1) {
    if (path.indexOf(HOME_PREFIXES[i]) === 0) {
      path = '/' + path.slice(HOME_PREFIXES[i].length);
      break;
    }
  }
  return BRIDGE_ROOT + path + parsed.search;
}

function openImportDialog(prefill) {
  const valueBox = el('textarea', {
    name: 'value', rows: '3', spellcheck: 'false',
    placeholder: 'magnet:?xt=urn:btih:… 或种子文件地址',
    text: prefill || '',
  });
  const fileInput = el('input', {
    class: 'hidden-input',
    type: 'file',
    id: 'torrent-file',
    accept: '.torrent,application/x-bittorrent',
  });
  const importForm = el('form', { class: 'form', id: 'import-form' }, [
    el('label', { class: 'field' }, [
      el('span', { class: 'field__label', text: '磁力链接或种子文件地址' }),
      valueBox,
    ]),
    el('div', { class: 'row row--wrap' }, [
      buttonEl({ class: 'btn', 'data-action': 'pick-torrent-cloud' }, 'folder', '从网盘选择种子'),
      buttonEl({ class: 'btn', 'data-action': 'pick-torrent-local' }, 'file', '选择本机种子文件'),
    ]),
    fileInput,
    el('p', { class: 'field__hint', text: '支持 magnet 链接、40 位 infoHash，以及网盘或平台传入的种子文件地址。' }),
    el('p', { class: 'field__hint', id: 'import-picked', hidden: true }),
    el('div', { class: 'modal__foot' }, [
      buttonEl({ class: 'btn', 'data-close': true }, null, '取消'),
      buttonEl({ type: 'submit', class: 'btn btn--primary' }, null, '开始下载'),
    ]),
  ]);
  openModal({
    title: '导入下载任务',
    size: 'md',
    body: importForm,
    actions: {
      'pick-torrent-cloud': async function () {
        const value = await openFilePicker('torrent');
        if (!value) return;
        const form = $('#import-form');
        if (form) form.elements.value.value = value;
        const note = $('#import-picked');
        if (note) { note.hidden = false; note.textContent = '已从网盘选择：' + value; }
      },
      'pick-torrent-local': function () {
        const input = $('#torrent-file');
        if (input) input.click();
      }
    },
    onMount: function (panel) {
      let pendingBase64 = '';
      const fileInput = panel.querySelector('#torrent-file');
      const note = panel.querySelector('#import-picked');
      fileInput.addEventListener('change', async function () {
        const file = fileInput.files && fileInput.files[0];
        if (!file) return;
        try {
          pendingBase64 = await readFileBase64(file);
          if (note) {
            note.hidden = false;
            note.textContent = '已选择本机文件：' + file.name + '（' + fmtBytes(file.size) + '）';
          }
        } catch (error) {
          pendingBase64 = '';
          toast(error.message, 'error');
        }
      });

      const form = panel.querySelector('#import-form');
      form.addEventListener('submit', async function (event) {
        event.preventDefault();
        const value = String(form.elements.value.value || '').trim();
        try {
          if (pendingBase64) {
            await api('/tasks', { method: 'POST', body: { torrentBase64: pendingBase64 } });
          } else {
            await api('/tasks', { method: 'POST', body: await buildImportBody(value) });
          }
          toast('已加入下载队列', 'ok');
          closeModal();
          if (parseRoute().name === 'tasks') pollTasks();
        } catch (error) {
          toast(error.message, 'error');
        }
      });
    }
  });
}

async function buildImportBody(value) {
  if (!value) throw new Error('请填写磁力链接，或选择种子文件');
  if (value.indexOf('magnet:') === 0) return { magnet: value };
  if (/^[0-9a-fA-F]{40}$/.test(value)) return { infoHash: value.toLowerCase() };
  const response = await fetch(bridgeUrl(value), { credentials: 'same-origin' });
  if (!response.ok) throw new Error('读取种子文件失败（HTTP ' + response.status + '）');
  const buffer = await response.arrayBuffer();
  if (!buffer.byteLength) throw new Error('种子文件内容为空');
  return { torrentBase64: toBase64(buffer) };
}

/* ---------- 模态框 ---------- */

let modalOnClose = null;

function openModal(options) {
  closeModal();
  const root = $('#modal-root');
  const previous = document.activeElement;
  root.hidden = false;
  const panel = el('div', {
    class: 'modal modal--' + (options.size || 'md'),
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': options.title || '',
    tabindex: '-1',
  }, [
    el('header', { class: 'modal__head' }, [
      el('h2', { class: 'modal__title', text: options.title || '' }),
      el('button', {
        type: 'button', class: 'icon-btn', 'data-close': true, 'aria-label': '关闭',
      }, iconNode('close')),
    ]),
    el('div', { class: 'modal__body' }, options.body || null),
  ]);
  root.replaceChildren(
    el('div', { class: 'modal__backdrop', 'data-close': true }),
    panel,
  );

  modalActions = options.actions || {};
  modalOnClose = options.onClose || null;
  modalPreviousFocus = previous;
  const onKey = function (event) {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    closeModal();
  };
  document.addEventListener('keydown', onKey, true);
  root.modalKeyHandler = onKey;

  const focusTarget = panel.querySelector('input, textarea, select, button:not([data-close])');
  (focusTarget || panel).focus();
  if (options.onMount) options.onMount(panel);
  return panel;
}

let modalActions = {};
let modalPreviousFocus = null;

function closeModal() {
  const root = $('#modal-root');
  if (!root || root.hidden) return;
  if (root.modalKeyHandler) {
    document.removeEventListener('keydown', root.modalKeyHandler, true);
    root.modalKeyHandler = null;
  }
  root.hidden = true;
  root.replaceChildren();
  modalActions = {};
  const onClose = modalOnClose;
  modalOnClose = null;
  const previous = modalPreviousFocus;
  modalPreviousFocus = null;
  if (previous && document.contains(previous) && previous.focus) {
    try { previous.focus(); } catch { /* 元素已不可聚焦 */ }
  }
  if (onClose) onClose();
}

function confirmDialog(options) {
  return new Promise(function (resolve) {
    let answered = false;
    function settle(value) {
      if (answered) return;
      answered = true;
      resolve(value);
    }
    openModal({
      title: options.title,
      size: 'sm',
      body: frag([
        el('p', { class: 'modal__text', text: options.message }),
        options.extra ? el('div', { class: 'modal__extra' }, options.extra) : null,
        el('div', { class: 'modal__foot' }, [
          buttonEl({ class: 'btn', 'data-action': 'dialog-no' }, null, '取消'),
          buttonEl({
            class: classNames('btn', options.danger ? 'btn--danger' : 'btn--primary'),
            'data-action': 'dialog-yes',
          }, null, options.confirmText || '确认'),
        ]),
      ]),
      actions: {
        'dialog-yes': function () { settle(true); closeModal(); },
        'dialog-no': function () { settle(false); closeModal(); }
      },
      onClose: function () { settle(false); },
      onMount: options.onMount
    });
  });
}

/* ---------- 事件绑定与启动 ---------- */

const appState = { settings: null, settingsError: '' };

function takeOpenFileParam() {
  const params = new URLSearchParams(location.search);
  const raw = params.get('lzcOpenFile');
  if (!raw) return '';
  params.delete('lzcOpenFile');
  const rest = params.toString();
  history.replaceState(null, '', location.pathname + (rest ? '?' + rest : '') + location.hash);
  try { return decodeURIComponent(raw); } catch { return raw; }
}

function bindGlobalEvents() {
  document.addEventListener('click', function (event) {
    const button = event.target.closest && event.target.closest('[data-action="theme-toggle"]');
    if (button) {
      event.preventDefault();
      toggleTheme();
    }
  });
  window.addEventListener('hashchange', render);

  $('#view').addEventListener('click', function (event) {
    const trigger = event.target.closest('[data-action]');
    if (!trigger) return;
    const handler = currentActions[trigger.getAttribute('data-action')];
    if (!handler) return;
    event.preventDefault();
    handler(trigger, event);
  });

  $('#modal-root').addEventListener('click', function (event) {
    const trigger = event.target.closest('[data-action]');
    if (trigger) {
      const handler = modalActions[trigger.getAttribute('data-action')];
      if (handler) { event.preventDefault(); handler(trigger, event); return; }
    }
    if (event.target.closest('[data-close]')) closeModal();
  });
}

function routeFirstLoad(openFile) {
  const go = function (hash) {
    history.replaceState(null, '', location.pathname + location.search + hash);
  };
  if (openFile) { go('#/tasks'); return; }
  const hash = location.hash;
  const atHome = !hash || hash === '#' || hash === '#/' || hash === '#/home';
  if (!atHome) return;
  if (appState.settings && !appState.settings.tmdbApiKey) {
    // 首次打开且没有 TMDB Key 时，把用户带到设置页填写；其它深链接不劫持。
    go('#/settings?focus=key');
    return;
  }
  go('#/home');
}

/* ---------------------------------------------------------------- 主题 */

const THEME_KEY = 'wanspilot.theme';
const THEMES = [['light', '白天'], ['dark', '夜间']];

/** 只认白天与夜间两态；旧数据里的 auto 按系统偏好定一次就落成确定值。 */
function themePreference() {
  let saved = null;
  try {
    saved = localStorage.getItem(THEME_KEY);
  } catch {
    saved = null;
  }
  if (saved === 'light' || saved === 'dark') return saved;
  const fromSettings = appState.settings && appState.settings.theme;
  if (fromSettings === 'light' || fromSettings === 'dark') return fromSettings;
  const prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
  return prefersLight ? 'light' : 'dark';
}

function themeLabel(pref) {
  const found = THEMES.filter(function (entry) { return entry[0] === pref; })[0];
  return found ? found[1] : '夜间';
}

function applyTheme(pref, persist) {
  const next = pref === 'light' ? 'light' : 'dark';
  const root = document.documentElement;
  root.setAttribute('data-theme', next);
  root.setAttribute('data-theme-pref', next);
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    // 隐私模式写不了本地缓存，不影响本次会话
  }
  const button = document.querySelector('[data-action="theme-toggle"]');
  if (button) {
    const sides = button.querySelectorAll('.themebtn__side');
    if (sides[0]) fill(sides[0], iconNode('sun'));
    if (sides[1]) fill(sides[1], iconNode('moon'));
    button.setAttribute('aria-checked', next === 'light' ? 'true' : 'false');
    button.setAttribute('aria-label', '当前' + themeLabel(next) + '主题，点击切换');
  }
  if (persist && appState.settings && appState.settings.theme !== next) {
    appState.settings.theme = next;
    api('/settings', { method: 'PUT', body: { theme: next } }).catch(function () {
      // 服务端保存失败只影响跨设备同步，本地已经生效
    });
  }
}

function toggleTheme() {
  const next = themePreference() === 'light' ? 'dark' : 'light';
  applyTheme(next, true);
}

async function boot() {
  bindGlobalEvents();
  const openFile = takeOpenFileParam();
  try {
    appState.settings = await api('/settings');
  } catch (error) {
    appState.settingsError = error.message;
  }
  applyTheme(themePreference(), Boolean(appState.settings && appState.settings.theme !== themePreference()));
  routeFirstLoad(openFile);
  render();
  settingsCache = appState.settings || null;
  if (appState.settings) startLive();
  if (openFile) {
    openImportDialog(openFile);
    toast('已打开导入对话框，确认后即可开始下载', 'ok');
  }
}

const VIEWS = {
  home: viewHome,
  search: viewSearch,
  detail: viewDetail,
  resources: viewResources,
  health: viewHealth,
  tasks: viewTasks,
  subscribe: viewSubscribe,
  calendar: viewCalendar,
  settings: viewSettings
};

boot();
