/**
 * Redrawn Studio stage: renders the current scene at 550x310 (scaled crisply to fit), lets the user select, move, scale,
 * rotate, flip and delete elements, and plays the movie in sync with the audio engine.
 *
 *   const stage = await createStage(container, { store, themes, audio });
 *   stage.play() / pause() / seek(ms)            transport (delegates to the audio engine when there is one)
 *   stage.hitTest(x, y)                          -> {elemId, kind} | null   (stage coordinates 0..550 x 0..310)
 *   stage.clientToStage(clientX, clientY)        -> {x, y}
 *   stage.el / stage.container                   root element (drop target for the assets panel)
 *   stage.setTool('select' | 'view')             'view' hides the editing overlay (read-only preview)
 *   stage.thumbnail(assetId, size[, kind])       -> Promise<string>  object URL (same cache as thumbs.js)
 *   stage.snapshot(width)                        -> Promise<Blob|null>  PNG of the current frame
 *   stage.stats()                                live layers, pending loads, host state
 *   stage.destroy()
 *
 * How it renders: ONE Ruffle instance runs a tiny AS3 compositor (host-swf.js); every background, character, prop and
 * effect is a Loader inside it, positioned/scaled/rotated by ActionScript transforms (so the output is vector-crisp at
 * any size and z-order is real). Speech bubbles and the selection overlay are DOM/SVG above the canvas.
 *
 * Character actions are whole SWFs (store/<theme>/char/<char>/<action>.swf). Elem.action (else Elem.emotion, else the
 * char's own default action id) picks the file; changing it swaps the Loader. See ruffle-pool.js for decryption.
 */
import { FPS, LEGACY_K, STAGE_H, STAGE_W, findElem, findScene, sceneStart } from './model.js';
import {
  angleDeg, applyCamera, bubblePath, drawScale, fitView, flipAboutCenter, frameAt, inQuad, inWindow, normDeg, orientedBox,
  quadArea, rotateAboutCenter, round2, scaleAboutCenter, thoughtDots, boxCenter,
} from './stage-math.js';
import { getPool, sleep } from './ruffle-pool.js';
import { getPrefs } from '../prefs.js';

const IDLE_PAUSE_MS = 500;      // pause Ruffle's frame loop this long after the last change while stopped
const COMMIT_WAIT_MS = 350;     // when switching scenes, wait at most this long for the new layers before showing them
const PREFETCH_MS = 2200;       // while playing, warm the next scene this long before it starts
const SELECT_COLOR = 'var(--accent, #3dd6e6)';
const FALLBACK_BOX = [-30, -30, 60, 60];
const CC_BOX = [-45, -150, 90, 170];

const CSS = `
.rs-root{position:relative;align-self:stretch;justify-self:stretch;min-width:0;min-height:0;overflow:hidden;outline:none;user-select:none;-webkit-user-select:none;touch-action:none;container-type:size}
.rs-root:focus-visible .rs-view{outline:2px solid var(--accent,#3dd6e6);outline-offset:3px}
.rs-view{position:absolute;background:#fff;box-shadow:0 0 0 1px oklch(0.3 0.03 262 / .6),0 16px 48px -12px oklch(0.05 0.02 262 / .7);overflow:hidden;border-radius:2px}
.rs-canvas{position:absolute;inset:0}
.rs-canvas>*{width:100%;height:100%;display:block}
.rs-over{position:absolute;pointer-events:none;overflow:visible}
.rs-bubbles,.rs-hit{position:absolute;left:0;top:0;width:550px;height:310px;transform-origin:0 0}
.rs-bubbles{pointer-events:none}
.rs-hit{cursor:default}
.rs-svg{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible}
.rs-svg [data-h]{pointer-events:all}
.rs-bubble{position:absolute;pointer-events:none;font:600 14px/1.25 var(--font,system-ui,sans-serif);color:#111}
.rs-bubble svg{position:absolute;left:0;top:0;overflow:visible;pointer-events:none}
.rs-bubble .rs-bt{position:relative;display:block;padding:9px 16px;max-width:230px;text-align:center;white-space:pre-wrap;overflow-wrap:anywhere}
.rs-bubble[data-dim]{opacity:.38}
.rs-bubble[data-sel]{filter:drop-shadow(0 0 0 transparent)}
.rs-tools{position:absolute;display:flex;gap:2px;padding:3px;border-radius:8px;background:oklch(0.2 0.03 262 / .94);box-shadow:0 6px 20px -4px oklch(0.05 0.02 262 / .6),0 0 0 1px oklch(0.4 0.03 262 / .6);z-index:3}
.rs-tools[hidden]{display:none}
.rs-tools button{all:unset;box-sizing:border-box;width:30px;height:30px;display:grid;place-items:center;border-radius:6px;color:oklch(0.92 0.01 258);cursor:pointer}
.rs-tools button:hover{background:oklch(0.34 0.04 262)}
.rs-tools button:focus-visible{outline:2px solid var(--accent,#3dd6e6);outline-offset:-2px}
.rs-tools button[data-danger]:hover{background:oklch(0.4 0.12 27)}
.rs-tools svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.rs-status{position:absolute;inset:0;display:grid;place-items:center;pointer-events:none;color:oklch(0.78 0.02 258);font:500 13px var(--font,system-ui,sans-serif);text-align:center;z-index:2}
.rs-status[hidden]{display:none}
.rs-status .rs-card{display:grid;gap:10px;justify-items:center;padding:14px 18px;border-radius:12px;background:oklch(0.2 0.03 262 / .92);pointer-events:auto;max-width:min(340px,86%)}
.rs-status p{margin:0}
.rs-spin{width:22px;height:22px;border-radius:50%;border:2px solid oklch(0.45 0.03 262);border-top-color:var(--accent,#3dd6e6);animation:rs-spin .8s linear infinite}
@keyframes rs-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.rs-spin{animation-duration:2.4s}}
.rs-btn{all:unset;box-sizing:border-box;padding:6px 12px;border-radius:7px;background:oklch(0.34 0.04 262);color:oklch(0.96 0.01 258);cursor:pointer;font:600 12px var(--font,system-ui,sans-serif)}
.rs-btn:hover{background:oklch(0.4 0.05 262)}
.rs-btn:focus-visible{outline:2px solid var(--accent,#3dd6e6);outline-offset:2px}
.rs-chip{position:absolute;left:8px;bottom:8px;display:flex;gap:8px;align-items:center;padding:5px 6px 5px 10px;border-radius:999px;background:oklch(0.2 0.03 262 / .92);color:oklch(0.9 0.02 258);font:500 12px var(--font,system-ui,sans-serif);z-index:3;box-shadow:0 0 0 1px oklch(0.45 0.1 27 / .7)}
.rs-chip[hidden]{display:none}
.rs-busy{position:absolute;right:8px;top:8px;width:16px;height:16px;border-radius:50%;border:2px solid oklch(0.5 0.03 262 / .5);border-top-color:var(--accent,#3dd6e6);animation:rs-spin .8s linear infinite;z-index:3;pointer-events:none}
.rs-busy[hidden]{display:none}
.rs-hint{position:absolute;inset:0;display:grid;place-items:center;color:#8a93a3;font:500 14px var(--font,system-ui,sans-serif);pointer-events:none;text-align:center;padding:0 24px}
.rs-hint[hidden]{display:none}
.rs-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
`;

