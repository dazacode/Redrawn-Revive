/**
 * Redrawn Studio assets panel: left sidebar with Backgrounds / Characters / Props / Text & Speech /
 * Music & Sound / Effects, a theme switcher, search, category chips, a virtualized thumbnail grid,
 * a character action/emotion picker, and click or drag-to-stage adding.
 *
 *   const panel = mountAssetsPanel(el, { store, themes, stage });  // -> { destroy }
 *
 * Optional extras (not part of the contract, all have fallbacks):
 *   opts.getThumb(assetId, kind) -> Promise<string>   override for thumbs.js `getAssetThumb`
 *   stage.clientToStage(clientX, clientY) -> {x, y}   exact drop mapping (else derived from the DOM)
 *   stage.el | stage.container                        element that accepts drops (else `.st-stage`)
 *
 * Themes API used (see themes.js): loadThemeList(), loadTheme(id), assetUrl(assetId, themeId).
 * Asset objects are read defensively (assetId|id, name, thumbUrl, tags[], category, subtype, duration,
 * actions as [{assetId,name,category}] or {category: [...]}) so small shape differences do not break browsing.
 *
 * @typedef {import('./model.js').StudioState} StudioState
 */
import { createBubble, createSound, findScene, sceneAt, STAGE_W, STAGE_H } from './model.js';

const MIME = 'application/x-redrawn-asset';
const LS = { tab: 'studio.assets.tab', scope: 'studio.assets.scope', favs: 'studio.assets.favs', recent: 'studio.assets.recent' };
const RECENT_MAX = 40;
/** Legacy movie theme ids that the server stores under another theme (see src/pack.ts). */
const THEME_ALIAS = { family: 'custom', cc2: 'action' };

const TABS = [
  { id: 'bg', label: 'Backgrounds', noun: 'backgrounds', icon: 'image', list: 'backgrounds', aspect: 'wide' },
  { id: 'char', label: 'Characters', noun: 'characters', icon: 'user', list: 'characters', aspect: 'square' },
  { id: 'prop', label: 'Props', noun: 'props', icon: 'cube', list: 'props', aspect: 'square' },
  { id: 'text', label: 'Text & Speech', noun: 'speech styles', icon: 'bubble' },
  { id: 'sound', label: 'Music & Sound', noun: 'sounds', icon: 'music', list: 'sounds', aspect: 'row' },
  { id: 'effect', label: 'Effects', noun: 'effects', icon: 'sparkle', list: 'effects', aspect: 'square' },
];
const TAB_BY_ID = Object.fromEntries(TABS.map((t) => [t.id, t]));
const ELEM_KIND = { char: 'char', prop: 'prop', effect: 'effect' };

const ICONS = {
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m4 18 5-5 4 4 3-3 4 4"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5"/>',
  cube: '<path d="M12 3 3.5 7.5v9L12 21l8.5-4.5v-9z"/><path d="M3.5 7.5 12 12l8.5-4.5M12 12v9"/>',
  bubble: '<path d="M4 5h16v11h-9l-4 4v-4H4z"/>',
  music: '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
  sparkle: '<path d="M11 3l1.9 5.6L18.5 10.5l-5.6 1.9L11 18l-1.9-5.6L3.5 10.5l5.6-1.9z"/><path d="M19 16v5M16.5 18.5h5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  back: '<path d="M19 12H5M11 5l-7 7 7 7"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  play: '<path d="M7 4.5v15l12-7.5z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  star: '<path d="m12 3.5 2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 17.2l-5.4 3 1.1-6.1-4.5-4.2 6.1-.8z"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/>',
  alert: '<path d="M12 3 2 21h20z"/><path d="M12 10v5M12 18v.01"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  replace: '<path d="M4 8h13l-3-3M20 16H7l3 3"/>',
};
const ico = (name, cls = '') => `<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[name] || ''}</svg>`;

/** Speech bubble styles offered on the Text & Speech tab. `style` is the lower-cased legacy bubble type (see FORMAT.md). */
const TAIL = (d) => `<path d="${d}"/>`;
const BUBBLES = [
  { style: 'ellipse', name: 'Speech', text: 'Hello!', hint: 'Classic oval balloon',
    svg: `${TAIL('M17 29l-5 12 15-9z')}<ellipse cx="26" cy="19" rx="21" ry="15"/>` },
  { style: 'roundrectangular', name: 'Rounded', text: 'Hello!', hint: 'Rounded box with tail',
    svg: `${TAIL('M15 31l-4 11 15-11z')}<rect x="5" y="5" width="42" height="27" rx="9"/>` },
  { style: 'rectangular', name: 'Box', text: 'Hello!', hint: 'Square box with tail',
    svg: `${TAIL('M15 31l-4 11 15-11z')}<rect x="5" y="5" width="42" height="27" rx="1.5"/>` },
  { style: 'cloud', name: 'Thought', text: 'Hmm...', hint: 'Inner thoughts',
    svg: '<circle cx="12" cy="38" r="2.6"/><circle cx="7" cy="43" r="1.6"/><path d="M14 31c-5 0-9-3-9-8 0-3 2-6 6-7 1-5 5-8 11-8 5 0 9 2 10 6 5 0 8 3 8 7 0 5-4 8-9 8z"/>' },
  { style: 'boom', name: 'Shout', text: 'Hey!', hint: 'Loud and angry',
    svg: '<path d="M26 2l5 8 9-4-2 9 9 3-8 6 6 8-10-1-1 9-7-6-7 6-1-9-10 1 6-8-8-6 9-3-2-9 9 4z"/>' },
  { style: 'heart', name: 'Heart', text: 'Aww', hint: 'Love and cuteness',
    svg: '<path d="M26 41C8 28 4 18 11 10c5-5 12-3 15 3 3-6 10-8 15-3 7 8 3 18-15 31z"/>' },
  { style: 'blank', name: 'Text only', text: 'Meanwhile...', hint: 'Plain text, no balloon',
    svg: '<path d="M8 15h36M8 23h36M8 31h22"/>' },
  { style: 'blanktail', name: 'Text + tail', text: 'Hello!', hint: 'Plain text with a pointer',
    svg: '<path d="M8 12h36M8 20h36M8 28h22"/><path d="M18 34l-3 9 11-8"/>' },
];

// ---------------------------------------------------------------------------------------------- utils

/** Tiny hyperscript. Attributes starting with "on" are skipped (use addEventListener). */
function h(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k === 'text') n.textContent = v;
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const k of kids) if (k != null && k !== false) n.append(k.nodeType ? k : document.createTextNode(String(k)));
  return n;
}
const uniq = (a) => [...new Set(a)];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const hueOf = (s) => { let x = 7; for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) % 3600; return x / 10; };
const prettify = (id) => String(id || '').replace(/\.[a-z0-9]+$/i, '').replace(/^.*\./, '').replace(/^(msp|ncc)_/i, '').replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim();
const arr = (v) => (Array.isArray(v) ? v : []);
const fmtDur = (ms) => { const s = Math.round((ms || 0) / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

function lsGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
}
function lsSet(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* storage blocked */ } }

/** Coalesce calls into one rAF. */
function rafOnce(fn) {
  let id = 0;
  const run = () => { id = 0; fn(); };
  const call = () => { if (!id) id = requestAnimationFrame(run); };
  call.cancel = () => { if (id) cancelAnimationFrame(id); id = 0; };
  return call;
}
function debounce(fn, ms) {
  let t = 0;
  const call = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  call.cancel = () => clearTimeout(t);
  return call;
}

// ---------------------------------------------------------------------------------------------- normalizing

/** Classify a sound asset as 'bgmusic' | 'sfx' | 'voice'. */
function soundKind(a) {
  const s = `${a.kind || ''} ${a.subtype || ''} ${a.type || ''} ${arr(a.tags).join(' ')}`.toLowerCase();
  if (/voice|speech|tts/.test(s)) return 'voice';
  if (/music|bgm|tribe|song|loop/.test(s)) return 'bgmusic';
  return 'sfx';
}

const visibleTag = (t) => t && !t.startsWith('_') && t.length <= 28;
function tagsOf(a) {
  const raw = Array.isArray(a.tags) ? a.tags : typeof a.tags === 'string' ? a.tags.split(',') : [];
  const out = raw.map((t) => String(t).trim()).map((t) => t.replace(/^_?cat:/i, '')).filter(Boolean);
  if (a.category) out.push(String(a.category));
  return uniq(out);
}

/** @returns {Array<{id:string,assetId:string,name:string,category:string,thumbUrl?:string}>} */
function actionsOf(c) {
  const raw = c.actions ?? c.animations ?? [];
  const out = [];
  const push = (a, cat) => {
    const assetId = a.assetId ?? a.id;
    if (!assetId) return;
    out.push({ id: String(a.id ?? assetId), assetId, name: a.name || prettify(a.id ?? assetId), category: String(a.category ?? cat ?? 'action'), thumbUrl: a.thumbUrl });
  };
  if (Array.isArray(raw)) raw.forEach((a) => push(a));
  else if (raw && typeof raw === 'object') for (const [cat, list] of Object.entries(raw)) arr(list).forEach((a) => push(a, cat));
  return out;
}

