/**
 * Asset thumbnails for the Studio assets panel and timeline.
 *
 *   getAssetThumb(assetId, kind, { size?, themeId? }) -> Promise<string>   object URL (image/png or image/jpeg)
 *
 * Order of attempts, all cached in memory and in IndexedDB ("redrawn-studio-thumbs"):
 *   1. a same-named .jpg/.png beside the SWF (backgrounds ship Diner.jpg next to Diner_bg.swf),
 *   2. a render of the SWF itself: loaded into an offscreen Ruffle host, framed on its real bounds, captured.
 * Rendering is throttled to 2 at a time, newest request first (the visible part of a scrolling grid wins), and never
 * blocks the UI: everything is async and the Ruffle host is released (then destroyed when idle) afterwards.
 *
 * `kind`: 'bg' | 'char' | 'prop' | 'effect' (sounds and custom characters have no renderable thumbnail: the promise rejects).
 */
import { getPool, assetBlobUrl, sleep } from './ruffle-pool.js';

const DB_NAME = 'redrawn-studio-thumbs';
const STORE = 'thumbs';
const VERSION = 'v3';
const MAX_ENTRIES = 3000;
const CONCURRENCY = 2;
const DEFAULT_SIZE = 192;

// ------------------------------------------------------------------------------------------ pure helpers
/** Cache key for a thumbnail. */
export function thumbCacheKey(assetId, kind, size = DEFAULT_SIZE) {
  return `${VERSION}|${kind}|${size}|${assetId}`;
}

/**
 * Image files that may sit beside an SWF url: "…/bg/Diner_bg.swf" -> Diner_bg.jpg, Diner.jpg, Diner_bg.png, Diner.png.
 * Only backgrounds follow this convention in the store, but the cost of trying is one cached 404.
 */
export function imageCandidates(swfUrl) {
  const m = /^(.*)\/([^/]+)\.swf(\?.*)?$/i.exec(swfUrl);
  if (!m) return [];
  const [, dir, stem] = m;
  const stems = [...new Set([stem, stem.replace(/_bg$/i, '')])];
  const out = [];
  for (const s of stems) out.push(`${dir}/${s}.jpg`);
  for (const s of stems) out.push(`${dir}/${s}.png`);
  return out;
}

/**
 * Scale + offset that fit local bounds [x,y,w,h] inside a box of bw x bh (centred, with `pad` fraction margin).
 * @returns {{scale:number, x:number, y:number}} place the asset origin at (x, y) with uniform `scale`
 */
export function fitBounds(b, bw, bh, pad = 0.08) {
  const [x, y, w, h] = b;
  const scale = Math.min((bw * (1 - pad * 2)) / w, (bh * (1 - pad * 2)) / h);
  return { scale, x: bw / 2 - (x + w / 2) * scale, y: bh / 2 - (y + h / 2) * scale };
}

// ------------------------------------------------------------------------------------------ IndexedDB
let dbPromise = null;
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        const os = db.createObjectStore(STORE, { keyPath: 'k' });
        os.createIndex('t', 't');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  return dbPromise;
}

async function dbGet(key) {
  const db = await openDb();
  if (!db) return undefined;
  return new Promise((resolve) => {
    try {
      const r = db.transaction(STORE).objectStore(STORE).get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(undefined);
    } catch { resolve(undefined); }
  });
}

let puts = 0;
async function dbPut(key, blob) {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ k: key, blob: blob ?? null, t: Date.now() });
    if (++puts % 60 === 0) prune(db);
  } catch { /* quota or private mode: memory cache still works */ }
}

function prune(db) {
  try {
    const tx = db.transaction(STORE, 'readwrite');
    const os = tx.objectStore(STORE);
    const count = os.count();
    count.onsuccess = () => {
      let extra = count.result - MAX_ENTRIES;
      if (extra <= 0) return;
      const cur = os.index('t').openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c || extra-- <= 0) return;
        c.delete(); c.continue();
      };
    };
  } catch { /* ignore */ }
}

/** Clear stored thumbnails (settings "clear cache"). */
export async function clearThumbCache() {
  mem.clear();
  const db = await openDb();
  if (!db) return;
  try { db.transaction(STORE, 'readwrite').objectStore(STORE).clear(); } catch { /* ignore */ }
}

// ------------------------------------------------------------------------------------------ queue
const mem = new Map(); // key -> Promise<string>
const queue = [];
let running = 0;

function enqueue(job) {
  return new Promise((resolve, reject) => {
    queue.push({ job, resolve, reject });
    pump();
  });
}

function pump() {
  while (running < CONCURRENCY && queue.length) {
    const { job, resolve, reject } = queue.pop(); // newest first
    running++;
    job().then(resolve, reject).finally(() => { running--; pump(); });
  }
}

let themesMod = null;
async function themes() { return (themesMod ??= await import('./themes.js').catch(() => ({}))); }