let cssInjected = false;
function injectCss() {
  if (cssInjected || document.getElementById('rs-style')) { cssInjected = true; return; }
  const s = document.createElement('style');
  s.id = 'rs-style';
  s.textContent = CSS;
  document.head.appendChild(s);
  cssInjected = true;
}

const ICON = {
  flip: '<path d="M12 3v18"/><path d="M8 7 3 12l5 5V7Z"/><path d="m16 7 5 5-5 5V7Z"/>',
  trash: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 12h10l1-12"/><path d="M9 7V4h6v3"/>',
  front: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M4 16V6a2 2 0 0 1 2-2h10"/>',
  back: '<rect x="4" y="4" width="12" height="12" rx="2"/><path d="M20 8v10a2 2 0 0 1-2 2H8"/>',
};
const svgIcon = (k) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[k]}</svg>`;

/** Walk to the action asset id for a character elem: action, else emotion, else the elem's own (default action) id. */
export function charAssetId(elem) {
  const pick = elem.action || elem.emotion;
  if (!pick) return elem.assetId;
  const segs = String(pick).split('.');
  if (segs.length >= 4) return pick; // already "theme.char.file.swf"
  const base = String(elem.assetId).split('.');
  if (/^default(\.swf)?$/i.test(pick)) return elem.assetId;
  return `${base[0]}.${base[1]}.${pick}`;
}

/**
 * @param {HTMLElement} container
 * @param {{store: any, themes?: any, audio?: any}} opts
 */
export async function createStage(container, { store, themes, audio } = {}) {
  injectCss();
  const themesMod = themes ?? (await import('./themes.js').catch(() => null));
  const pool = getPool();

  // ------------------------------------------------------------------------------------------ DOM
  const root = document.createElement('div');
  root.className = 'rs-root';
  root.tabIndex = 0;
  root.setAttribute('role', 'application');
  root.setAttribute('aria-label', 'Stage. Arrow keys nudge the selected item, Delete removes it.');
  root.innerHTML = `
    <div class="rs-view" data-view>
      <div class="rs-canvas" data-canvas></div>
      <div class="rs-hint" data-hint hidden></div>
      <div class="rs-bubbles" data-bubbles></div>
      <div class="rs-hit" data-hit></div>
      <div class="rs-busy" data-busy hidden role="status" aria-label="Loading assets"></div>
    </div>
    <div class="rs-over" data-over><svg class="rs-svg" data-svg viewBox="0 0 ${STAGE_W} ${STAGE_H}" preserveAspectRatio="none"></svg></div>
    <div class="rs-tools" data-tools hidden role="toolbar" aria-label="Selection tools"></div>
    <div class="rs-chip" data-chip hidden></div>
    <div class="rs-status" data-status><div class="rs-card"><div class="rs-spin" role="progressbar" aria-label="Starting"></div><p>Starting the stage</p></div></div>
    <div class="rs-sr" data-live aria-live="polite"></div>`;
  container.appendChild(root);
  const $ = (n) => root.querySelector(`[data-${n}]`);
  const viewEl = $('view'), overEl = $('over'), canvasEl = $('canvas'), bubblesEl = $('bubbles'), svgEl = $('svg'), hitEl = $('hit');
  const toolsEl = $('tools'), statusEl = $('status'), chipEl = $('chip'), busyEl = $('busy'), hintEl = $('hint'), liveEl = $('live');
  bubblesEl.style.transformOrigin = '0 0'; hitEl.style.transformOrigin = '0 0';

  // ------------------------------------------------------------------------------------------ state
  /** @type {import('./ruffle-pool.js').Host|null} */
  let host = null;
  let hostError = null;
  let destroyed = false;
  let tool = 'select';
  let view = { x: 0, y: 0, w: 0, h: 0, k: 1 };
  /** @type {Map<string, Layer>} */
  const layers = new Map();
  let seq = 0;
  let pendingLoads = 0;
  let orderSig = '';
  let dirty = { reconcile: true, overlay: true, bubbles: true, time: true };
  let rafId = 0;
  let idleTimer = 0;
  let commitTimer = 0;
  let activeSceneId = null;
  let committedSceneId = null;
  let ownClock = null; // fallback clock when there is no audio engine
  let ownRaf = 0;
  let curPlaying = false;
  let lastTimeSig = '';
  let gesture = null;
  let gseq = 0;
  let hoverRaf = 0;
  let hoverEvt = null;
  const failures = new Map();
  const offs = [];
  const on = (t, ev, fn, o) => { t.addEventListener(ev, fn, o); offs.push(() => t.removeEventListener(ev, fn, o)); };

  /**
   * @typedef {Object} Layer
   * @property {string} key  @property {string} sceneId  @property {'bg'|'char'|'prop'|'effect'} kind
   * @property {any} elem    @property {string} url  @property {string|null} hostId  @property {string|null} pendingId
   * @property {'loading'|'ready'|'error'|'placeholder'} status  @property {number[]|null} bounds  @property {number} frames
   * @property {any} applied @property {'stopped'|'playing'} mode  @property {number} lastFrame  @property {boolean} loop
   */

  const st = () => store.get();
  const movie = () => st().movie;
  const sceneNow = () => findScene(movie(), st().selection.sceneId) ?? movie().scenes[0] ?? null;
  const isPlaying = () => st().playing;

  // ------------------------------------------------------------------------------------------ asset urls
  function urlFor(kind, elem) {
    const m = movie();
    try {
      if (kind === 'char') {
        const id = charAssetId(elem);
        if (/\.xml$/i.test(id) || !/\.swf$/i.test(id)) return '';
        return themesMod?.assetUrl?.(id, m.themeId, { kind: 'char', movieId: m.id ?? '' }) ?? '';
      }
      return themesMod?.assetUrl?.(elem.assetId, m.themeId, { kind, movieId: m.id ?? '' }) ?? '';
    } catch { return ''; }
  }

  function loopFlag(kind, elem) {
    if (kind !== 'char') return true;
    const a = themesMod?.findAsset?.(charAssetId(elem));
    return a?.loop ?? true;
  }

  // ------------------------------------------------------------------------------------------ layout
  function layout() {
    const w = root.clientWidth, h = root.clientHeight;
    const pad = w > 520 && h > 300 ? 12 : 0;
    const f = fitView(w - pad * 2, h - pad * 2);
    view = { ...f, x: f.x + pad, y: f.y + pad };
    for (const el of [viewEl, overEl]) Object.assign(el.style, { left: `${view.x}px`, top: `${view.y}px`, width: `${view.w}px`, height: `${view.h}px` });
    const t = `scale(${view.k})`;
    bubblesEl.style.transform = t; hitEl.style.transform = t;
    dirty.overlay = true; dirty.bubbles = true;
    schedule();
  }
  const ro = new ResizeObserver(() => layout());
  ro.observe(root);

  function clientToStage(cx, cy) {
    const r = viewEl.getBoundingClientRect();
    return { x: ((cx - r.left) / (r.width || 1)) * STAGE_W, y: ((cy - r.top) / (r.height || 1)) * STAGE_H };
  }

  // ------------------------------------------------------------------------------------------ host lifecycle
  async function startHost() {
    try {
      host = await pool.acquire({ container: canvasEl, keep: true, autoPause: false, width: STAGE_W, height: STAGE_H, quality: getPrefs().quality || 'medium' });
      if (destroyed) { host.release(); host = null; return; }
      statusEl.hidden = true;
      dirty.reconcile = true; dirty.time = true;
      wake();
      schedule();
    } catch (e) {
      hostError = e;
      showStatus('error', e?.message || 'The stage could not start.');
    }
  }

  function showStatus(kind, msg) {
    statusEl.hidden = false;
    if (kind === 'error') {
      statusEl.innerHTML = `<div class="rs-card" role="alert"><p>${esc(msg)}</p><button class="rs-btn" type="button" data-retry>Try again</button></div>`;
      statusEl.querySelector('[data-retry]').addEventListener('click', () => {
        hostError = null;
        statusEl.innerHTML = '<div class="rs-card"><div class="rs-spin" role="progressbar" aria-label="Starting"></div><p>Starting the stage</p></div>';
        startHost();
      });
    }
  }

  /** Keep Ruffle's frame loop running while anything is changing or playing; pause it after a quiet moment. */
  function wake() {
    if (!host || destroyed) return;
    clearTimeout(idleTimer);
    if (!document.hidden) host.setPaused(false);
    if (!isPlaying() && !pendingLoads) idleTimer = setTimeout(() => { if (!isPlaying() && !pendingLoads && !gesture) host?.setPaused(true); }, IDLE_PAUSE_MS);
  }

  // ------------------------------------------------------------------------------------------ layers
  const layerKey = (sceneId, elemId) => `${sceneId}/${elemId}`;

  function desiredLayers(scene, out) {
    if (!scene) return;
    const add = (elem, kind) => { if (elem) out.set(layerKey(scene.id, elem.id), { sceneId: scene.id, kind, elem }); };
    add(scene.bg, 'bg');
    scene.props.forEach((e) => add(e, 'prop'));
    scene.chars.forEach((e) => add(e, 'char'));
    scene.effects.forEach((e) => add(e, 'effect'));
  }

  function reconcile() {
    if (!host) return;
    const m = movie();
    const scene = sceneNow();
    const want = new Map();
    desiredLayers(scene, want);
    // while playing keep the next scene warm so the cut is instant
    if (isPlaying() && scene) {
      const i = m.scenes.indexOf(scene);
      const next = m.scenes[i + 1];
      if (next && timeLeftInScene(scene) < PREFETCH_MS) desiredLayers(next, want);
    }
    if (activeSceneId !== (scene?.id ?? null)) {
      activeSceneId = scene?.id ?? null;
      beginCommit();
    }
    // the scene currently on screen stays alive until the new one is ready to replace it
    const holdScene = committedSceneId && committedSceneId !== activeSceneId ? committedSceneId : null
    for (const [key, w] of want) {
      let layer = layers.get(key);
      const url = w.kind === 'char' && !urlFor('char', w.elem) ? '' : urlFor(w.kind, w.elem);
      if (!layer) {
        layer = { key, sceneId: w.sceneId, kind: w.kind, elem: w.elem, url, hostId: null, pendingId: null, status: 'loading', bounds: null, frames: 1, applied: {}, mode: 'stopped', lastFrame: 0, loop: loopFlag(w.kind, w.elem) };
        layers.set(key, layer);
        loadLayer(layer, url);
      } else {
        layer.elem = w.elem;
        if (layer.url !== url) { layer.loop = loopFlag(w.kind, w.elem); loadLayer(layer, url); }
      }
    }
    for (const [key, layer] of layers) {
      if (!want.has(key) && layer.sceneId !== holdScene) { dropLayer(layer); layers.delete(key); failures.delete(key); }
    }
    if (committedSceneId !== activeSceneId) maybeCommit();
    updateOrder();
    applyAll();
    updateChrome();
  }

  function dropLayer(layer) {
    layer.pendingId = null;
    if (layer.hostId) host?.remove(layer.hostId);
    layer.hostId = null;
  }

  function loadLayer(layer, url) {
    layer.url = url;
    if (!url) {
      // custom characters (.xml) and unknown assets cannot be drawn by Ruffle: show a placeholder silhouette
      if (layer.hostId) host.remove(layer.hostId);
      layer.hostId = null; layer.pendingId = null;
      layer.status = 'placeholder';
      layer.bounds = layer.kind === 'char' ? CC_BOX : FALLBACK_BOX;
      layer.applied = {};
      return;
    }
    const id = `L${++seq}`;
    layer.pendingId = id;
    if (layer.status !== 'ready') layer.status = 'loading';
    pendingLoads++;
    updateChrome();
    wake();
    host.load(id, url).then(({ frames }) => {
      pendingLoads--;
      if (destroyed || layer.pendingId !== id || layers.get(layer.key) !== layer) { host?.remove(id); updateChrome(); return; }
      const old = layer.hostId;
      layer.hostId = id; layer.pendingId = null; layer.status = 'ready'; layer.frames = frames || 1;
      layer.bounds = sanitizeBounds(host.bounds(id), layer.kind);
      layer.applied = {}; layer.mode = 'stopped'; layer.lastFrame = 0;
      failures.delete(layer.key);
      if (old) host.remove(old);
      orderSig = '';
      dirty.overlay = true; dirty.time = true; lastTimeSig = '';
      updateOrder(); applyAll(); updateChrome(); schedule();
      maybeCommit();
    }).catch((err) => {
      pendingLoads--;
      if (destroyed || layer.pendingId !== id) { updateChrome(); return; }
      layer.pendingId = null;
      if (!layer.hostId) { layer.status = 'error'; layer.bounds = layer.kind === 'char' ? CC_BOX : FALLBACK_BOX; }
      failures.set(layer.key, { layer, message: err?.message || 'failed' });
      dirty.overlay = true;
      updateChrome(); schedule(); maybeCommit();
    });
  }

  function sanitizeBounds(b, kind) {
    if (!Array.isArray(b) || b.length !== 4 || !b.every(Number.isFinite) || b[2] <= 0.5 || b[3] <= 0.5) return kind === 'char' ? CC_BOX : FALLBACK_BOX;
    return b;
  }

  function updateOrder() {
    if (!host) return;
    const list = [...layers.values()].filter((l) => l.hostId).sort((a, b) => zOf(a) - zOf(b));
    const sig = list.map((l) => l.hostId).join(',');
    if (sig === orderSig) return;
    orderSig = sig;
    list.forEach((l, i) => host.setOrder(l.hostId, i));
  }
  const zOf = (l) => (l.kind === 'bg' ? -1e9 : (l.elem.z ?? 0));

  // ---- scene switching: keep the previous scene on screen until the new one has (mostly) loaded
  function beginCommit() {
    clearTimeout(commitTimer);
    commitTimer = setTimeout(() => { commitNow(); }, COMMIT_WAIT_MS);
  }
  function maybeCommit() {
    if (committedSceneId === activeSceneId) return;
    const wanting = [...layers.values()].filter((l) => l.sceneId === activeSceneId);
    if (wanting.every((l) => l.status !== 'loading')) commitNow();
  }
  function commitNow() {
    clearTimeout(commitTimer);
    if (committedSceneId === activeSceneId) return;
    committedSceneId = activeSceneId;
    // restart per-scene animations from their first frame
    for (const l of layers.values()) if (l.sceneId === activeSceneId) { l.mode = 'stopped'; l.lastFrame = 0; l.applied.vis = undefined; }
    lastTimeSig = '';
    dirty.reconcile = true; dirty.time = true; dirty.overlay = true; dirty.bubbles = true;
    applyAll();
    schedule();
  }

  // ------------------------------------------------------------------------------------------ transforms + time
  function curMs() {
    if (isPlaying()) {
      if (audio?.time) return audio.time();
      if (ownClock) return ownClock.ms0 + (performance.now() - ownClock.t0);
    }
    return st().playhead;
  }

  function timeLeftInScene(scene) {
    const m = movie();
    const start = sceneStart(m, scene.id);
    return scene.duration - (curMs() - start);
  }

  const cameraOn = () => isPlaying();

  /** Placement actually drawn for an element: model values, then the (playing-only) camera. */
  function placement(layer) {
    const e = layer.elem;
    let p = { x: e.x, y: e.y, scale: e.scale ?? 1, rotation: e.rotation ?? 0, flip: !!e.flip };
    if (layer.kind === 'bg') p = { x: 0, y: 0, scale: e.scale ?? 1, rotation: 0, flip: false };
    if (cameraOn()) {
      const sc = findScene(movie(), layer.sceneId);
      p = applyCamera(p, sc?.camera);
    }
    return p;
  }

  function applyAll() {
    if (!host) return;
    const t = curMs();
    const m = movie();
    for (const layer of layers.values()) applyLayer(layer, t, m);
  }

  function applyLayer(layer, t, m) {
    if (!layer.hostId || layer.status !== 'ready') return;
    const sceneStartMs = sceneStart(m, layer.sceneId);
    const local = t - sceneStartMs;
    const inScene = layer.sceneId === committedSceneId;
    const visible = inScene && (layer.kind === 'bg' || inWindow(layer.elem, local)) && !failedHidden(layer);
    const p = placement(layer);
    const [sx, sy] = drawScale(p);
    const next = { x: round2(p.x), y: round2(p.y), sx: round4(sx), sy: round4(sy), rot: round2(p.rotation), vis: visible };
    const a = layer.applied;
    const id = layer.hostId;
    if (a.x !== next.x) host.put(id, 'x', next.x);
    if (a.y !== next.y) host.put(id, 'y', next.y);
    if (a.sx !== next.sx) host.put(id, 'scaleX', next.sx);
    if (a.sy !== next.sy) host.put(id, 'scaleY', next.sy);
    if (a.rot !== next.rot) host.put(id, 'rotation', next.rot);
    if (a.vis !== next.vis) host.put(id, 'visible', next.vis);
    layer.applied = next;

    // timeline: play on its own while the movie plays, otherwise show the frame for the playhead
    if (layer.kind === 'bg' || layer.frames <= 1 && layer.kind !== 'char') return;
    const elapsed = local - (layer.elem.start ?? 0);
    if (isPlaying()) {
      if (visible && layer.mode !== 'playing') {
        host.call(id, 'content.gotoAndPlay', frameAt(elapsed, { total: layer.frames, loop: layer.loop }));
        layer.mode = 'playing';
      } else if (!visible && layer.mode === 'playing') { host.call(id, 'content.stop'); layer.mode = 'stopped'; layer.lastFrame = 0; }
    } else {
      const f = frameAt(visible ? elapsed : 0, { total: layer.frames, loop: layer.loop });
      if (layer.mode !== 'stopped' || layer.lastFrame !== f) {
        host.call(id, 'content.gotoAndStop', f);
        layer.mode = 'stopped'; layer.lastFrame = f;
      }
    }
  }
  const failedHidden = () => false;
  const round4 = (v) => Math.round(v * 10000) / 10000;

  // ------------------------------------------------------------------------------------------ chrome (status chips, hint)
  function updateChrome() {
    busyEl.hidden = !(pendingLoads > 0);
    const errs = [...failures.values()].filter((f) => layers.get(f.layer.key) === f.layer);
    if (errs.length) {
      chipEl.hidden = false;
      chipEl.innerHTML = `<span>${errs.length} asset${errs.length > 1 ? 's' : ''} could not load</span><button class="rs-btn" type="button" data-retry-assets>Retry</button>`;
      chipEl.querySelector('[data-retry-assets]').onclick = () => {
        for (const f of errs) { f.layer.status = 'loading'; failures.delete(f.layer.key); loadLayer(f.layer, f.layer.url); }
        updateChrome();
      };
    } else chipEl.hidden = true;
    const sc = sceneNow();
    const empty = !!sc && !sc.bg && !sc.chars.length && !sc.props.length && !sc.effects.length && !sc.bubbles.length;
    hintEl.hidden = !empty;
    if (empty) hintEl.innerHTML = '<span>Add a background from the Assets panel to start your scene.</span>';
  }

  // ------------------------------------------------------------------------------------------ bubbles
  const bubbleNodes = new Map();

  function renderBubbles() {
    const scene = sceneNow();
    const t = curMs();
    const local = scene ? t - sceneStart(movie(), scene.id) : 0;
    const playing = isPlaying();
    const selId = st().selection.kind === 'bubble' ? st().selection.elemId : null;
    const seen = new Set();
    for (const b of scene?.bubbles ?? []) {
      const active = local >= b.start && local < b.end;
      if (playing && !active && b.id !== selId) continue;
      seen.add(b.id);
      let n = bubbleNodes.get(b.id);
      if (!n) {
        n = document.createElement('div');
        n.className = 'rs-bubble';
        n.innerHTML = '<svg aria-hidden="true"></svg><span class="rs-bt"></span>';
        bubblesEl.appendChild(n);
        bubbleNodes.set(b.id, n);
        n._sig = '';
      }
      const tgt = b.targetId ? layerFor(scene.id, b.targetId) : null;
      const tp = tgt?.bounds ? topOfBox(tgt) : null;
      const sig = `${b.text}|${b.style}|${Math.round(b.x)}|${Math.round(b.y)}|${tp ? `${Math.round(tp[0])},${Math.round(tp[1])}` : ''}`;
      n.toggleAttribute('data-dim', !active && !playing);
      n.toggleAttribute('data-sel', b.id === selId);
      if (n._sig !== sig) {
        n._sig = sig;
        const span = n.querySelector('.rs-bt');
        span.textContent = b.text || ' ';
        span.style.font = b.style === 'shout' ? '800 16px/1.2 var(--font, system-ui, sans-serif)' : '';
        span.style.fontStyle = b.style === 'whisper' ? 'italic' : '';
        const w = Math.max(60, span.offsetWidth), h = Math.max(34, span.offsetHeight);
        const left = b.x - w / 2, top = b.y - h / 2;
        n.style.cssText = `left:${left}px;top:${top}px;width:${w}px;height:${h}px`;
        const tail = tp ? [tp[0] - left, tp[1] - top] : [w * 0.3, h + 22];
        const svg = n.querySelector('svg');
        svg.setAttribute('width', w); svg.setAttribute('height', h);
        const stroke = b.style === 'whisper' ? 'stroke-dasharray="5 4" ' : '';
        let extra = '';
        if (b.style === 'think') extra = thoughtDots(w, h, tail).map((d) => `<circle cx="${d.x.toFixed(1)}" cy="${d.y.toFixed(1)}" r="${d.r}" fill="#fff" stroke="#222" stroke-width="2"/>`).join('');
        svg.innerHTML = `<path d="${bubblePath(b.style, w, h, b.style === 'think' ? null : tail)}" fill="#fff" stroke="#222" stroke-width="2" stroke-linejoin="round" ${stroke}/>${extra}`;
        n._box = [left, top, w, h];
      }
    }
    for (const [id, n] of bubbleNodes) if (!seen.has(id)) { n.remove(); bubbleNodes.delete(id); }
  }

  function layerFor(sceneId, elemId) { return layers.get(layerKey(sceneId, elemId)); }

  function topOfBox(layer) {
    const q = orientedBox(placementPublic(layer), layer.bounds);
    const minY = Math.min(...q.map((p) => p[1]));
    const cx = q.reduce((a, p) => a + p[0], 0) / 4;
    return [cx, minY + 6];
  }

  /** Elem-like object with the model placement (no camera) for geometry. */
  function placementPublic(layer) {
    const e = layer.elem;
    return layer.kind === 'bg' ? { ...e, x: 0, y: 0, rotation: 0, flip: false } : e;
  }

  // ------------------------------------------------------------------------------------------ overlay
  /** Editing is off while playing, in the read-only 'view' tool, and in the shell's full-screen preview. */
  function editable() { return tool === 'select' && !isPlaying() && !root.closest('.is-preview'); }

  function selectedTarget() {
    const sel = st().selection;
    if (!sel?.elemId || !editable()) return null;
    const scene = sceneNow();
    if (!scene) return null;
    if (sel.kind === 'bubble') {
      const b = scene.bubbles.find((x) => x.id === sel.elemId);
      const n = bubbleNodes.get(sel.elemId);
      return b && n?._box ? { type: 'bubble', bubble: b, box: n._box } : null;
    }
    const hit = findElem(scene, sel.elemId);
    if (!hit) return null;
    const layer = layerFor(scene.id, sel.elemId);
    if (!layer?.bounds) return null;
    return { type: 'elem', layer, kind: hit.kind, elem: hit.elem };
  }

  /** Dashed silhouettes for assets Ruffle cannot draw (custom characters) or that failed to load. */
  function placeholdersSvg() {
    const k = view.k || 1;
    let out = '';
    for (const l of layers.values()) {
      if (l.sceneId !== committedSceneId || (l.status !== 'placeholder' && l.status !== 'error') || !l.bounds) continue;
      const q = orientedBox(placementPublic(l), l.bounds);
      const [cx, cy] = boxCenter(placementPublic(l), l.bounds);
      const label = l.status === 'error' ? 'Could not load' : l.kind === 'char' ? 'Custom character' : 'Unavailable';
      out += `<polygon points="${q.map((p) => p.join(',')).join(' ')}" fill="rgba(120,130,150,.14)" stroke="#8a93a3" stroke-width="${1.4 / k}" stroke-dasharray="${5 / k} ${4 / k}"/>` +
        `<text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="middle" font-size="${11 / k}" fill="#3d4557" stroke="#fff" stroke-width="${3 / k}" paint-order="stroke" font-family="system-ui,sans-serif">${label}</text>`;
    }
    return out;
  }

  function drawOverlay() {
    const target = selectedTarget();
    const k = view.k || 1;
    const ph = placeholdersSvg();
    if (!target) {
      // a scene with a custom camera shows the framed region while nothing is selected
      const sc = sceneNow();
      const cam = sc?.camera;
      let frame = '';
      if (cam && cam.zoom > 0 && st().selection.kind === 'scene' && !isPlaying()) {
        const w = STAGE_W / cam.zoom, h = STAGE_H / cam.zoom;
        frame = `<rect x="${cam.x - w / 2}" y="${cam.y - h / 2}" width="${w}" height="${h}" fill="none" stroke="${SELECT_COLOR}" stroke-width="${1.6 / k}" stroke-dasharray="${6 / k} ${4 / k}"/>`;
      }
      svgEl.innerHTML = ph + frame; toolsEl.hidden = true; return;
    }
    const sw = 1.6 / k, hs = 5.5 / k;
    if (target.type === 'bubble') {
      const [x, y, w, h] = target.box;
      svgEl.innerHTML = ph + `<rect x="${x - 3}" y="${y - 3}" width="${w + 6}" height="${h + 6}" rx="${8}" fill="none" stroke="${SELECT_COLOR}" stroke-width="${sw}" stroke-dasharray="${5 / k} ${4 / k}"/>`;
      positionTools(x + w / 2, y + h + 8, [['delete', 'Delete bubble', 'trash', true]]);
      return;
    }
    const { layer, kind, elem } = target;
    if (kind === 'bg') {
      svgEl.innerHTML = ph + `<rect x="1" y="1" width="${STAGE_W - 2}" height="${STAGE_H - 2}" fill="none" stroke="${SELECT_COLOR}" stroke-width="${sw * 1.4}" stroke-dasharray="${6 / k} ${4 / k}"/>`;
      positionTools(STAGE_W / 2, STAGE_H - 6, [['delete', 'Remove background', 'trash', true]], true);
      return;
    }
    const q = orientedBox(elem, layer.bounds);
    const pts = q.map((p) => p.join(',')).join(' ');
    const [cx, cy] = boxCenter(elem, layer.bounds);
    // rotate handle sits above the top edge midpoint, outside the box
    const top = [(q[0][0] + q[1][0]) / 2, (q[0][1] + q[1][1]) / 2];
    let nx = top[0] - cx, ny = top[1] - cy;
    const nl = Math.hypot(nx, ny) || 1;
    const off = 22 / k;
    const rot = [top[0] + (nx / nl) * off, top[1] + (ny / nl) * off];
    const handle = (p, name, cursor) => `<rect data-h="${name}" x="${p[0] - hs}" y="${p[1] - hs}" width="${hs * 2}" height="${hs * 2}" rx="${1.5 / k}" fill="#fff" stroke="${SELECT_COLOR}" stroke-width="${sw}" style="cursor:${cursor}"/>`;
    const curs = ['nwse-resize', 'nesw-resize', 'nwse-resize', 'nesw-resize'];
    svgEl.innerHTML = ph + `
      <polygon points="${pts}" fill="none" stroke="${SELECT_COLOR}" stroke-width="${sw}" vector-effect="non-scaling-stroke"/>
      <line x1="${top[0]}" y1="${top[1]}" x2="${rot[0]}" y2="${rot[1]}" stroke="${SELECT_COLOR}" stroke-width="${sw}"/>
      <circle data-h="rotate" cx="${rot[0]}" cy="${rot[1]}" r="${hs * 1.05}" fill="#fff" stroke="${SELECT_COLOR}" stroke-width="${sw}" style="cursor:grab"/>
      ${q.map((p, i) => handle(p, `scale${i}`, curs[i])).join('')}`;
    const bottom = q.reduce((a, p) => (p[1] > a[1] ? p : a), q[0]);
    const topmost = Math.min(rot[1], ...q.map((p) => p[1]));
    positionTools(Math.min(Math.max(cx, 60), STAGE_W - 60), bottom[1] + 16 / k, [
      ['flip', 'Flip horizontally', 'flip'], ['front', 'Bring to front', 'front'], ['back', 'Send to back', 'back'], ['delete', 'Delete', 'trash', true],
    ], false, topmost - 12 / k);
  }

  /** Float the tool strip under (or, when there is no room, above) the selection. y values are stage units. */
  function positionTools(sx, syBelow, buttons, up = false, syAbove = null) {
    const sig = buttons.map((b) => b[0]).join();
    if (toolsEl.dataset.sig !== sig) {
      toolsEl.dataset.sig = sig;
      toolsEl.innerHTML = buttons.map(([a, label, ic, danger]) => `<button type="button" data-act="${a}" title="${label}" aria-label="${label}"${danger ? ' data-danger' : ''}>${svgIcon(ic)}</button>`).join('');
    }
    toolsEl.hidden = false;
    const wBtn = toolsEl.offsetWidth || buttons.length * 32 + 6;
    const hBtn = toolsEl.offsetHeight || 36;
    const px = view.x + sx * view.k;
    let top = view.y + syBelow * view.k;
    if (up) top -= hBtn + 4;
    else if (syAbove != null && top + hBtn > root.clientHeight - 4) top = view.y + syAbove * view.k - hBtn;
    const left = Math.min(Math.max(px - wBtn / 2, 4), root.clientWidth - wBtn - 4);
    top = Math.min(Math.max(top, 4), root.clientHeight - hBtn - 4);
    toolsEl.style.left = `${Math.round(left)}px`;
    toolsEl.style.top = `${Math.round(top)}px`;
  }

  on(toolsEl, 'click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    e.stopPropagation();
    const sel = st().selection, scene = sceneNow();
    if (!scene || !sel.elemId) return;
    const act = btn.dataset.act;
    if (act === 'delete') return deleteSelection();
    const layer = layerFor(scene.id, sel.elemId);
    const hit = findElem(scene, sel.elemId);
    if (!hit) return;
    if (act === 'flip' && layer?.bounds) store.dispatch({ type: 'updateElem', sceneId: scene.id, elemId: sel.elemId, patch: flipAboutCenter(hit.elem, layer.bounds) });
    if (act === 'front' || act === 'back') store.dispatch({ type: 'reorderElem', sceneId: scene.id, elemId: sel.elemId, to: act });
    root.focus({ preventScroll: true });
  });

  function deleteSelection() {
    const sel = st().selection, scene = sceneNow();
    if (!scene || !sel.elemId) return false;
    if (sel.kind === 'bubble') store.dispatch({ type: 'removeBubble', sceneId: scene.id, bubbleId: sel.elemId });
    else if (sel.kind === 'bg') store.dispatch({ type: 'setBackground', sceneId: scene.id, assetId: '' });
    else if (sel.kind === 'char' || sel.kind === 'prop' || sel.kind === 'effect') store.dispatch({ type: 'removeElem', sceneId: scene.id, elemId: sel.elemId });
    else return false;
    announce('Deleted');
    return true;
  }

  function announce(msg) { liveEl.textContent = ''; setTimeout(() => { liveEl.textContent = msg; }, 20); }

  // ------------------------------------------------------------------------------------------ hit testing
  function drawOrderTopFirst(scene) {
    const list = [...scene.props.map((e) => ['prop', e]), ...scene.chars.map((e) => ['char', e]), ...scene.effects.map((e) => ['effect', e])];
    list.sort((a, b) => (b[1].z ?? 0) - (a[1].z ?? 0));
    return list;
  }

  /** @returns {{elemId:string, kind:string}|null} */
  function hitTest(x, y) {
    const scene = sceneNow();
    if (!scene) return null;
    const local = curMs() - sceneStart(movie(), scene.id);
    for (const b of [...scene.bubbles].reverse()) {
      const n = bubbleNodes.get(b.id);
      if (n?._box && x >= n._box[0] && x <= n._box[0] + n._box[2] && y >= n._box[1] && y <= n._box[1] + n._box[3]) return { elemId: b.id, kind: 'bubble' };
    }
    const order = drawOrderTopFirst(scene).filter(([, e]) => inWindow(e, local));
    // 1) shape-accurate
    for (const [kind, e] of order) {
      const layer = layerFor(scene.id, e.id);
      if (layer?.hostId && layer.status === 'ready' && host.hit(layer.hostId, x, y)) return { elemId: e.id, kind };
    }
    // 2) generous: smallest oriented box containing the point (placeholders and thin line art)
    let best = null, bestArea = Infinity;
    for (const [kind, e] of order) {
      const layer = layerFor(scene.id, e.id);
      if (!layer?.bounds) continue;
      const q = orientedBox(e, layer.bounds);
      if (inQuad(q, x, y)) {
        const a = quadArea(q);
        if (a < bestArea) { bestArea = a; best = { elemId: e.id, kind }; }
      }
    }
    if (best) return best;
    if (scene.bg) return { elemId: scene.bg.id, kind: 'bg' };
    return null;
  }

  // ------------------------------------------------------------------------------------------ pointer interaction
  on(root, 'pointerdown', (e) => { if (e.target === root && e.button === 0 && tool === 'select' && !isPlaying()) { const sc = sceneNow(); if (sc) store.dispatch({ type: 'select', sceneId: sc.id, elemId: null, kind: 'scene' }); root.focus({ preventScroll: true }); } });
  on(hitEl, 'pointerdown', onPointerDown);
  on(svgEl, 'pointerdown', onPointerDown);
  function onPointerDown(e) {
    if (e.button !== 0 || !editable() || !host) return;
    root.focus({ preventScroll: true });
    const p = clientToStage(e.clientX, e.clientY);
    const scene = sceneNow();
    if (!scene) return;
    const handleName = e.target?.dataset?.h;
    const sel = st().selection;
    if (isPlaying()) return;
    if (handleName) {
      const target = selectedTarget();
      if (target?.type === 'elem') beginTransform(e, handleName, target, p);
      return;
    }
    const hit = hitTest(p.x, p.y);
    if (!hit) {
      store.dispatch({ type: 'select', sceneId: scene.id, elemId: null, kind: 'scene' });
      return;
    }
    if (sel.elemId !== hit.elemId || sel.kind !== hit.kind) store.dispatch({ type: 'select', sceneId: scene.id, elemId: hit.elemId, kind: hit.kind });
    if (hit.kind === 'bg') return;
    const subject = hit.kind === 'bubble' ? scene.bubbles.find((b) => b.id === hit.elemId) : findElem(scene, hit.elemId)?.elem;
    if (!subject) return;
    gesture = { type: 'move', co: `drag-${hit.elemId}-${++gseq}`, pointer: e.pointerId, sceneId: scene.id, id: hit.elemId, kind: hit.kind, ox: subject.x, oy: subject.y, px: p.x, py: p.y, moved: false };
    hitEl.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  }

  function beginTransform(e, name, target, p) {
    const { layer, elem } = target;
    const [cx, cy] = boxCenter(elem, layer.bounds);
    gesture = {
      type: name === 'rotate' ? 'rotate' : 'scale', co: `drag-${elem.id}-${++gseq}`, pointer: e.pointerId, sceneId: sceneNow().id, id: elem.id, kind: target.kind,
      start: { ...elem }, bounds: layer.bounds, cx, cy, d0: Math.hypot(p.x - cx, p.y - cy) || 1, a0: angleDeg(p.x - cx, p.y - cy), moved: true,
    };
    svgEl.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  }

  on(window, 'pointermove', (e) => {
    if (gesture && e.pointerId === gesture.pointer) return dragMove(e);
    if (tool === 'select' && e.target === hitEl) { hoverEvt = e; if (!hoverRaf) hoverRaf = requestAnimationFrame(hoverTick); }
  });
  on(window, 'pointerup', endGesture);
  on(window, 'pointercancel', endGesture);

  function dragMove(e) {
    const g = gesture;
    const p = clientToStage(e.clientX, e.clientY);
    const co = g.co;
    if (g.type === 'move') {
      const dx = p.x - g.px, dy = p.y - g.py;
      if (!g.moved && Math.hypot(dx, dy) * view.k < 3) return;
      g.moved = true;
      const patch = { x: round2(g.ox + dx), y: round2(g.oy + dy) };
      if (g.kind === 'bubble') store.dispatch({ type: 'updateBubble', sceneId: g.sceneId, bubbleId: g.id, patch, coalesce: co });
      else store.dispatch({ type: 'updateElem', sceneId: g.sceneId, elemId: g.id, patch, coalesce: co });
    } else if (g.type === 'scale') {
      const d = Math.hypot(p.x - g.cx, p.y - g.cy);
      const patch = scaleAboutCenter(g.start, g.bounds, d / g.d0);
      store.dispatch({ type: 'updateElem', sceneId: g.sceneId, elemId: g.id, patch, coalesce: co });
    } else if (g.type === 'rotate') {
      let rot = g.start.rotation + normDeg(angleDeg(p.x - g.cx, p.y - g.cy) - g.a0);
      if (e.shiftKey) rot = Math.round(rot / 15) * 15;
      store.dispatch({ type: 'updateElem', sceneId: g.sceneId, elemId: g.id, patch: rotateAboutCenter(g.start, g.bounds, rot), coalesce: co });
    }
    wake();
  }

  function endGesture(e) {
    if (!gesture || (e && e.pointerId !== gesture.pointer)) return;
    gesture = null;
    wake();
  }

  function hoverTick() {
    hoverRaf = 0;
    const e = hoverEvt;
    if (!e || !host || isPlaying() || gesture) return;
    const p = clientToStage(e.clientX, e.clientY);
    const hit = hitTest(p.x, p.y);
    hitEl.style.cursor = hit && hit.kind !== 'bg' ? 'move' : hit ? 'pointer' : 'default';
  }

  // ------------------------------------------------------------------------------------------ keyboard
  const typing = (t) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  /** Tab / Shift+Tab inside the stage walks the selection through background, items (back to front) and bubbles. */
  function cycleSelection(dir) {
    const scene = sceneNow();
    if (!scene) return false;
    const items = [];
    if (scene.bg) items.push({ elemId: scene.bg.id, kind: 'bg', label: 'background' });
    for (const [kind, e] of drawOrderTopFirst(scene).reverse()) items.push({ elemId: e.id, kind, label: kind === 'char' ? 'character' : kind });
    for (const b of scene.bubbles) items.push({ elemId: b.id, kind: 'bubble', label: 'speech bubble' });
    if (!items.length) return false;
    const sel = st().selection;
    const cur = items.findIndex((i) => i.elemId === sel.elemId);
    const next = cur < 0 ? (dir > 0 ? 0 : items.length - 1) : cur + dir;
    if (next < 0 || next >= items.length) return false; // let focus leave the stage
    const it = items[next];
    store.dispatch({ type: 'select', sceneId: scene.id, elemId: it.elemId, kind: it.kind });
    announce(`Selected ${it.label} ${next + 1} of ${items.length}`);
    return true;
  }

  on(window, 'keydown', (e) => {
    if (destroyed || e.defaultPrevented || typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Tab' && document.activeElement === root && editable()) { if (cycleSelection(e.shiftKey ? -1 : 1)) e.preventDefault(); return; }
    if (tool !== 'select' || isPlaying()) return;
    const sel = st().selection;
    if (!sel?.elemId) return;
    const focusedHere = root.contains(document.activeElement) || document.activeElement === document.body;
    if (!focusedHere) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (deleteSelection()) e.preventDefault();
      return;
    }
    if (e.key === 'Escape') { store.dispatch({ type: 'select', sceneId: sel.sceneId, elemId: null, kind: 'scene' }); return; }
    // arrows nudge only while the stage itself has focus (otherwise the timeline uses them to step frames)
    if (!root.contains(document.activeElement)) return;
    const step = e.shiftKey ? 10 : 1;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!d || sel.kind === 'bg') return;
    const scene = sceneNow();
    if (sel.kind === 'bubble') {
      const b = scene?.bubbles.find((x) => x.id === sel.elemId);
      if (b) store.dispatch({ type: 'updateBubble', sceneId: scene.id, bubbleId: b.id, patch: { x: b.x + d[0], y: b.y + d[1] }, coalesce: `nudge-${b.id}-${Math.floor(Date.now() / 700)}` });
    } else {
      const hit = findElem(scene, sel.elemId);
      if (hit) store.dispatch({ type: 'updateElem', sceneId: scene.id, elemId: hit.elem.id, patch: { x: hit.elem.x + d[0], y: hit.elem.y + d[1] }, coalesce: `nudge-${hit.elem.id}-${Math.floor(Date.now() / 700)}` });
    }
    e.preventDefault();
  });

  // ------------------------------------------------------------------------------------------ frame loop (batched)
  function schedule() {
    if (rafId || destroyed) return;
    rafId = requestAnimationFrame(flush);
  }

  function flush() {
    rafId = 0;
    if (destroyed) return;
    if (dirty.reconcile) { dirty.reconcile = false; reconcile(); dirty.overlay = true; dirty.bubbles = true; }
    if (dirty.time) { dirty.time = false; applyAll(); dirty.bubbles = true; }
    if (dirty.bubbles) { dirty.bubbles = false; renderBubbles(); dirty.overlay = true; }
    if (dirty.overlay) { dirty.overlay = false; drawOverlay(); }
    if (host && !isPlaying()) wake();
  }

  /** Called every frame while playing (and on seeks): cheap unless something visible changes. */
  function onTime() {
    if (destroyed || !host) return;
    const m = movie();
    const scene = sceneNow();
    if (!scene) return;
    const t = curMs();
    const local = t - sceneStart(m, scene.id);
    // signature of everything time-dependent that changes what is drawn
    let sig = `${scene.id}|${committedSceneId === scene.id}`;
    for (const e of [...scene.chars, ...scene.props, ...scene.effects]) sig += inWindow(e, local) ? '1' : '0';
    for (const b of scene.bubbles) sig += local >= b.start && local < b.end ? '1' : '0';
    const prefetchNow = isPlaying() && scene.duration - local < PREFETCH_MS;
    sig += prefetchNow ? 'p' : '';
    if (!isPlaying()) sig += `|${Math.floor(local / (1000 / FPS))}`;
    if (sig === lastTimeSig) return;
    lastTimeSig = sig;
    if (prefetchNow) dirty.reconcile = true;
    dirty.time = true; dirty.bubbles = true;
    schedule();
  }

  function onState(state, cmd, prev) {
    if (destroyed) return;
    if (state.movie !== prev.movie || state.selection.sceneId !== prev.selection.sceneId) { dirty.reconcile = true; lastTimeSig = ''; }
    if (state.selection !== prev.selection || state.movie !== prev.movie) { dirty.overlay = true; dirty.bubbles = true; }
    if (state.playing !== prev.playing) onPlayingChange(state.playing);
    else if (state.playhead !== prev.playhead) onTime();
    if (dirty.reconcile || dirty.overlay || dirty.bubbles) { wake(); schedule(); }
  }
  const unsub = store.subscribe(onState);

  function onPlayingChange(playing) {
    curPlaying = playing;
    for (const l of layers.values()) { if (playing) l.mode = 'stopped'; l.lastFrame = 0; }
    lastTimeSig = '';
    if (playing) {
      if (!audio?.onTime) startOwnClock();
      wake();
      host?.setPaused(false);
      gestureCancel();
    } else {
      stopOwnClock();
      lastTimeSig = '';
    }
    dirty.time = true; dirty.overlay = true; dirty.bubbles = true; dirty.reconcile = true;
    schedule();
    announce(playing ? 'Playing' : 'Paused');
  }

  function gestureCancel() { gesture = null; }

  function startOwnClock() {
    ownClock = { t0: performance.now(), ms0: st().playhead };
    const total = () => movie().scenes.reduce((a, s) => a + s.duration, 0);
    const loop = () => {
      ownRaf = 0;
      if (!isPlaying() || destroyed) return;
      const ms = ownClock.ms0 + (performance.now() - ownClock.t0);
      if (ms >= total()) { store.dispatch({ type: 'setPlayhead', ms: total() }); store.dispatch({ type: 'setPlaying', playing: false }); return; }
      store.dispatch({ type: 'setPlayhead', ms: Math.round(ms) });
      onTime();
      ownRaf = requestAnimationFrame(loop);
    };
    ownRaf = requestAnimationFrame(loop);
  }
  function stopOwnClock() { ownClock = null; if (ownRaf) cancelAnimationFrame(ownRaf); ownRaf = 0; }

  if (audio?.onTime) offs.push(audio.onTime(() => onTime()));

  // ------------------------------------------------------------------------------------------ visibility / offscreen
  on(document, 'visibilitychange', () => { if (document.hidden) host?.setPaused(true); else { wake(); dirty.time = true; schedule(); } });
  const io = typeof IntersectionObserver === 'function' ? new IntersectionObserver((entries) => {
    for (const en of entries) { if (!en.isIntersecting) host?.setPaused(true); else { wake(); schedule(); } }
  }) : null;
  io?.observe(root);

  // ------------------------------------------------------------------------------------------ public API
  const stage = {
    el: root,
    container: root,
    get host() { return host; },
    play() { if (audio?.play) audio.play(); else store.dispatch({ type: 'setPlaying', playing: true }); },
    pause() { if (audio?.pause) audio.pause(); else store.dispatch({ type: 'setPlaying', playing: false }); },
    seek(ms) { if (audio?.seek) audio.seek(ms); else store.dispatch({ type: 'setPlayhead', ms }); },
    setPlayhead(ms) { store.dispatch({ type: 'setPlayhead', ms }); },
    hitTest,
    clientToStage,
    setTool(t) {
      tool = t === 'view' ? 'view' : 'select';
      hitEl.style.cursor = tool === 'select' ? 'default' : 'default';
      dirty.overlay = true; schedule();
    },
    getTool: () => tool,
    /** Approximate on-screen rectangle (client px) of the stage. */
    viewRect: () => viewEl.getBoundingClientRect(),
    async thumbnail(assetId, size = 160, kind) {
      const { getAssetThumb } = await import('./thumbs.js');
      return getAssetThumb(assetId, kind || guessKind(assetId), { size });
    },
    /** PNG of the current frame (the live canvas), or null when not available. */
    async snapshot(width = 352) {
      if (!host) return null;
      wake();
      await sleep(30);
      const cv = await host.capture(null, width);
      if (!cv) return null;
      return new Promise((r) => cv.toBlob((b) => r(b), 'image/png'));
    },
    stats() {
      return {
        layers: layers.size, ready: [...layers.values()].filter((l) => l.status === 'ready').length, pending: pendingLoads,
        paused: !!host?.paused, host: pool.stats(), view: { ...view },
      };
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      unsub();
      offs.forEach((f) => { try { f(); } catch { /* noop */ } });
      ro.disconnect(); io?.disconnect();
      cancelAnimationFrame(rafId); cancelAnimationFrame(hoverRaf); stopOwnClock();
      clearTimeout(idleTimer); clearTimeout(commitTimer);
      for (const l of layers.values()) dropLayer(l);
      layers.clear();
      host?.release(); host = null;
      root.remove();
    },
  };

  function guessKind(assetId) {
    try { return themesMod?.assetKind?.(assetId) || 'prop'; } catch { return 'prop'; }
  }

  layout();
  startHost();
  return stage;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export { LEGACY_K };