/** Wrap one theme-asset into the panel's item shape. */
function normItem(a, tab, themeId) {
  const assetId = a.assetId ?? a.id;
  const name = String(a.name || prettify(assetId));
  const tags = tagsOf(a);
  const item = {
    key: `${tab}:${assetId}`, tab, assetId, name, themeId: a.themeId ?? themeId, thumbUrl: a.thumbUrl || '',
    tags, raw: a, type: a.type ? String(a.type) : '',
  };
  if (tab === 'sound') { item.sk = soundKind(a); item.duration = Number(a.duration) || 0; }
  if (tab === 'char') {
    item.actions = actionsOf(a);
    item.defaultAction = a.defaultAction ?? a.default ?? null;
  }
  item.h = `${name} ${prettify(assetId)} ${tags.join(' ')} ${item.type}`.toLowerCase();
  return item;
}

// ---------------------------------------------------------------------------------------------- virtual list

/** Absolute-positioned, row-virtualized grid inside a scroll host. Items stay as data until in view. */
class VirtualList {
  constructor(host, { layout, create, onRendered }) {
    this.host = host;
    this.layout = layout;
    this.create = create;
    this.onRendered = onRendered;
    this.items = [];
    this.nodes = new Map();
    this.lay = { cols: 1, w: 100, h: 60, gap: 8, padX: 8, padY: 8 };
    this.active = 0;
    this.sizer = h('div', { class: 'sa-vsize' });
    host.append(this.sizer);
    this.tick = rafOnce(() => this.render());
    this.onScroll = () => this.tick();
    host.addEventListener('scroll', this.onScroll, { passive: true });
    this.ro = new ResizeObserver(() => { this.measure(true); this.tick(); });
    this.ro.observe(host);
  }

  destroy() {
    this.tick.cancel();
    this.host.removeEventListener('scroll', this.onScroll);
    this.ro.disconnect();
    this.clear();
  }

  clear() { for (const n of this.nodes.values()) n.remove(); this.nodes.clear(); }

  /** Replace the data. `keepScroll` leaves scrollTop alone (used for progressive loading). */
  setItems(items, keepScroll = false) {
    this.items = items;
    this.clear();
    if (!keepScroll) { this.host.scrollTop = 0; this.active = 0; }
    this.active = clamp(this.active, 0, Math.max(0, items.length - 1));
    this.measure(false);
    this.render();
  }

  measure(reposition) {
    const w = this.host.clientWidth;
    if (!w) return;
    const lay = this.layout(w);
    const prev = this.lay;
    this.lay = lay;
    this.rows = Math.ceil(this.items.length / lay.cols);
    this.sizer.style.height = `${this.rows ? lay.padY * 2 + this.rows * (lay.h + lay.gap) - lay.gap : 0}px`;
    if (reposition && (prev.cols !== lay.cols || prev.w !== lay.w || prev.h !== lay.h)) {
      this.clear();
    }
  }

  pos(i) {
    const { cols, w, h: ih, gap, padX, padY } = this.lay;
    return { x: padX + (i % cols) * (w + gap), y: padY + Math.floor(i / cols) * (ih + gap) };
  }

  render() {
    const { host, items, lay } = this;
    if (!host.clientHeight || !host.clientWidth) return;
    if (this.lay.w <= 0) this.measure(false);
    const rowH = lay.h + lay.gap;
    const top = host.scrollTop, vh = host.clientHeight;
    const r0 = Math.max(0, Math.floor((top - lay.padY) / rowH) - 1);
    const r1 = Math.min(Math.max(0, this.rows - 1), Math.ceil((top + vh - lay.padY) / rowH) + 1);
    const from = r0 * lay.cols, to = Math.min(items.length, (r1 + 1) * lay.cols);
    for (const [i, n] of this.nodes) if (i < from || i >= to) { n.remove(); this.nodes.delete(i); }
    for (let i = from; i < to; i++) {
      let n = this.nodes.get(i);
      if (!n) {
        n = this.create(items[i], i);
        const { x, y } = this.pos(i);
        n.style.width = `${lay.w}px`; n.style.height = `${lay.h}px`; n.style.translate = `${x}px ${y}px`;
        n.dataset.index = String(i);
        this.sizer.append(n);
        this.nodes.set(i, n);
      }
      n.tabIndex = i === this.active ? 0 : -1;
    }
    this.onRendered?.();
  }

  /** Scroll so item i is fully visible, then focus it. */
  reveal(i, focus) {
    i = clamp(i, 0, this.items.length - 1);
    this.active = i;
    const { y } = this.pos(i);
    const { h: ih, padY } = this.lay;
    const top = this.host.scrollTop, vh = this.host.clientHeight;
    if (y - padY < top) this.host.scrollTop = Math.max(0, y - padY);
    else if (y + ih + padY > top + vh) this.host.scrollTop = y + ih + padY - vh;
    this.render();
    if (focus) this.nodes.get(i)?.focus({ preventScroll: true });
  }
}

// ---------------------------------------------------------------------------------------------- catalog

/** Loads and normalizes themes lazily; caches per theme id. */
function createCatalog(themes) {
  const byTheme = new Map(); // id -> {name, lists}
  const loading = new Map(); // id -> Promise
  const failed = new Map(); // id -> Error
  const listeners = new Set();
  let themeList = null;
  let listPromise = null;
  const emit = () => listeners.forEach((fn) => fn());

  function loadList() {
    if (!listPromise) {
      listPromise = Promise.resolve(themes.loadThemeList()).then((l) => { themeList = arr(l); emit(); return themeList; })
        .catch((e) => { listPromise = null; throw e; });
    }
    return listPromise;
  }

  function load(id) {
    if (byTheme.has(id)) return Promise.resolve(byTheme.get(id));
    if (loading.has(id)) return loading.get(id);
    failed.delete(id);
    const p = Promise.resolve(themes.loadTheme(id)).then((t) => {
      const name = t?.name ?? id;
      const lists = {};
      for (const tab of TABS) if (tab.list) lists[tab.id] = arr(t?.[tab.list]).map((a) => normItem(a, tab.id, id));
      // Character-creator characters have no action files; the stage draws them from their component SWFs.
      lists.char = lists.char.filter((c) => c.actions.length > 0 || c.raw?.cc);
      const rec = { id, name, lists, ccThemeId: t?.ccThemeId };
      byTheme.set(id, rec);
      return rec;
    }).then(async (rec) => {
      // the user's own characters for this theme's character-creator theme (best effort, never blocks the theme)
      const cc = rec.ccThemeId || themeList?.find((x) => x.id === id)?.ccThemeId;
      if (cc && themes.loadUserChars) {
        const mine = await themes.loadUserChars(cc).catch(() => []);
        if (mine.length) rec.lists.char = [...mine.map((a) => normItem(a, 'char', id)), ...rec.lists.char];
      }
      return rec;
    }).catch((e) => { failed.set(id, e); return null; }).finally(() => { loading.delete(id); emit(); });
    loading.set(id, p);
    return p;
  }

  return {
    loadList, load,
    get list() { return themeList; },
    get: (id) => byTheme.get(id) || null,
    isLoading: (id) => loading.has(id),
    failed: (id) => failed.get(id) || null,
    retry: (id) => { failed.delete(id); return load(id); },
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    nameOf: (id) => byTheme.get(id)?.name ?? themeList?.find((t) => t.id === id)?.name ?? id,
  };
}

// ---------------------------------------------------------------------------------------------- search

function searchFilter(items, query) {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return items;
  const scored = [];
  for (const it of items) {
    let score = 0, ok = true;
    for (const t of tokens) {
      const i = it.h.indexOf(t);
      if (i < 0) { ok = false; break; }
      const nm = it.name.toLowerCase();
      if (nm === t) score += 6;
      else if (nm.startsWith(t)) score += 4;
      else if (i === 0 || /[\s_\-.]/.test(it.h[i - 1])) score += 2;
      else score += 1;
    }
    if (ok) scored.push([score, it]);
  }
  return scored.map((s, i) => [s[0], i, s[1]]).sort((a, b) => b[0] - a[0] || a[1] - b[1]).map((s) => s[2]);
}

// ---------------------------------------------------------------------------------------------- mount

/**
 * @param {HTMLElement} root
 * @param {{store: any, themes: any, stage?: any, getThumb?: (assetId: string, kind: string) => Promise<string>}} opts
 */