// ------------------------------------------------------------------------------------------ public
/**
 * @param {string} assetId  dotted legacy asset id ("common.Diner_bg.swf", "common.matchBoyNew.stand.swf", "common.02bat.swf")
 * @param {'bg'|'char'|'prop'|'effect'|string} kind
 * @param {{size?:number, themeId?:string}} [opts]
 * @returns {Promise<string>}
 */
export function getAssetThumb(assetId, kind, opts = {}) {
  const size = opts.size ?? DEFAULT_SIZE;
  const key = thumbCacheKey(assetId, kind, size);
  let p = mem.get(key);
  if (p) return p;
  p = (async () => {
    const cached = await dbGet(key);
    if (cached) {
      if (cached.blob) return URL.createObjectURL(cached.blob);
      throw new Error('no thumbnail'); // remembered miss
    }
    const blob = await enqueue(() => makeThumb(assetId, kind, size, opts));
    if (!blob) { dbPut(key, null); throw new Error('no thumbnail'); }
    dbPut(key, blob);
    return URL.createObjectURL(blob);
  })();
  mem.set(key, p);
  // definitive misses stay cached (remembered); transient failures (timeouts, no Ruffle) may be retried later
  p.catch((err) => { if (err?.transient) mem.delete(key); });
  return p;
}

async function resolveUrl(assetId, kind, opts) {
  const t = await themes();
  const id = String(assetId);
  if (kind === 'char' && (/\.xml$/i.test(id) || id.split('.').length < 4)) {
    // a bare character id: use its default action
    const ch = t.findAsset?.(id);
    if (ch?.assetId && ch.assetId !== id) return t.assetUrl?.(ch.assetId, opts.themeId, { kind: 'char' }) || '';
    if (/\.xml$/i.test(id)) return '';
  }
  return t.assetUrl?.(id, opts.themeId, { kind }) || '';
}

async function makeThumb(assetId, kind, size, opts) {
  if (kind === 'sound') return null;
  const url = await resolveUrl(assetId, kind, opts);
  if (!url) return null;
  // 1. a picture beside the SWF
  if (kind === 'bg') {
    for (const u of imageCandidates(url)) {
      try {
        const res = await fetch(u);
        if (res.ok && /^image\//.test(res.headers.get('content-type') || '')) return await res.blob();
      } catch { /* try the next */ }
    }
  }
  // 2. render it
  return renderSwf(url, kind, size);
}

/** Render one SWF in an offscreen Ruffle host and return a PNG blob (null on failure). */
async function renderSwf(url, kind, size) {
  const pool = getPool();
  let host = null;
  try {
    try {
      host = await pool.acquire({ width: 550, height: 310, pixelScale: size > 280 ? 2 : 1, autoPause: false, quality: 'high' });
    } catch (e) { throw Object.assign(e instanceof Error ? e : new Error(String(e)), { transient: true }); }
    host.setPaused(false);
    const id = 't';
    await host.load(id, url, { timeout: 12000 });
    const K = 550 / 640; // legacy -> stage factor, so backgrounds look like they do in the editor
    let crop, outW;
    if (kind === 'bg') {
      host.set(id, { x: 0, y: 0, scaleX: K, scaleY: K });
      crop = { x: 0, y: 0, w: 550, h: 310 };
      outW = size;
    } else {
      const b = host.bounds(id);
      if (!b || !(b[2] > 0.5) || !(b[3] > 0.5)) return null;
      // frame inside a square of 310 stage px centred on the stage (x 120..430) so the thumbnail is square
      const s = Math.min(fitBounds(b, 310, 310, 0.1).scale, 4);
      host.set(id, { x: 275 - (b[0] + b[2] / 2) * s, y: 155 - (b[1] + b[3] / 2) * s, scaleX: s, scaleY: s });
      crop = { x: 120, y: 0, w: 310, h: 310 };
      outW = size;
    }
    host.put(id, 'visible', true);
    host.call(id, 'content.gotoAndStop', 1);
    // let Ruffle build nested clips and draw (frames are 24 fps)
    await sleep(140);
    let canvas = await host.capture(crop, outW);
    if (!canvas) { await sleep(200); canvas = await host.capture(crop, outW); }
    if (!canvas) return null;
    return await new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
  } catch (e) {
    console.debug('[thumbs] render failed', url, e?.message);
    // a missing asset is a definitive miss (remembered); network/Ruffle trouble is retried on the next request
    if (e?.status !== 404 && e?.status !== 403 && e?.status !== 410) throw Object.assign(e instanceof Error ? e : new Error(String(e)), { transient: true });
    return null;
  } finally {
    host?.release();
  }
}

/** Test/maintenance hook: forget the in-memory layer (IndexedDB stays). */
export function _resetMemory() { mem.clear(); }
export { assetBlobUrl };
