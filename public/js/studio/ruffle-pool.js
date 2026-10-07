/**
 * Ruffle plumbing for Studio: SWF fetching + decryption, a bounded pool of Ruffle "host" instances, and the thin
 * JS wrapper around the AS3 compositor built by host-swf.js.
 *
 * Findings that shape this module (measured, see the stage report):
 *  - Store SWFs (server/store/<id>/<theme>/{bg,char,prop,effect}/*.swf) are RC4-encrypted at rest; the legacy editor
 *    decrypts them in ActionScript (anifire.util.UtilCrypto). The key is "sorrypleasetryagainlater". We decrypt in JS and
 *    hand Ruffle a blob: URL, so no server change is needed. Plain SWFs/images pass through untouched.
 *  - One Ruffle instance (one WebGL context + wasm heap) can composite the whole scene, so the pool is small by design:
 *    1 live stage host + up to 2 thumbnail hosts. Idle hosts are destroyed after IDLE_MS.
 *
 *   const pool = getPool();                        // shared singleton (max 3 live hosts)
 *   const host = await pool.acquire({ container }); // or omit container for an offscreen host
 *   await host.load('e1', swfUrl);                  // fetch + decrypt + Loader, resolves when the first frame exists
 *   host.set('e1', { x: 100, y: 200, scaleX: 1.2 });
 *   host.release();
 *
 * @typedef {Object} HostOptions
 * @property {HTMLElement} [container]  where to mount the Ruffle element (default: an offscreen holder)
 * @property {number} [width]           host stage width in px (default 550)
 * @property {number} [height]          host stage height in px (default 310)
 * @property {number} [pixelScale]       offscreen render resolution multiplier (thumbnails use 2)
 * @property {'high'|'medium'|'low'} [quality]  Ruffle render quality (default high)
 * @property {boolean} [keep]           never auto-destroy when idle (the live stage)
 * @property {boolean} [muted]          default true
 * @property {boolean} [autoPause]      pause on document.hidden (default true); the stage manages its own pausing
 */

export const STORE_KEY = 'sorrypleasetryagainlater';
const RUFFLE_BASE = '/vendor/ruffle/';
const MAX_HOSTS = 3;
const IDLE_MS = 20000;
const BYTES_CACHE_MAX = 64 * 1024 * 1024;
const BLOB_CACHE_MAX = 160;
const LOAD_TIMEOUT_MS = 20000;

// -------------------------------------------------------------------------------------------- crypto + fetch
const KEY = new TextEncoder().encode(STORE_KEY);

/** RC4 (identical to anifire.util.Crypto.FastRC4). Pure; exported for tests. */
export function rc4(key, data) {
  const S = new Uint8Array(256);
  for (let i = 0; i < 256; i++) S[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + S[i] + key[i % key.length]) & 255;
    const t = S[i]; S[i] = S[j]; S[j] = t;
  }
  const out = new Uint8Array(data.length);
  let a = 0, b = 0;
  for (let n = 0; n < data.length; n++) {
    a = (a + 1) & 255; b = (b + S[a]) & 255;
    const t = S[a]; S[a] = S[b]; S[b] = t;
    out[n] = data[n] ^ S[(S[a] + S[b]) & 255];
  }
  return out;
}

/** Pure: does the buffer start with an SWF signature (FWS / CWS / ZWS)? */
export function isSwf(b) {
  return b.length > 8 && (b[0] === 0x46 || b[0] === 0x43 || b[0] === 0x5a) && b[1] === 0x57 && b[2] === 0x53;
}

/**
 * Pure: decrypt a store asset like UtilCrypto.decrypt: if the first bytes already look like an SWF it is left alone,
 * else try the store key on the whole buffer (only accepted when the result is an SWF).
 */
export function decryptSwf(bytes) {
  if (isSwf(bytes)) return bytes;
  const head = rc4(KEY, bytes.subarray(0, 10));
  if (head[1] === 0x57 && head[2] === 0x53 && (head[0] === 0x46 || head[0] === 0x43 || head[0] === 0x5a)) return rc4(KEY, bytes);
  return bytes; // an image or something else: pass through
}

const bytesCache = new Map(); // url -> Promise<Uint8Array>  (insertion order = LRU order)
let bytesTotal = 0;