export function mountAssetsPanel(root, opts) {
  const { store, themes, stage } = opts;
  const catalog = createCatalog(themes);
  const cleanup = [];
  const on = (target, type, fn, o) => { target.addEventListener(type, fn, o); cleanup.push(() => target.removeEventListener(type, fn, o)); };
  let destroyed = false;

  // ---- state
  const initialMovieTheme = store.get().movie.themeId || 'common';
  const S = {
    tab: TAB_BY_ID[lsGet(LS.tab, 'bg')] ? lsGet(LS.tab, 'bg') : 'bg',
    themeId: initialMovieTheme,
    movieTheme: initialMovieTheme,
    scope: ['theme', 'both', 'all'].includes(lsGet(LS.scope, 'both')) ? lsGet(LS.scope, 'both') : 'both',
    query: '',
    chip: {}, // tab -> chip id
    favs: new Set(arr(lsGet(LS.favs, []))),
    recent: arr(lsGet(LS.recent, [])),
    detail: null, // char picker {item, sel:{action,emotion}, cat}
    items: [],
    base: [],
    status: '', // aria-live
  };

  // ---- DOM skeleton
  root.classList.add('sa-root');
  root.innerHTML = '';
  const themeBtn = h('button', { class: 'sa-theme-btn', type: 'button', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-label': 'Theme' });
  const searchInput = h('input', { class: 'sa-search-input', type: 'search', placeholder: 'Search backgrounds', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Search assets' });
  const clearBtn = h('button', { class: 'sa-search-clear', type: 'button', 'aria-label': 'Clear search', hidden: true, html: ico('x') });
  const tabsEl = h('div', { class: 'sa-tabs', role: 'tablist', 'aria-label': 'Asset types' });
  const chipsEl = h('div', { class: 'sa-chips', role: 'toolbar', 'aria-label': 'Filters' });
  const headCount = h('span', { class: 'sa-count tnum' });
  const headTitle = h('h2', { class: 'sa-title' });
  const scroll = h('div', { class: 'sa-scroll', role: 'listbox', tabindex: '-1', 'aria-label': 'Assets' });
  const overlay = h('div', { class: 'sa-state', hidden: true });
  const loadBar = h('div', { class: 'sa-loadbar', hidden: true, role: 'progressbar', 'aria-label': 'Loading themes' });
  const live = h('div', { class: 'sa-sr', 'aria-live': 'polite', role: 'status' });
  const toastEl = h('div', { class: 'sa-added', 'aria-hidden': 'true' });
  const detailEl = h('div', { class: 'sa-detail', hidden: true });
  const main = h('div', { class: 'sa-main' },
    h('div', { class: 'sa-head' },
      themeBtn,
      h('div', { class: 'sa-search' }, h('span', { class: 'sa-search-ico', html: ico('search') }), searchInput, clearBtn),
    ),
    tabsEl,
    h('div', { class: 'sa-subhead' }, headTitle, headCount),
    chipsEl,
    h('div', { class: 'sa-body' }, scroll, overlay, loadBar, toastEl),
  );
  root.append(main, detailEl, live);

  for (const t of TABS) {
    const b = h('button', { class: 'sa-tab', type: 'button', role: 'tab', id: `sa-tab-${t.id}`, 'data-tab': t.id, title: t.label, 'aria-label': t.label, html: ico(t.icon) });
    tabsEl.append(b);
  }

  // ---- thumbs
  const thumbCache = new Map(); // key -> Promise<string>|string
  let thumbsMod = null;
  let thumbsTried = false;
  async function getThumbFn() {
    if (opts.getThumb) return opts.getThumb;
    if (!thumbsTried) {
      thumbsTried = true;
      try { thumbsMod = await import('./thumbs.js'); } catch { thumbsMod = null; }
    }
    return thumbsMod?.getAssetThumb || null;
  }
  /** Resolve a displayable URL for an asset; never rejects (resolves '' when unavailable). */
  function resolveThumb(cacheKey, assetId, kind, direct, themeId) {
    if (thumbCache.has(cacheKey)) return Promise.resolve(thumbCache.get(cacheKey));
    const p = (async () => {
      if (direct) return direct;
      const fn = await getThumbFn();
      if (!fn) return '';
      try { return (await fn(assetId, kind, { themeId })) || ''; } catch { return ''; }
    })().then((u) => { thumbCache.set(cacheKey, u); return u; });
    thumbCache.set(cacheKey, p);
    return p;
  }

  // Bounded, visibility-aware thumbnail pump: only nodes still on screen are served.
  const thumbQueue = new Set();
  let thumbActive = 0;
  const THUMB_PARALLEL = 4;
  const pumpThumbs = () => {
    while (thumbActive < THUMB_PARALLEL && thumbQueue.size) {
      const node = thumbQueue.values().next().value;
      thumbQueue.delete(node);
      if (!node.isConnected) continue;
      thumbActive++;
      const { cacheKey, assetId, kind, direct, themeId } = node._thumb;
      node._thumb.state = 'loading';
      resolveThumb(cacheKey, assetId, kind, direct, themeId).then((url) => {
        if (destroyed) return;
        applyThumb(node, url, cacheKey);
      }).finally(() => { thumbActive--; pumpThumbs(); });
    }
  };
  function applyThumb(node, url, cacheKey) {
    if (!node._thumb || node._thumb.cacheKey !== cacheKey) return;
    const img = node.querySelector('img');
    if (!img) return;
    if (!url) { node._thumb.state = 'none'; node.classList.add('is-nothumb'); node.classList.remove('is-loading'); return; }
    img.onload = () => { node._thumb.state = 'done'; node.classList.remove('is-loading'); node.classList.add('has-thumb'); };
    img.onerror = () => {
      if (node._thumb.direct && !node._thumb.retried) {
        // Fall back from a missing sibling image to a rendered frame.
        node._thumb.retried = true; node._thumb.direct = '';
        thumbCache.delete(cacheKey);
        node._thumb.state = 'queued'; thumbQueue.add(node); pumpThumbs();
      } else { node._thumb.state = 'none'; node.classList.add('is-nothumb'); node.classList.remove('is-loading'); }
    };
    img.src = url;
  }
  /** Attach lazy-thumb metadata to a freshly created tile. */
  function bindThumb(node, { cacheKey, assetId, kind, direct, themeId }) {
    node._thumb = { cacheKey, assetId, kind, direct: direct || '', themeId, state: 'idle' };
    node.classList.add('is-loading');
    const cached = thumbCache.get(cacheKey);
    if (typeof cached === 'string') { applyThumb(node, cached, cacheKey); node._thumb.state = 'queued'; }
  }
  /** Called after each virtual render: request thumbs for what is on screen (debounced against fast scrolling). */
  const requestVisibleThumbs = debounce(() => {
    if (destroyed) return;
    for (const node of vlist.nodes.values()) {
      const t = node._thumb;
      if (t && t.state === 'idle') { t.state = 'queued'; thumbQueue.add(node); }
    }
    pumpThumbs();
  }, 70);

  // ---- tiles
  const favKey = (it) => it.key;
  function placeholderStyle(it) {
    const hue = hueOf(it.assetId);
    return `--ph-h:${hue}`;
  }
  function tileFor(it) {
    const tab = TAB_BY_ID[it.tab];
    if (tab.aspect === 'row') return soundRow(it);
    const wide = tab.aspect === 'wide';
    const img = h('img', { alt: '', decoding: 'async', draggable: 'false' });
    const star = h('button', { class: 'sa-star', type: 'button', tabindex: '-1', 'aria-label': 'Star', 'aria-pressed': S.favs.has(favKey(it)) ? 'true' : 'false', html: ico('star') });
    const node = h('div', {
      class: `sa-tile ${wide ? 'is-wide' : 'is-square'}`, role: 'option', draggable: 'true',
      'aria-selected': 'false', title: it.name, style: placeholderStyle(it), 'data-key': it.key,
    },
      h('div', { class: 'sa-thumb' }, img, h('span', { class: 'sa-ph', 'aria-hidden': 'true', html: ico(tab.icon) })),
      h('span', { class: 'sa-label' }, it.name),
      star,
      it.tab === 'char' && it.actions.length ? h('span', { class: 'sa-badge', title: `${it.actions.length} actions and emotions` }, String(it.actions.length)) : null,
      it.tab === 'char' ? h('button', { class: 'sa-quick', type: 'button', tabindex: '-1', 'aria-label': `Add ${it.name} to scene`, title: 'Add with default pose', html: ico('plus') }) : null,
    );
    node._item = it;
    syncTileState(node);
    // Image thumbs (jpg/png beside the SWF) are used as is; a swf thumb (stateful props) is rendered instead of the asset id.
    const isImg = /\.(jpe?g|png|gif|webp|svg)(\?|$)/i.test(it.thumbUrl);
    const direct = isImg ? it.thumbUrl : '';
    let assetId = it.assetId;
    if (!isImg && it.thumbUrl && /\.swf(\?|$)/i.test(it.thumbUrl)) {
      try { assetId = `${it.themeId}.${decodeURIComponent(it.thumbUrl.split('/').pop().split('?')[0])}`; } catch { /* keep */ }
    }
    bindThumb(node, { cacheKey: `${it.tab}|${assetId}|${direct}`, assetId, kind: it.tab, direct, themeId: it.themeId });
    return node;
  }

  function soundRow(it) {
    const playBtn = h('button', { class: 'sa-play', type: 'button', tabindex: '-1', 'aria-label': `Preview ${it.name}`, html: ico('play') });
    const addBtn = h('button', { class: 'sa-add', type: 'button', tabindex: '-1', 'aria-label': `Add ${it.name} to movie`, html: ico('plus') });
    const kindLabel = it.sk === 'bgmusic' ? 'Music' : it.sk === 'voice' ? 'Voice' : 'Effect';
    const node = h('div', {
      class: 'sa-row', role: 'option', draggable: 'true', 'aria-selected': 'false', title: it.name, 'data-key': it.key,
      style: placeholderStyle(it),
    },
      playBtn,
      h('div', { class: 'sa-row-main' },
        h('span', { class: 'sa-row-name' }, it.name),
        h('span', { class: 'sa-row-meta' }, h('span', { class: `sa-kind k-${it.sk}` }, kindLabel), it.duration ? h('span', { class: 'tnum' }, fmtDur(it.duration)) : null),
      ),
      addBtn,
    );
    node._item = it;
    syncTileState(node);
    return node;
  }

  function syncTileState(node) {
    const it = node._item;
    if (!it) return;
    const st = store.get();
    const scene = currentScene(st);
    const current = it.tab === 'bg' && scene?.bg?.assetId === it.assetId;
    node.classList.toggle('is-current', !!current);
    node.setAttribute('aria-selected', current ? 'true' : 'false');
    const star = node.querySelector('.sa-star');
    if (star) {
      const on = S.favs.has(favKey(it));
      star.setAttribute('aria-pressed', on ? 'true' : 'false');
      node.classList.toggle('is-fav', on);
    }
    if (it.tab === 'sound') {
      const playing = audioState.key === it.key && audioState.playing;
      node.classList.toggle('is-playing', playing);
      const pb = node.querySelector('.sa-play');
      if (pb) { pb.innerHTML = ico(playing ? 'pause' : 'play'); pb.disabled = audioState.bad.has(it.key); pb.title = pb.disabled ? 'Preview unavailable for this sound' : playing ? 'Stop preview' : 'Preview'; }
    }
  }
  const syncAllTiles = rafOnce(() => { for (const n of vlist.nodes.values()) syncTileState(n); });

  // ---- virtual list
  const vlist = new VirtualList(scroll, {
    layout(w) {
      const tab = TAB_BY_ID[S.tab];
      const padX = 10, padY = 10, gap = 8;
      const inner = w - padX * 2;
      if (tab.aspect === 'row') return { cols: 1, w: inner, h: 52, gap: 4, padX, padY };
      const min = tab.aspect === 'wide' ? 104 : 78;
      const cols = Math.max(tab.aspect === 'wide' ? 1 : 2, Math.floor((inner + gap) / (min + gap)));
      const cw = Math.floor((inner - gap * (cols - 1)) / cols);
      const thumbH = tab.aspect === 'wide' ? Math.round(cw * 9 / 16) : cw;
      return { cols, w: cw, h: thumbH + 24, gap, padX, padY };
    },
    create: (it) => tileFor(it),
    onRendered: () => requestVisibleThumbs(),
  });
  cleanup.push(() => vlist.destroy());

  // ---- scene / selection helpers
  function currentScene(st = store.get()) {
    const m = st.movie;
    return findScene(m, st.selection?.sceneId) || sceneAt(m, st.playhead || 0)?.scene || m.scenes[0] || null;
  }
  function selectedChar(st = store.get()) {
    const sc = currentScene(st);
    if (!sc || st.selection?.kind !== 'char') return null;
    return sc.chars.find((c) => c.id === st.selection.elemId) || null;
  }
  const announce = (msg) => { live.textContent = ''; setTimeout(() => { live.textContent = msg; }, 20); };
  let toastTimer = 0;
  function flash(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('is-on');
    announce(msg);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('is-on'), 1800);
  }

  function pushRecent(it) {
    S.recent = [it.key, ...S.recent.filter((k) => k !== it.key)].slice(0, RECENT_MAX);
    lsSet(LS.recent, S.recent);
  }

  // ---- adding
  /** Add an asset to the current scene. `pos` is stage px; `extra` carries char {action, emotion}. */
  function addItem(it, pos, extra) {
    const st = store.get();
    const scene = currentScene(st);
    if (!scene) return;
    const sceneId = scene.id;
    if (it.tab === 'bg') {
      const comp = arr(it.raw?.composite?.props);
      if (comp.length) {
        // Composite backgrounds (a bg plus positioned props, e.g. "Court") expand into the bg and its props.
        const cmds = [{ type: 'setBackground', sceneId, assetId: it.assetId }];
        for (const p of comp) {
          cmds.push({ type: 'addElem', sceneId, kind: 'prop', assetId: p.assetId, x: p.x, y: p.y, elem: { scale: p.scale, flip: !!p.flip, rotation: p.rotation || 0 } });
        }
        store.dispatch({ type: 'batch', cmds });
        flash(`Background set: ${it.name} (+${comp.length} prop${comp.length > 1 ? 's' : ''})`);
      } else {
        store.dispatch({ type: 'setBackground', sceneId, assetId: it.assetId });
        flash(`Background set: ${it.name}`);
      }
    } else if (it.tab === 'sound') {
      const start = Math.max(0, Math.round(st.playhead || 0));
      const len = it.duration || (it.sk === 'bgmusic' ? 30000 : 1500);
      store.dispatch({ type: 'addSound', sound: createSound({ kind: it.sk, assetId: it.assetId, start, end: start + len, volume: it.sk === 'bgmusic' ? 0.6 : 1 }) });
      flash(`Added to timeline: ${it.name}`);
    } else {
      const kind = ELEM_KIND[it.tab];
      const cmd = { type: 'addElem', sceneId, kind, assetId: it.assetId };
      if (pos) { cmd.x = Math.round(pos.x); cmd.y = Math.round(pos.y); }
      else if (it.tab === 'char') {
        // Fan out new characters along the floor so repeated clicks do not stack them.
        const n = scene.chars.length;
        cmd.x = Math.round(clamp(STAGE_W / 2 + (n % 2 ? 1 : -1) * Math.ceil(n / 2) * 95, 60, STAGE_W - 60));
        cmd.y = Math.round(STAGE_H * 0.85);
      }
      const patch = {};
      if (extra?.action) patch.action = extra.action;
      if (extra?.emotion) patch.emotion = extra.emotion;
      if (Object.keys(patch).length) cmd.elem = patch;
      store.dispatch(cmd);
      flash(`Added to scene: ${it.name}${extra?.label ? ` (${extra.label})` : ''}`);
    }
    pushRecent(it);
    syncAllTiles();
  }

  function addBubbleStyle(b, pos) {
    const st = store.get();
    const scene = currentScene(st);
    if (!scene) return;
    let target = null;
    if (pos && stage?.hitTest) { try { const hit = stage.hitTest(pos.x, pos.y); if (hit?.kind === 'char') target = hit.elemId; } catch { /* ignore */ } }
    if (!target) target = selectedChar(st)?.id || scene.chars[scene.chars.length - 1]?.id || null;
    const startMs = Math.max(0, Math.min(scene.duration - 500, Math.round(sceneAt(st.movie, st.playhead || 0)?.local || 0)));
    const bubble = createBubble({
      text: b.text, style: b.style, x: Math.round(pos?.x ?? STAGE_W / 2), y: Math.round(pos?.y ?? 70),
      targetId: target || undefined, start: startMs, end: Math.min(scene.duration, startMs + 2500),
    });
    store.dispatch({ type: 'addBubble', sceneId: scene.id, bubble });
    flash(`Added ${b.name.toLowerCase()} bubble`);
  }

  // ---- derived items
  function sourceIds() {
    if (S.scope === 'all') return uniq([S.themeId, ...arr(catalog.list).map((t) => t.id)]);
    if (S.scope === 'both') return uniq([S.themeId, 'common']);
    return [S.themeId];
  }
  const STOP = new Set(['the', 'and', 'for', 'with', 'swf', 'png', 'jpg', 'mp3', 'msp', 'ncc', 'new', 'old', 'big', 'small', 'bg', 'prop', 'common', 'version', 'sound', 'music']);
  function chipDefs(tab, items) {
    const chips = [];
    const add = (id, label, test) => { const n = items.reduce((c, i) => c + (test(i) ? 1 : 0), 0); if (n > 0 && n < items.length) chips.push({ id, label, test }); };
    if (tab === 'sound') {
      add('k:bgmusic', 'Music', (i) => i.sk === 'bgmusic');
      add('k:sfx', 'Effects', (i) => i.sk === 'sfx');
      add('k:voice', 'Voice', (i) => i.sk === 'voice');
    } else if (tab === 'bg') add('s:comp', 'With props', (i) => arr(i.raw?.composite?.props).length > 0);
    else if (tab === 'prop') {
      add('s:hold', 'Holdable', (i) => !!i.raw?.holdable);
      add('s:wear', 'Wearable', (i) => !!i.raw?.wearable);
    } else if (tab === 'effect') {
      for (const ty of uniq(items.map((i) => i.type).filter(Boolean)).slice(0, 6)) add(`e:${ty}`, ty.charAt(0) + ty.slice(1).toLowerCase(), (i) => i.type === ty);
    }
    // Keyword chips: the most common words in asset names ("office", "street", ...), skipping noise and theme names.
    const themeWords = new Set();
    for (const it of items) { themeWords.add(String(it.themeId).toLowerCase()); }
    for (const t of arr(catalog.list)) String(t.name || '').toLowerCase().split(/[^a-z0-9]+/).forEach((w) => themeWords.add(w));
    const freq = new Map();
    for (const it of items) for (const t of it.tags) {
      const w = String(t).toLowerCase();
      if (!visibleTag(t) || w.length < 4 || /\d/.test(w) || STOP.has(w) || themeWords.has(w)) continue;
      freq.set(w, (freq.get(w) || 0) + 1);
    }
    const min = Math.max(3, Math.round(items.length * 0.012));
    const top = [...freq].filter(([, n]) => n >= min && n < items.length * 0.6).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 14);
    for (const [w] of top) chips.push({ id: `t:${w}`, label: w.replace(/^\w/, (c) => c.toUpperCase()), test: (i) => i.tags.some((t) => String(t).toLowerCase() === w) });
    return chips;
  }

  let chipList = [];
  function recompute() {
    const tab = TAB_BY_ID[S.tab];
    if (!tab.list) { S.items = []; S.base = []; return; }
    const ids = sourceIds();
    let base = [];
    for (const id of ids) { const rec = catalog.get(id); if (rec) base = base.concat(rec.lists[S.tab]); }
    S.base = base;
    chipList = chipDefs(S.tab, base);
    const extras = [];
    if (S.recent.some((k) => k.startsWith(`${S.tab}:`))) extras.push({ id: 'recent', label: 'Recent', icon: 'clock' });
    if (base.some((i) => S.favs.has(favKey(i)))) extras.push({ id: 'fav', label: 'Starred', icon: 'star' });
    chipList = [...extras, ...chipList];
    let chip = S.chip[S.tab] || 'all';
    if (chip !== 'all' && !chipList.some((c) => c.id === chip)) chip = 'all';
    S.chip[S.tab] = chip;
    let items = base;
    if (chip === 'recent') {
      const order = new Map(S.recent.map((k, i) => [k, i]));
      items = base.filter((i) => order.has(i.key)).sort((a, b) => order.get(a.key) - order.get(b.key));
    } else if (chip === 'fav') items = base.filter((i) => S.favs.has(favKey(i)));
    else if (chip !== 'all') items = base.filter(chipList.find((c) => c.id === chip).test);
    if (S.query.trim()) items = searchFilter(items, S.query);
    // Stars first inside the unfiltered browse view, so favorites are always within reach.
    S.items = items;
  }

  // ---- rendering
  function render(opts2 = {}) {
    if (destroyed) return;
    const tab = TAB_BY_ID[S.tab];
    recompute();
    // tabs
    for (const b of tabsEl.children) {
      const on = b.dataset.tab === S.tab;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    }
    scroll.setAttribute('aria-labelledby', `sa-tab-${S.tab}`);
    headTitle.textContent = tab.label;
    searchInput.placeholder = tab.id === 'text' ? 'Search speech styles' : `Search ${tab.noun}`;
    clearBtn.hidden = !S.query;
    renderThemeBtn();
    main.dataset.tab = S.tab;
    root.dataset.tab = S.tab;

    if (tab.id === 'text') { renderTextTab(); return; }
    scroll.hidden = false;
    textEl.hidden = true;

    // chips
    chipsEl.hidden = !chipList.length;
    chipsEl.replaceChildren(
      ...(chipList.length ? [chipBtn({ id: 'all', label: 'All' }), ...chipList.map(chipBtn)] : []),
    );

    // load state / empty state
    const ids = sourceIds();
    const pending = ids.filter((id) => catalog.isLoading(id) || (!catalog.get(id) && !catalog.failed(id)));
    const failedIds = ids.filter((id) => catalog.failed(id));
    const firstLoading = !S.base.length && pending.length;
    loadBar.hidden = !(pending.length && S.base.length);
    if (!loadBar.hidden) {
      loadBar.style.setProperty('--p', String((ids.length - pending.length) / ids.length));
      loadBar.title = `Loading themes (${ids.length - pending.length}/${ids.length})`;
    }
    headCount.textContent = firstLoading ? '' : `${S.items.length.toLocaleString()}${S.query || S.chip[S.tab] !== 'all' ? ` of ${S.base.length.toLocaleString()}` : ''}`;

    if (firstLoading) showSkeleton(tab);
    else if (!S.items.length) showEmpty(tab, failedIds);
    else { overlay.hidden = true; overlay.replaceChildren(); }

    if (S.items.length || !firstLoading) {
      scroll.classList.toggle('is-hidden', !S.items.length);
      vlist.setItems(S.items, !!opts2.keepScroll);
    } else {
      vlist.setItems([], false);
    }
  }

  const textEl = h('div', { class: 'sa-text', hidden: true });
  scroll.after(textEl);
  function renderTextTab() {
    chipsEl.hidden = true;
    scroll.hidden = true;
    overlay.hidden = true;
    loadBar.hidden = true;
    textEl.hidden = false;
    headCount.textContent = String(BUBBLES.length);
    const q = S.query.trim().toLowerCase();
    const list = BUBBLES.filter((b) => !q || `${b.name} ${b.style} ${b.hint}`.toLowerCase().includes(q));
    textEl.replaceChildren(
      h('p', { class: 'sa-text-hint' }, 'Click or drag a style onto a character. The bubble follows the character it is attached to.'),
      h('div', { class: 'sa-bubbles' }, ...list.map((b) => {
        const node = h('button', { class: 'sa-bubble', type: 'button', draggable: 'true', 'data-style': b.style, title: b.hint },
          h('span', { class: 'sa-bubble-art', html: `<svg viewBox="0 0 52 46" aria-hidden="true">${b.svg}</svg>` }),
          h('span', { class: 'sa-bubble-name' }, b.name),
          h('span', { class: 'sa-bubble-hint' }, b.hint),
        );
        node._bubble = b;
        return node;
      })),
      ...(list.length ? [] : [h('p', { class: 'sa-text-hint' }, 'No speech style matches your search.')]),
    );
  }

  function chipBtn(c) {
    const on = (S.chip[S.tab] || 'all') === c.id;
    return h('button', { class: 'sa-chip', type: 'button', 'data-chip': c.id, 'aria-pressed': on ? 'true' : 'false' }, c.icon ? h('span', { class: 'sa-chip-ico', html: ico(c.icon) }) : null, c.label);
  }

  function showSkeleton(tab) {
    overlay.hidden = false;
    overlay.className = 'sa-state is-skeleton';
    const wide = tab.aspect === 'wide', row = tab.aspect === 'row';
    const n = row ? 9 : wide ? 8 : 12;
    overlay.replaceChildren(h('div', { class: `sa-skel ${row ? 'is-row' : wide ? 'is-wide' : 'is-square'}`, 'aria-hidden': 'true' },
      ...Array.from({ length: n }, () => h('div', { class: 'sa-skel-tile' }, h('div', { class: 'skeleton sa-skel-img' }), h('div', { class: 'skeleton sa-skel-txt' })))));
    scroll.classList.add('is-hidden');
  }

  function showEmpty(tab, failedIds) {
    overlay.hidden = false;
    overlay.className = 'sa-state';
    scroll.classList.add('is-hidden');
    const frag = [];
    if (failedIds.length && !S.base.length) {
      frag.push(h('span', { class: 'sa-state-ico is-error', html: ico('alert') }), h('h3', null, 'Could not load this theme'),
        h('p', null, 'The theme data failed to load. Check your connection and try again.'));
      const retry = h('button', { class: 'btn btn-sm btn-primary', type: 'button' }, 'Try again');
      retry.addEventListener('click', () => { failedIds.forEach((id) => catalog.retry(id)); render(); });
      frag.push(retry);
    } else if (S.query || (S.chip[S.tab] && S.chip[S.tab] !== 'all')) {
      frag.push(h('span', { class: 'sa-state-ico', html: ico('search') }), h('h3', null, S.query ? `No ${tab.noun} match "${S.query}"` : `Nothing in this filter`),
        h('p', null, S.scope !== 'all' ? 'Try another word, or search all themes.' : 'Try another word or clear the filter.'));
      const row = h('div', { class: 'sa-state-actions' });
      const clear = h('button', { class: 'btn btn-sm', type: 'button' }, 'Clear filters');
      clear.addEventListener('click', () => { S.query = ''; searchInput.value = ''; S.chip[S.tab] = 'all'; render(); });
      row.append(clear);
      if (S.scope !== 'all') {
        const all = h('button', { class: 'btn btn-sm btn-primary', type: 'button' }, 'Search all themes');
        all.addEventListener('click', () => setScope('all'));
        row.append(all);
      }
      frag.push(row);
    } else {
      frag.push(h('span', { class: 'sa-state-ico', html: ico(tab.icon) }), h('h3', null, `No ${tab.noun} in ${catalog.nameOf(S.themeId)}`));
      frag.push(h('p', null, S.scope === 'theme' ? 'Include Common assets or browse all themes to find more.' : 'This theme does not ship any. Try another theme.'));
      if (S.scope === 'theme') {
        const b = h('button', { class: 'btn btn-sm btn-primary', type: 'button' }, 'Include Common');
        b.addEventListener('click', () => setScope('both'));
        frag.push(b);
      }
    }
    overlay.replaceChildren(...frag);
  }

  // ---- theme switcher (popover)
  function renderThemeBtn() {
    const name = catalog.nameOf(S.themeId);
    const scopeText = S.scope === 'all' ? 'All themes' : S.scope === 'both' && S.themeId !== 'common' ? '+ Common' : '';
    themeBtn.replaceChildren(
      h('span', { class: 'sa-theme-dot', style: `--ph-h:${hueOf(S.themeId)}`, 'aria-hidden': 'true' }),
      h('span', { class: 'sa-theme-text' }, h('span', { class: 'sa-theme-label' }, 'Theme'), h('span', { class: 'sa-theme-name' }, h('span', { class: 'sa-theme-nm' }, name), scopeText ? h('span', { class: 'sa-theme-scope' }, scopeText) : null)),
      h('span', { class: 'sa-chev', html: ico('chevron') }),
    );
  }

  let pop = null;
  function openThemeMenu() {
    if (pop) return closeThemeMenu(true);
    themeBtn.setAttribute('aria-expanded', 'true');
    const search = h('input', { class: 'sa-pop-search', type: 'search', placeholder: 'Find a theme', 'aria-label': 'Find a theme', autocomplete: 'off', spellcheck: 'false' });
    const list = h('div', { class: 'sa-pop-list', role: 'listbox', 'aria-label': 'Themes' });
    const scopeBox = h('div', { class: 'sa-scope', role: 'radiogroup', 'aria-label': 'Which assets to show' });
    const scopes = [['theme', 'Theme', 'Only the selected theme'], ['both', '+ Common', 'The selected theme plus shared Common assets'], ['all', 'All', 'Every theme (search across everything)']];
    const scopeBtns = scopes.map(([id, label, tip]) => {
      const btn = h('button', { class: 'sa-scope-btn', type: 'button', role: 'radio', title: tip, 'data-scope': id }, label);
      btn.addEventListener('click', () => { setScope(id); drawScope(); });
      return btn;
    });
    scopeBox.append(...scopeBtns);
    const drawScope = () => scopeBtns.forEach((btn) => btn.setAttribute('aria-checked', btn.dataset.scope === S.scope ? 'true' : 'false'));
    drawScope();
    pop = h('div', { class: 'sa-pop' }, search, list, scopeBox);
    themeBtn.after(pop);
    let activeIdx = 0;
    let shown = [];
    const draw = () => {
      const q = search.value.trim().toLowerCase();
      const all = arr(catalog.list);
      shown = all.filter((t) => !q || `${t.name} ${t.id}`.toLowerCase().includes(q));
      // movie theme first, common last-but-pinned
      shown.sort((a, b) => (b.id === S.movieTheme) - (a.id === S.movieTheme));
      activeIdx = Math.max(0, shown.findIndex((t) => t.id === S.themeId));
      list.replaceChildren(...(shown.length ? shown.map((t, i) => {
        const o = h('button', { class: 'sa-pop-item', type: 'button', role: 'option', 'aria-selected': t.id === S.themeId ? 'true' : 'false', 'data-id': t.id, tabindex: '-1' },
          h('span', { class: 'sa-theme-dot', style: `--ph-h:${hueOf(t.id)}`, 'aria-hidden': 'true' }),
          h('span', { class: 'sa-pop-name' }, t.name || t.id),
          t.id === S.movieTheme ? h('span', { class: 'sa-pop-tag' }, 'Movie') : null,
          t.id === S.themeId ? h('span', { class: 'sa-pop-check', html: ico('check') }) : null,
        );
        o.addEventListener('click', () => { setTheme(t.id); closeThemeMenu(true); });
        o.addEventListener('mousemove', () => setActive(i, false));
        return o;
      }) : [h('div', { class: 'sa-pop-empty' }, catalog.list ? 'No themes found' : 'Loading themes...')]));
      setActive(activeIdx, true);
    };
    const setActive = (i, scrollTo) => {
      activeIdx = clamp(i, 0, Math.max(0, shown.length - 1));
      [...list.children].forEach((c, j) => c.classList.toggle('is-active', j === activeIdx));
      if (scrollTo) list.children[activeIdx]?.scrollIntoView({ block: 'nearest' });
    };
    draw();
    catalog.loadList().then(() => { if (pop) draw(); }).catch(() => { list.replaceChildren(h('div', { class: 'sa-pop-empty' }, 'Could not load the theme list')); });
    search.addEventListener('input', draw);
    pop.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive(activeIdx + 1, true); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(activeIdx - 1, true); }
      else if (e.key === 'Enter' && e.target === search) { e.preventDefault(); const t = shown[activeIdx]; if (t) { setTheme(t.id); closeThemeMenu(true); } }
      else if (e.key === 'Escape') { e.stopPropagation(); closeThemeMenu(true); }
    });
    const outside = (e) => { if (pop && !pop.contains(e.target) && !themeBtn.contains(e.target)) closeThemeMenu(false); };
    setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
    pop._outside = outside;
    search.focus();
  }
  function closeThemeMenu(refocus) {
    if (!pop) return;
    document.removeEventListener('pointerdown', pop._outside, true);
    pop.remove();
    pop = null;
    themeBtn.setAttribute('aria-expanded', 'false');
    if (refocus) themeBtn.focus();
  }
  cleanup.push(() => closeThemeMenu(false));

  function ensureLoaded() {
    const ids = sourceIds();
    const todo = ids.filter((id) => !catalog.get(id) && !catalog.isLoading(id) && !catalog.failed(id));
    // Browsed theme first, then the rest with small concurrency to stay polite on the server.
    if (S.scope === 'all') {
      const queue = [...todo];
      const worker = async () => { while (queue.length) await catalog.load(queue.shift()); };
      for (let i = 0; i < 3; i++) worker();
    } else todo.forEach((id) => catalog.load(id));
  }
  const rerender = rafOnce(() => render({ keepScroll: true }));
  cleanup.push(catalog.subscribe(() => { rerender(); }));

  function setTheme(id) {
    if (id === S.themeId) return;
    S.themeId = id;
    S.chip = {};
    ensureLoaded();
    render();
  }
  function setScope(scope) {
    S.scope = scope;
    lsSet(LS.scope, scope);
    ensureLoaded();
    render();
  }
  function setTab(id) {
    if (!TAB_BY_ID[id]) return;
    closeDetail();
    S.tab = id;
    lsSet(LS.tab, id);
    render();
  }

  // ---- events: tabs, search, chips
  on(tabsEl, 'click', (e) => { const b = e.target.closest('.sa-tab'); if (b) setTab(b.dataset.tab); });
  on(tabsEl, 'keydown', (e) => {
    const i = TABS.findIndex((t) => t.id === S.tab);
    let n = -1;
    if (e.key === 'ArrowRight') n = (i + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') n = (i + TABS.length - 1) % TABS.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = TABS.length - 1;
    if (n >= 0) { e.preventDefault(); setTab(TABS[n].id); tabsEl.children[n].focus(); }
  });
  on(themeBtn, 'click', openThemeMenu);
  on(themeBtn, 'keydown', (e) => { if (e.key === 'ArrowDown' && !pop) { e.preventDefault(); openThemeMenu(); } });

  const applySearch = debounce(() => { S.query = searchInput.value; render(); }, 90);
  on(searchInput, 'input', () => { clearBtn.hidden = !searchInput.value; applySearch(); });
  on(searchInput, 'keydown', (e) => {
    if (e.key === 'Escape' && searchInput.value) { e.preventDefault(); e.stopPropagation(); searchInput.value = ''; S.query = ''; render(); }
    else if (e.key === 'ArrowDown' && S.items.length) { e.preventDefault(); vlist.reveal(vlist.active, true); }
    else if (e.key === 'Enter' && S.items.length && TAB_BY_ID[S.tab].list) { activate(S.items[0]); }
  });
  on(clearBtn, 'click', () => { searchInput.value = ''; S.query = ''; render(); searchInput.focus(); });
  on(chipsEl, 'click', (e) => {
    const b = e.target.closest('.sa-chip');
    if (!b) return;
    S.chip[S.tab] = b.dataset.chip;
    render();
  });

  // ---- grid interaction
  const itemOf = (t) => t.closest('[data-key]')?._item || null;
  function activate(it) {
    if (it.tab === 'char' && it.actions.length > 1) openDetail(it);
    else addItem(it);
  }
  on(scroll, 'click', (e) => {
    const node = e.target.closest('[data-key]');
    if (!node) return;
    const it = node._item;
    vlist.active = Number(node.dataset.index);
    if (e.target.closest('.sa-star')) {
      const k = favKey(it);
      if (S.favs.has(k)) S.favs.delete(k); else S.favs.add(k);
      lsSet(LS.favs, [...S.favs]);
      syncTileState(node);
      announce(S.favs.has(k) ? `Starred ${it.name}` : `Unstarred ${it.name}`);
      if (S.chip[S.tab] === 'fav') render({ keepScroll: true });
      return;
    }
    if (e.target.closest('.sa-quick')) { addItem(it); return; }
    if (it.tab === 'sound') {
      if (e.target.closest('.sa-play')) { togglePreview(it); return; }
      addItem(it);
      return;
    }
    activate(it);
  });
  on(scroll, 'keydown', (e) => {
    const node = e.target.closest?.('[data-key]');
    if (!node) return;
    const i = Number(node.dataset.index), cols = vlist.lay.cols, n = S.items.length;
    let t = -1;
    switch (e.key) {
      case 'ArrowRight': t = i + 1; break;
      case 'ArrowLeft': t = i - 1; break;
      case 'ArrowDown': t = i + cols; break;
      case 'ArrowUp': t = i - cols; break;
      case 'Home': t = 0; break;
      case 'End': t = n - 1; break;
      case 'PageDown': t = i + cols * Math.max(1, Math.floor(scroll.clientHeight / (vlist.lay.h + vlist.lay.gap)) - 1); break;
      case 'PageUp': t = i - cols * Math.max(1, Math.floor(scroll.clientHeight / (vlist.lay.h + vlist.lay.gap)) - 1); break;
      case 'Enter': case ' ': e.preventDefault(); activate(node._item); return;
      case 'f': case 'F': case 's': case 'S': if (!e.ctrlKey && !e.metaKey) { node.querySelector('.sa-star')?.click(); } return;
      case 'a': case 'A': if (!e.ctrlKey && !e.metaKey) addItem(node._item); return;
      case 'p': case 'P': if (node._item.tab === 'sound') togglePreview(node._item); return;
      default: return;
    }
    e.preventDefault();
    if (t < 0 && e.key === 'ArrowUp') { searchInput.focus(); return; }
    vlist.reveal(clamp(t, 0, n - 1), true);
  });

  // Text & speech tab
  on(textEl, 'click', (e) => { const b = e.target.closest('.sa-bubble'); if (b) addBubbleStyle(b._bubble); });

  // ---- sound preview
  const audioState = { key: '', playing: false, el: null, bad: new Set() };
  function stopPreview() {
    if (audioState.el) { audioState.el.pause(); audioState.el.removeAttribute('src'); audioState.el.load(); }
    audioState.playing = false; audioState.key = '';
    syncAllTiles();
  }
  function togglePreview(it) {
    if (audioState.key === it.key && audioState.playing) { stopPreview(); return; }
    if (audioState.bad.has(it.key)) return;
    let url = '';
    try { url = themes.assetUrl(it.assetId, it.themeId, { kind: 'sound' }); } catch { url = ''; }
    if (!url) { audioState.bad.add(it.key); syncAllTiles(); return; }
    if (!audioState.el) {
      audioState.el = new Audio();
      audioState.el.preload = 'none';
      audioState.el.addEventListener('ended', () => { audioState.playing = false; audioState.key = ''; syncAllTiles(); });
      audioState.el.addEventListener('error', () => {
        if (audioState.key) { audioState.bad.add(audioState.key); announce('Preview unavailable for this sound'); }
        audioState.playing = false; audioState.key = ''; syncAllTiles();
      });
    }
    const a = audioState.el;
    a.src = url;
    audioState.key = it.key; audioState.playing = true;
    a.play().catch(() => { audioState.playing = false; audioState.key = ''; syncAllTiles(); });
    syncAllTiles();
  }
  cleanup.push(() => { S.detail?.io?.disconnect(); });
  cleanup.push(() => { if (audioState.el) { audioState.el.pause(); audioState.el.removeAttribute('src'); } });

  // ---- character picker (detail view)
  function openDetail(item) {
    const acts = item.actions;
    const def = acts.find((a) => a.assetId === item.defaultAction || a.id === item.defaultAction)
      || acts.find((a) => /stand|default|idle/i.test(a.id) && a.category.toLowerCase() !== 'emotion')
      || acts.find((a) => a.category.toLowerCase() !== 'emotion') || acts[0] || null;
    S.detail = { item, sel: def, cat: 'all', returnFocus: document.activeElement };
    renderDetail();
    main.hidden = true;
    detailEl.hidden = false;
    detailEl.querySelector('.sa-back')?.focus();
  }
  function closeDetail() {
    if (!S.detail) return;
    const rf = S.detail.returnFocus;
    S.detail.io?.disconnect();
    S.detail = null;
    detailEl.hidden = true;
    detailEl.replaceChildren();
    main.hidden = false;
    vlist.tick();
    if (rf?.isConnected) rf.focus({ preventScroll: true }); else vlist.nodes.get(vlist.active)?.focus({ preventScroll: true });
  }
  const isEmotion = (a) => a.category.toLowerCase().startsWith('emotion');
  /** Elem patch for a picked action. Elem.action is the file part ("stand.swf"); emotions are ordinary actions (the stage prefers `action`). */
  const extraFor = (a, item) => {
    if (!a) return undefined;
    const isDefault = a.id === item.defaultAction || a.assetId === item.defaultAction;
    if (isEmotion(a)) return { action: a.id, emotion: a.id, label: a.name };
    return isDefault ? undefined : { action: a.id, label: a.name };
  };

  function renderDetail() {
    const D = S.detail;
    if (!D) return;
    const prevScroll = detailEl.querySelector('.sa-detail-body')?.scrollTop || 0;
    D.io?.disconnect();
    const { item } = D;
    const acts = item.actions;
    const cats = uniq(acts.map((a) => a.category));
    const order = (c) => (/emotion/i.test(c) ? 0 : /^action$/i.test(c) ? 1 : /motion/i.test(c) ? 2 : 3);
    cats.sort((a, b) => order(a) - order(b) || a.localeCompare(b));
    const shown = D.cat === 'all' ? acts : acts.filter((a) => a.category === D.cat);

    const previewImg = h('img', { alt: '', decoding: 'async', draggable: 'false' });
    const preview = h('div', { class: 'sa-detail-preview is-loading', style: placeholderStyle(item) }, previewImg, h('span', { class: 'sa-ph', html: ico('user') }));
    const selName = h('span', { class: 'sa-detail-sel' }, D.sel ? D.sel.name : 'Default pose');
    const backBtn = h('button', { class: 'sa-back btn btn-ghost btn-icon btn-sm', type: 'button', 'aria-label': 'Back to characters', html: ico('back') });
    const addBtn = h('button', { class: 'btn btn-sm btn-primary sa-detail-add', type: 'button', html: ico('plus') }, h('span', null, 'Add to scene'));
    const selected = selectedChar();
    const canApply = !!(selected && D.sel && sameCharacter(selected, item));
    const applyBtn = h('button', { class: 'btn btn-sm sa-detail-apply', type: 'button', html: ico('replace'), hidden: !canApply }, h('span', null, 'Apply to selected'));
    const grid = h('div', { class: 'sa-actions', role: 'listbox', 'aria-label': 'Actions and emotions' });

    const catRow = h('div', { class: 'sa-chips sa-detail-cats', role: 'toolbar', 'aria-label': 'Action categories' },
      ...['all', ...cats].map((c) => {
        const label = c === 'all' ? 'All' : c.replace(/^\w/, (x) => x.toUpperCase());
        const n = c === 'all' ? acts.length : acts.filter((a) => a.category === c).length;
        const b = h('button', { class: 'sa-chip', type: 'button', 'data-cat': c, 'aria-pressed': D.cat === c ? 'true' : 'false' }, label, h('span', { class: 'sa-chip-n tnum' }, String(n)));
        return b;
      }));

    for (const a of shown) {
      const img = h('img', { alt: '', decoding: 'async', draggable: 'false' });
      const t = h('div', {
        class: `sa-act ${D.sel === a ? 'is-sel' : ''}`, role: 'option', 'aria-selected': D.sel === a ? 'true' : 'false', draggable: 'true',
        title: `${a.name}${isEmotion(a) ? ' (emotion)' : ''}`, style: `--ph-h:${hueOf(a.assetId)}`, tabindex: D.sel === a ? '0' : '-1',
      },
        h('div', { class: 'sa-thumb' }, img, h('span', { class: 'sa-ph', 'aria-hidden': 'true', html: ico('user') })),
        h('span', { class: 'sa-label' }, a.name),
      );
      t._act = a;
      bindThumb(t, { cacheKey: `act|${a.assetId}|${a.thumbUrl || ''}`, assetId: a.assetId, kind: 'char', direct: a.thumbUrl || '', themeId: item.themeId });
      grid.append(t);
    }

    detailEl.replaceChildren(
      h('div', { class: 'sa-detail-head' }, backBtn,
        h('div', { class: 'sa-detail-titles' }, h('h2', { class: 'sa-title' }, item.name), h('span', { class: 'sa-count' }, `${acts.length} actions and emotions`))),
      h('div', { class: 'sa-detail-body' },
        h('div', { class: 'sa-detail-hero' }, preview, h('div', { class: 'sa-detail-info' }, h('span', { class: 'sa-detail-kicker' }, 'Selected'), selName)),
        catRow,
        grid),
      h('div', { class: 'sa-detail-foot' }, applyBtn, addBtn),
    );
    D.grid = grid; D.preview = preview; D.previewImg = previewImg;
    const body = detailEl.querySelector('.sa-detail-body');
    body.scrollTop = prevScroll;
    // Only render thumbnails for action tiles that are (nearly) on screen; a character can have 100+ actions.
    D.io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        const n = en.target;
        if (!n._thumb) continue;
        if (en.isIntersecting) { if (n._thumb.state === 'idle') { n._thumb.state = 'queued'; thumbQueue.add(n); } }
        else if (n._thumb.state === 'queued') { n._thumb.state = 'idle'; thumbQueue.delete(n); }
      }
      pumpThumbs();
    }, { root: body, rootMargin: '160px 0px' });
    for (const n of grid.children) D.io.observe(n);

    // preview of the selected action (falls back to the character thumbnail)
    const pa = D.sel;
    const direct = pa?.thumbUrl || (!pa ? item.thumbUrl : '');
    const ck = pa ? `act|${pa.assetId}|${pa.thumbUrl || ''}` : `${item.tab}|${item.assetId}|${item.thumbUrl}`;
    resolveThumb(ck, pa ? pa.assetId : item.assetId, 'char', direct, item.themeId).then((u) => {
      if (!S.detail || S.detail.preview !== preview) return;
      if (u) { previewImg.onload = () => preview.classList.remove('is-loading'); previewImg.src = u; } else preview.classList.remove('is-loading');
    });

    backBtn.addEventListener('click', closeDetail);
    addBtn.addEventListener('click', () => { addItem(item, undefined, extraFor(D.sel, item)); });
    applyBtn.addEventListener('click', () => applyActionToSelected(D.sel));
    catRow.addEventListener('click', (e) => { const b = e.target.closest('[data-cat]'); if (b) { D.cat = b.dataset.cat; renderDetail(); detailEl.querySelector(`[data-cat="${CSS.escape(D.cat)}"]`)?.focus(); } });
    grid.addEventListener('click', (e) => { const t = e.target.closest('.sa-act'); if (t) { D.sel = t._act; renderDetail(); focusAct(); } });
    grid.addEventListener('dblclick', (e) => { const t = e.target.closest('.sa-act'); if (t) addItem(item, undefined, extraFor(t._act, item)); });
    grid.addEventListener('keydown', (e) => {
      const tiles = [...grid.children];
      const i = tiles.findIndex((t) => t === e.target);
      if (i < 0) return;
      const perRow = Math.max(1, Math.round(grid.clientWidth / (tiles[0].offsetWidth + 8)));
      let n = -1;
      if (e.key === 'ArrowRight') n = i + 1; else if (e.key === 'ArrowLeft') n = i - 1;
      else if (e.key === 'ArrowDown') n = i + perRow; else if (e.key === 'ArrowUp') n = i - perRow;
      else if (e.key === 'Enter') { e.preventDefault(); addItem(item, undefined, extraFor(tiles[i]._act, item)); return; }
      else if (e.key === ' ') { e.preventDefault(); D.sel = tiles[i]._act; renderDetail(); focusAct(); return; }
      else return;
      e.preventDefault();
      const t = tiles[clamp(n, 0, tiles.length - 1)];
      tiles.forEach((x) => { x.tabIndex = -1; }); t.tabIndex = 0; t.focus();
    });
  }
  function focusAct() { detailEl.querySelector('.sa-act.is-sel')?.focus({ preventScroll: true }); }
  on(detailEl, 'keydown', (e) => { if (e.key === 'Escape' && S.detail) { e.preventDefault(); closeDetail(); } });

  /** Does the selected scene character belong to this catalog character? */
  function sameCharacter(elem, item) {
    if (elem.assetId === item.assetId) return true;
    const rid = item.raw?.id ?? item.raw?.charId;
    if (!rid) return false;
    return String(elem.assetId).split('.').includes(String(rid));
  }
  function applyActionToSelected(a) {
    const st = store.get();
    const scene = currentScene(st);
    const el = selectedChar(st);
    if (!scene || !el || !a) return;
    store.dispatch({ type: 'updateElem', sceneId: scene.id, elemId: el.id, patch: isEmotion(a) ? { action: a.id, emotion: a.id } : { action: a.id } });
    flash(`${isEmotion(a) ? 'Emotion' : 'Action'}: ${a.name}`);
  }

  // ---- drag & drop onto the stage
  let drag = null; // {payload, stageEl, box, over}
  function findStageEl() {
    const s = stage || {};
    const candidates = [s.el, s.container, s.root, s.element];
    for (const c of candidates) if (c instanceof Element) return c;
    return document.querySelector('[data-stage], .st-stage, #stage, .stage');
  }
  /** Rect (client px) of the 550x310 stage surface inside the drop element. */
  function stageBox(stageEl) {
    const r = stageEl.getBoundingClientRect();
    let best = null;
    const aspect = STAGE_W / STAGE_H;
    for (const c of stageEl.querySelectorAll('canvas, [data-stage-surface], .st-stage-surface, .stage-surface, div, section')) {
      const cr = c.getBoundingClientRect();
      if (cr.width < 150 || cr.height < 80) continue;
      if (Math.abs(cr.width / cr.height - aspect) < 0.03 && (!best || cr.width > best.width)) best = cr;
    }
    if (best) return best;
    // Fit 550x310 inside the element, centered.
    const k = Math.min(r.width / STAGE_W, r.height / STAGE_H);
    const w = STAGE_W * k, hgt = STAGE_H * k;
    return { left: r.left + (r.width - w) / 2, top: r.top + (r.height - hgt) / 2, width: w, height: hgt };
  }
  function toStage(cx, cy) {
    if (typeof stage?.clientToStage === 'function') {
      try { const p = stage.clientToStage(cx, cy); if (p) return p; } catch { /* fall through */ }
    }
    const b = drag.box || (drag.box = stageBox(drag.stageEl));
    return { x: clamp(((cx - b.left) / b.width) * STAGE_W, 0, STAGE_W), y: clamp(((cy - b.top) / b.height) * STAGE_H, 0, STAGE_H) };
  }
  const overStage = (e) => { const el = drag.stageEl; if (!el) return false; const r = el.getBoundingClientRect(); return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom; };

  function startDrag(e, payload, thumbSource) {
    const stageEl = findStageEl();
    drag = { payload, stageEl, box: null, over: false };
    e.dataTransfer.effectAllowed = 'copy';
    try { e.dataTransfer.setData(MIME, JSON.stringify({ kind: payload.kind, assetId: payload.assetId || '', name: payload.name || '', duration: payload.item?.duration || 0, sk: payload.item?.sk || '' })); e.dataTransfer.setData('text/plain', payload.name || payload.assetId || ''); } catch { /* ignore */ }
    const img = thumbSource?.querySelector?.('img');
    if (img && img.complete && img.naturalWidth) { try { e.dataTransfer.setDragImage(img, img.width / 2, img.height / 2); } catch { /* ignore */ } }
    document.documentElement.classList.add('studio-dragging');
    document.addEventListener('dragover', onDragOver, true);
    document.addEventListener('drop', onDrop, true);
    document.addEventListener('dragend', endDrag, true);
  }
  function setOver(on) {
    if (!drag || drag.over === on) return;
    drag.over = on;
    drag.stageEl?.classList.toggle('studio-drop-active', on);
  }
  function onDragOver(e) {
    if (!drag) return;
    if (overStage(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setOver(true); } else setOver(false);
  }
  function onDrop(e) {
    if (!drag) return;
    const hit = overStage(e);
    const { payload } = drag;
    if (hit) {
      e.preventDefault(); e.stopPropagation();
      drag.box = null;
      const pos = toStage(e.clientX, e.clientY);
      dropPayload(payload, pos);
    }
    endDrag();
  }
  function endDrag() {
    if (!drag) return;
    setOver(false);
    drag.stageEl?.classList.remove('studio-drop-active');
    document.documentElement.classList.remove('studio-dragging');
    document.removeEventListener('dragover', onDragOver, true);
    document.removeEventListener('drop', onDrop, true);
    document.removeEventListener('dragend', endDrag, true);
    drag = null;
  }
  cleanup.push(endDrag);
  function dropPayload(p, pos) {
    if (p.kind === 'bubble') addBubbleStyle(p.bubble, pos);
    else if (p.item) addItem(p.item, pos, p.extra);
  }
  on(scroll, 'dragstart', (e) => {
    const node = e.target.closest?.('[data-key]');
    if (!node) return;
    const it = node._item;
    startDrag(e, { kind: it.tab, assetId: it.assetId, name: it.name, item: it }, node.querySelector('.sa-thumb'));
  });
  on(textEl, 'dragstart', (e) => {
    const b = e.target.closest?.('.sa-bubble');
    if (!b) return;
    startDrag(e, { kind: 'bubble', name: b._bubble.name, bubble: b._bubble }, b.querySelector('.sa-bubble-art'));
  });
  on(detailEl, 'dragstart', (e) => {
    const t = e.target.closest?.('.sa-act');
    if (!t || !S.detail) return;
    const { item } = S.detail;
    startDrag(e, { kind: 'char', assetId: item.assetId, name: `${item.name} (${t._act.name})`, item, extra: extraFor(t._act, item) }, t.querySelector('.sa-thumb'));
  });

  // ---- store sync
  let lastSig = '';
  const unsub = store.subscribe(() => {
    const st = store.get();
    const sig = `${st.movie.themeId}|${currentScene(st)?.bg?.assetId || ''}|${st.selection?.sceneId}|${st.selection?.elemId}`;
    if (st.movie.themeId !== S.movieTheme) {
      // A different movie/theme was loaded: follow it unless the user is mid-browse of something else.
      const followed = S.themeId === S.movieTheme;
      S.movieTheme = st.movie.themeId;
      if (followed) { S.themeId = S.movieTheme; S.chip = {}; ensureLoaded(); render(); }
    }
    if (sig === lastSig) return;
    lastSig = sig;
    syncAllTiles();
    if (S.detail && !detailEl.hidden) {
      const selected = selectedChar();
      const ok = !!(selected && S.detail.sel && sameCharacter(selected, S.detail.item));
      const b = detailEl.querySelector('.sa-detail-apply');
      if (b) b.hidden = !ok;
    }
  });
  cleanup.push(unsub);

  // ---- boot
  render();
  catalog.loadList().then(() => {
    if (destroyed) return;
    // Fall back to the first listed theme when the movie's theme is unknown to the catalog.
    const list = arr(catalog.list);
    if (list.length && !list.some((t) => t.id === S.themeId)) {
      const alias = THEME_ALIAS[S.themeId];
      S.themeId = alias && list.some((t) => t.id === alias) ? alias : list.some((t) => t.id === 'common') ? 'common' : list[0].id;
    }
    ensureLoaded();
    render();
  }).catch(() => { ensureLoaded(); render(); });
  ensureLoaded();

  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      applySearch.cancel(); requestVisibleThumbs.cancel(); rerender.cancel(); syncAllTiles.cancel();
      clearTimeout(toastTimer);
      for (const fn of cleanup.splice(0).reverse()) { try { fn(); } catch { /* ignore */ } }
      thumbQueue.clear();
      root.classList.remove('sa-root');
      root.replaceChildren();
    },
    /** Programmatic helpers for the shell (optional). */
    focusSearch() { searchInput.focus(); searchInput.select(); },
    setTab,
  };
}

/** Pure helpers, exported for tests. */
export const _internals = { normItem, searchFilter, soundKind, actionsOf, tagsOf, prettify, fmtDur };