/** Fetch and decrypt an asset. Cached (64 MB LRU) and de-duplicated. */
export function fetchAssetBytes(url) {
  let p = bytesCache.get(url);
  if (p) { bytesCache.delete(url); bytesCache.set(url, p); return p; }
  p = (async () => {
    const res = await fetch(url);
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} for ${url}`), { status: res.status });
    const out = decryptSwf(new Uint8Array(await res.arrayBuffer()));
    bytesTotal += out.length;
    p.size = out.length;
    trimBytes();
    return out;
  })();
  p.catch(() => { bytesCache.delete(url); });
  bytesCache.set(url, p);
  return p;
}

function trimBytes() {
  for (const [k, v] of bytesCache) {
    if (bytesTotal <= BYTES_CACHE_MAX) break;
    if (!v.size) continue; // still loading
    bytesCache.delete(k);
    bytesTotal -= v.size;
    const b = blobCache.get(k);
    if (b) { blobCache.delete(k); b.then((u) => URL.revokeObjectURL(u)).catch(() => {}); }
  }
}

const blobCache = new Map(); // url -> Promise<string blob url>

/** A blob: URL holding the decrypted asset, for Loader.load(). Cached (160 entries). */
export function assetBlobUrl(url) {
  let p = blobCache.get(url);
  if (p) { blobCache.delete(url); blobCache.set(url, p); return p; }
  p = fetchAssetBytes(url).then((bytes) => {
    const type = isSwf(bytes) ? 'application/x-shockwave-flash' : /\.png(\?|$)/i.test(url) ? 'image/png' : /\.gif(\?|$)/i.test(url) ? 'image/gif' : 'image/jpeg';
    return URL.createObjectURL(new Blob([bytes], { type }));
  });
  p.catch(() => blobCache.delete(url));
  blobCache.set(url, p);
  while (blobCache.size > BLOB_CACHE_MAX) {
    const [k, v] = blobCache.entries().next().value;
    blobCache.delete(k);
    v.then((u) => URL.revokeObjectURL(u)).catch(() => {});
  }
  return p;
}

/** Drop everything cached (tests / memory pressure). */
export function clearAssetCaches() {
  bytesCache.clear(); bytesTotal = 0;
  for (const v of blobCache.values()) v.then((u) => URL.revokeObjectURL(u)).catch(() => {});
  blobCache.clear();
}

// -------------------------------------------------------------------------------------------- Ruffle loader
let scriptPromise = null;
/** Load the self-hosted Ruffle once. Config mirrors player.js (compatibilityRules off, default wgpu-webgl renderer). */
export function loadRuffle() {
  if (window.RufflePlayer?.newest) return Promise.resolve();
  return (scriptPromise ??= new Promise((resolve, reject) => {
    const base = window.REDRAWN_RUFFLE_BASE || RUFFLE_BASE;
    window.RufflePlayer = window.RufflePlayer || {};
    window.RufflePlayer.config = {
      polyfills: false, warnOnUnsupportedContent: false, logLevel: 'warn', compatibilityRules: false,
      maxExecutionDuration: 3000, publicPath: base, ...(window.RufflePlayer.config || {}),
    };
    const s = document.createElement('script');
    s.src = base + 'ruffle.js';
    s.onload = () => (window.RufflePlayer?.newest ? resolve() : reject(new Error('Ruffle loaded but window.RufflePlayer is missing.')));
    s.onerror = () => { scriptPromise = null; reject(new Error(`Could not load the Flash player from ${s.src}`)); };
    document.head.appendChild(s);
  }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

// -------------------------------------------------------------------------------------------- Host
/** A private offscreen box for one host (renders normally, but is invisible and ignores input). */
function makeHolder(w, h) {
  const d = document.createElement('div');
  d.setAttribute('aria-hidden', 'true');
  d.style.cssText = `position:fixed;left:0;top:0;width:${w}px;height:${h}px;opacity:0;pointer-events:none;z-index:-1;overflow:hidden;contain:strict`;
  document.body.appendChild(d);
  return d;
}

/**
 * One Ruffle instance running the AS3 compositor. All methods are synchronous ExternalInterface round trips except
 * load(). Ids are caller-chosen strings; "root" is the host itself.
 */
export class Host {
  /** @param {HostPool} pool @param {HostOptions} o */
  constructor(pool, o = {}) {
    this.pool = pool;
    this.width = o.width ?? 550;
    this.height = o.height ?? 310;
    this.keep = !!o.keep;
    this.muted = o.muted !== false;
    this.autoPause = o.autoPause !== false;
    this.container = o.container ?? null;
    this.pixelScale = o.pixelScale ?? 1;
    this.quality = o.quality ?? 'high';
    this.holder = null;
    this.el = null;
    this.destroyed = false;
    this.paused = false;
    this.leased = true;
    this.idleTimer = 0;
    this.ids = new Set();
    this.ready = this._start();
  }

  async _start() {
    await loadRuffle();
    if (this.destroyed) throw new Error('host destroyed');
    const { buildHostSwf } = await import('./host-swf.js');
    const ruffle = window.RufflePlayer.newest();
    const el = ruffle.createPlayer();
    el.style.cssText = 'width:100%;height:100%;display:block;--splash-screen-background:transparent';
    el.setAttribute('data-studio-host', '');
    this._place(el);
    this.el = el;
    const cfg = {
      data: buildHostSwf(this.width, this.height), autoplay: 'on', unmuteOverlay: 'hidden', letterbox: 'off', wmode: 'transparent',
      splashScreen: false, allowScriptAccess: true, contextMenu: 'off', menu: false, openUrlMode: 'deny', logLevel: 'error',
      backgroundColor: null, quality: this.quality, preferredRenderer: undefined,
    };
    for (const k of Object.keys(cfg)) if (cfg[k] === undefined || cfg[k] === null) delete cfg[k];
    await el.load(cfg);
    try {
      // a suspended Ruffle shows a big "play" button; our host is driven by the editor, never by clicks
      const css = document.createElement('style');
      css.textContent = '#play-button,#unmute-overlay,#splash-screen,.hidden-overlay{display:none!important}';
      el.shadowRoot?.appendChild(css);
    } catch { /* closed shadow root */ }
    if (this.muted) { try { el.volume = 0; } catch { /* older builds */ } }
    // the AS3 constructor registers the callbacks on its first frame
    const t0 = performance.now();
    while (typeof el.op !== 'function') {
      if (this.destroyed) throw new Error('host destroyed');
      if (performance.now() - t0 > 8000) throw new Error('The stage compositor did not start.');
      await sleep(16);
    }
    return this;
  }

  /** Move the Ruffle element to another container (e.g. offscreen <-> visible). */
  mount(container) { if (container === this.container && this.el?.isConnected) return; this.container = container; if (this.el) this._place(this.el); }

  /** Moving a <ruffle-player> in the DOM destroys the Ruffle instance, so only ever append it once. */
  _place(el) {
    if (this.container) { if (el.parentElement !== this.container) this.container.appendChild(el); return; }
    this.holder ??= makeHolder(this.width * this.pixelScale, this.height * this.pixelScale);
    if (el.parentElement !== this.holder) this.holder.appendChild(el);
  }

  // ---- raw bridge
  op(id, path, mode, args = []) {
    if (this.destroyed || !this.el?.op) return null;
    try { return this.el.op(id, path, mode, args); } catch { return null; }
  }
  get(id, path) { return this.op(id, path, 0); }
  put(id, path, value) { return this.op(id, path, 1, [value]); }
  call(id, path, ...args) { return this.op(id, path, 2, args); }

  /** Set several properties of a loader at once. */
  set(id, props) { for (const k of Object.keys(props)) this.op(id, k, 1, [props[k]]); }

  /** Local (untransformed) bounds [x, y, w, h] of a loaded asset, or null. */
  bounds(id) { try { return this.el?.bounds?.(id) ?? null; } catch { return null; } }

  /** Shape-accurate hit test in host stage pixels. */
  hit(id, x, y) { return this.call(id, 'hitTestPoint', x, y, true) === true; }

  setOrder(id, index) { try { this.el?.idx?.(id, index); } catch { /* gone */ } }

  /**
   * Load an asset into a new Loader. Resolves with {frames} once its first frame exists; rejects on fetch errors
   * or after LOAD_TIMEOUT_MS. Loading the same id again replaces it.
   */
  async load(id, url, { timeout = LOAD_TIMEOUT_MS } = {}) {
    await this.ready;
    if (this.ids.has(id)) this.remove(id);
    const blob = await assetBlobUrl(url);
    if (this.destroyed) throw new Error('host destroyed');
    this.ids.add(id);
    this.el.add(id, blob);
    this.put(id, 'visible', false); // never flash at the origin before the caller positions it
    const t0 = performance.now();
    for (;;) {
      if (this.destroyed || !this.ids.has(id)) throw new Error('cancelled');
      if (this.get(id, 'content.width') != null) return { frames: this.get(id, 'content.totalFrames') ?? 1 };
      if (performance.now() - t0 > timeout) { this.remove(id); throw new Error(`Timed out loading ${url}`); }
      await sleep(16);
    }
  }

  remove(id) {
    if (!this.ids.delete(id)) return;
    try { this.el?.rm?.(id); } catch { /* gone */ }
  }

  clear() { for (const id of [...this.ids]) this.remove(id); }

  /** Freeze every nested MovieClip of an asset on its current frame (stops CPU use and animation). */
  freeze(id, frame) {
    if (frame != null) this.call(id, 'content.gotoAndStop', frame);
    else this.call(id, 'content.stop');
    this.call(id, 'content.stopAllMovieClips');
  }

  /** Suspend / resume Ruffle's frame loop. A suspended host keeps its state but costs nothing. */
  setPaused(paused) {
    if (this.destroyed || !this.el || paused === this.paused) return;
    this.paused = paused;
    try { paused ? this.el.pause() : this.el.play(); } catch { /* not ready */ }
  }

  /** Canvas element inside Ruffle's shadow DOM. */
  get canvas() { return this.el?.shadowRoot?.querySelector('canvas') ?? null; }

  /**
   * Copy the current frame into a 2D canvas. Must run right after Ruffle has drawn (WebGL clears its buffer after
   * compositing), so we sample inside a requestAnimationFrame callback registered after Ruffle's own.
   * @param {{x:number,y:number,w:number,h:number}} [crop] in host stage pixels
   * @param {number} [outW] output width in px
   * @returns {Promise<HTMLCanvasElement|null>}
   */
  capture(crop, outW) {
    return new Promise((resolve) => {
      const attempt = (n) => requestAnimationFrame(() => {
        const cv = this.canvas;
        if (!cv || !cv.width) { n > 30 ? resolve(null) : attempt(n + 1); return; }
        const sx = cv.width / this.width, sy = cv.height / this.height;
        const c = crop ?? { x: 0, y: 0, w: this.width, h: this.height };
        const w = Math.max(1, Math.round(outW ?? c.w * sx));
        const h = Math.max(1, Math.round(w * (c.h / c.w)));
        const out = document.createElement('canvas');
        out.width = w; out.height = h;
        const g = out.getContext('2d');
        try { g.drawImage(cv, c.x * sx, c.y * sy, c.w * sx, c.h * sy, 0, 0, w, h); } catch { resolve(null); return; }
        // A cleared WebGL buffer reads back fully transparent: retry a few frames
        const probe = g.getImageData(0, 0, w, h).data;
        let any = false;
        for (let i = 3; i < probe.length; i += 4 * 97) if (probe[i]) { any = true; break; }
        if (!any && n < 12) { attempt(n + 1); return; }
        resolve(out);
      });
      attempt(0);
    });
  }

  /** Give the host back to the pool (it stays alive for reuse until idle). */
  release() { this.pool.release(this); }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    clearTimeout(this.idleTimer);
    this.ids.clear();
    try { this.el?.remove(); } catch { /* gone */ }
    try { this.el?.destroy?.(); } catch { /* gone */ }
    this.holder?.remove(); this.holder = null;
    this.el = null;
    this.pool.forget(this);
  }
}

// -------------------------------------------------------------------------------------------- pool
/** Bounded set of live hosts. acquire() waits when all `max` are leased. */
export class HostPool {
  constructor(max = MAX_HOSTS) {
    this.max = max;
    /** @type {Set<Host>} */ this.hosts = new Set();
    this.waiters = [];
    this.visHandler = () => { for (const h of this.hosts) if (h.autoPause) h.setPaused(document.hidden); };
    document.addEventListener('visibilitychange', this.visHandler);
  }

  /** @param {HostOptions} [o] @returns {Promise<Host>} */
  async acquire(o = {}) {
    // reuse an idle, compatible host
    for (const h of this.hosts) {
      if (!h.leased && !h.destroyed && !h.keep && !h.container && !o.container && h.width === (o.width ?? 550) && h.height === (o.height ?? 310) && h.pixelScale === (o.pixelScale ?? 1)) {
        clearTimeout(h.idleTimer);
        h.leased = true; h.keep = !!o.keep; h.autoPause = o.autoPause !== false;
        h.setPaused(false);
        await h.ready;
        return h;
      }
    }
    if (this.hosts.size >= this.max) {
      // evict an idle host of another shape, else wait for a release
      const idle = [...this.hosts].find((h) => !h.leased && !h.keep);
      if (idle) idle.destroy();
      else await new Promise((resolve) => this.waiters.push(resolve));
      return this.acquire(o);
    }
    const h = new Host(this, o);
    this.hosts.add(h);
    try { await h.ready; } catch (e) { h.destroy(); throw e; }
    return h;
  }

  release(h) {
    if (h.destroyed || !h.leased) return;
    if (h.container) { h.destroy(); return; } // lives inside the caller's DOM: cannot be moved without being destroyed
    h.clear();
    h.leased = false;
    if (h.keep) { h.keep = false; }
    h.setPaused(true);
    h.idleTimer = setTimeout(() => h.destroy(), IDLE_MS);
    const w = this.waiters.shift();
    if (w) w();
  }

  forget(h) {
    this.hosts.delete(h);
    const w = this.waiters.shift();
    if (w) w();
  }

  stats() { return { live: this.hosts.size, leased: [...this.hosts].filter((h) => h.leased).length, max: this.max, bytesCached: bytesTotal, blobs: blobCache.size }; }

  destroy() {
    document.removeEventListener('visibilitychange', this.visHandler);
    for (const h of [...this.hosts]) h.destroy();
    this.waiters.length = 0;
  }
}

let shared = null;
/** The shared pool used by the stage and thumbnail generator. */
export function getPool() { return (shared ??= new HostPool(MAX_HOSTS)); }

export { nextFrame, sleep };
