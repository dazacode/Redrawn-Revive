/**
 * Redrawn Studio timeline: scene strip + multi-track audio timeline with transport, scrubbing, zoom,
 * drag/trim, per-clip volume, keyboard control, text-to-speech and audio upload.
 *
 *   const tl = mountTimeline(el, { store, stage, audio });  tl.destroy();
 *
 * Reads/writes only through the store contract and the audio engine (audio.js). Time on the ruler is
 * movie-absolute ms; zoom is `state.zoom` (px per second).
 */
import { movieDuration, sceneAt, MIN_SCENE_MS } from './model.js';
import {
  TRACKS, trackOf, clamp, clampZoom, fitZoom, fmtTime, fmtDur, tickStep, tickLabel, packLanes, snapTargets,
  moveClip, trimLeft, trimRight, splitClip, reorderIndex, dropMarkerMs, clipLabel, parseVoicesXml,
  parseConvertResponse, ugcAssetId, FRAME_MS, MIN_CLIP_MS, DEFAULT_ZOOM, MIN_ZOOM, MAX_ZOOM,
} from './timeline-logic.js';
import { PEAK_RATE } from './audio.js';

const SCENE_H = 56, RULER_H = 24, LANE_H = 30, LANE_GAP = 3, TRACK_PAD = 4, PAD_RIGHT = 96;
const SNAP_PX = 8;
const CSS_HREF = '/css/studio-timeline.css';
const VOICE_KEY = 'redrawn.studio.ttsVoice';

// ---------------------------------------------------------------- icons (inline, same style as icons.js)
const IC = {
  play: '<path d="M7 4.5v15l12-7.5z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  start: '<path d="M6 5v14"/><path d="M19 5.5v13L9 12z"/>',
  end: '<path d="M18 5v14"/><path d="M5 5.5v13L15 12z"/>',
  loop: '<path d="m17 2 4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15"/><path d="m7 22-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  music: '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
  sfx: '<path d="M13 3 5 14h6l-1 7 8-11h-6z"/>',
  upload: '<path d="M12 15V3"/><path d="m7 8 5-5 5 5"/><path d="M5 21h14"/>',
  volume: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M17 9a4 4 0 0 1 0 6"/>',
  mute: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="m17 9 5 6M22 9l-5 6"/>',
  fit: '<path d="M4 12h16M8 8l-4 4 4 4M16 8l4 4-4 4"/>',
  film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>',
  split: '<path d="M12 3v18"/><path d="M6 8 3 12l3 4M18 8l3 4-3 4"/>',
  flash: '<path d="M13 3 5 14h6l-1 7 8-11h-6z"/>',
  alert: '<path d="M12 3 2 21h20z"/><path d="M12 10v5M12 18v.01"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
};
const ic = (n, cls = '') => `<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${IC[n] || ''}</svg>`;
const TRACK_ICON = { voice: 'mic', music: 'music', sfx: 'sfx' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const safeGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const safeSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } };

/** Shared across mounts: TTS voice list (one request per page). */
let voicesPromise = null;

/**
 * @param {HTMLElement} el
 * @param {{store: any, stage?: any, audio: any}} deps
 */
export function mountTimeline(el, { store, stage, audio }) {
  ensureStylesheet();
  const ac = new AbortController();
  const { signal } = ac;

  // ---------------------------------------------------------------- skeleton
  el.classList.add('tl-host');
  el.innerHTML = `
  <section class="tl" role="region" aria-label="Timeline" tabindex="-1">
    <div class="tl-bar" role="toolbar" aria-label="Timeline controls">
      <div class="tl-group" role="group" aria-label="Transport">
        <button class="tl-btn" type="button" data-act="start" title="Go to start (Home)" aria-label="Go to start">${ic('start')}</button>
        <button class="tl-btn tl-play" type="button" data-act="play" title="Play (Space)" aria-label="Play">${ic('play')}</button>
        <button class="tl-btn" type="button" data-act="end" title="Go to end (End)" aria-label="Go to end">${ic('end')}</button>
        <button class="tl-btn" type="button" data-act="loop" title="Loop (Shift+L)" aria-label="Loop" aria-pressed="false">${ic('loop')}</button>
      </div>
      <div class="tl-time tnum" role="timer" aria-label="Playhead time"><b data-ref="now">0:00.0</b><span class="tl-time-sep">/</span><span data-ref="total">0:00.0</span></div>
      <span class="tl-sep" aria-hidden="true"></span>
      <div class="tl-group" role="group" aria-label="Scenes">
        <button class="tl-btn tl-btn-text" type="button" data-act="addScene" title="Add scene after the current one">${ic('plus')}<span>Scene</span></button>
        <button class="tl-btn" type="button" data-act="dupScene" title="Duplicate scene" aria-label="Duplicate scene">${ic('copy')}</button>
        <button class="tl-btn" type="button" data-act="delScene" title="Delete scene" aria-label="Delete scene">${ic('trash')}</button>
      </div>
      <span class="tl-sep" aria-hidden="true"></span>
      <div class="tl-group" role="group" aria-label="Audio">
        <button class="tl-btn tl-btn-text" type="button" data-act="tts" title="Add a voice with text to speech">${ic('mic')}<span>Voice</span></button>
        <button class="tl-btn tl-btn-text" type="button" data-act="upload" title="Upload an audio file">${ic('upload')}<span>Upload</span></button>
      </div>
      <div class="tl-clipbar" data-ref="clipbar" hidden>
        <span class="tl-sep" aria-hidden="true"></span>
        <span class="tl-clipname" data-ref="clipname"></span>
        <label class="tl-vol" title="Clip volume (Up/Down on a selected clip)">${ic('volume')}<input type="range" min="0" max="100" step="1" data-ref="clipvol" aria-label="Clip volume"><output class="tnum" data-ref="clipvolout"></output></label>
        <button class="tl-btn" type="button" data-act="split" title="Split at playhead (S)" aria-label="Split at playhead">${ic('split')}</button>
        <button class="tl-btn" type="button" data-act="delClip" title="Delete clip (Delete)" aria-label="Delete clip">${ic('trash')}</button>
      </div>
      <span class="tl-spacer"></span>
      <div class="tl-group" role="group" aria-label="Zoom and volume">
        <button class="tl-btn" type="button" data-act="mute" title="Mute" aria-label="Mute" aria-pressed="false">${ic('volume')}</button>
        <button class="tl-btn" type="button" data-act="zoomOut" title="Zoom out (-)" aria-label="Zoom out">${ic('minus')}</button>
        <input class="tl-zoom" type="range" min="0" max="100" step="1" data-ref="zoom" aria-label="Zoom">
        <button class="tl-btn" type="button" data-act="zoomIn" title="Zoom in (+)" aria-label="Zoom in">${ic('plus')}</button>
        <button class="tl-btn" type="button" data-act="fit" title="Fit movie to view (0)" aria-label="Fit to view">${ic('fit')}</button>
      </div>
    </div>
    <div class="tl-main">
      <div class="tl-heads" aria-hidden="false">
        <div class="tl-head tl-head-scenes"><span>Scenes</span><b class="tnum" data-ref="sceneCount"></b></div>
        <div class="tl-head tl-head-ruler"></div>
        <div class="tl-heads-body"><div data-ref="heads"></div></div>
      </div>
      <div class="tl-scroll" data-ref="scroll">
        <div class="tl-content" data-ref="content">
          <div class="tl-row tl-scenes" data-ref="sceneRow"></div>
          <div class="tl-row tl-ruler" data-ref="ruler"><canvas data-ref="rulerCv" aria-hidden="true"></canvas><div class="tl-ph-cap" data-ref="cap"></div></div>
          <div class="tl-tracks" data-ref="tracks">
            <div class="tl-bounds" data-ref="bounds"></div>
            <div class="tl-beyond" data-ref="beyond" hidden></div>
          </div>
          <div class="tl-snap" data-ref="snap" hidden></div>
          <div class="tl-drop" data-ref="drop" hidden></div>
          <div class="tl-playhead" data-ref="playhead" aria-hidden="true"></div>
        </div>
      </div>
    </div>
    <div class="tl-toasts" aria-live="polite" data-ref="toasts"></div>
    <input type="file" data-ref="file" accept="audio/*,.mp3,.wav,.ogg,.m4a" hidden>
  </section>`;
  const root = el.querySelector('.tl');
  /** @type {Record<string, any>} */
  const R = {};
  root.querySelectorAll('[data-ref]').forEach((n) => { R[n.dataset.ref] = n; });
  const btn = (act) => root.querySelector(`[data-act="${act}"]`);
  const playBtn = btn('play');

  // ---------------------------------------------------------------- view state
  let view = { pps: DEFAULT_ZOOM / 1000, zoom: DEFAULT_ZOOM, total: 0 };
  let last = { movie: null, selection: null, zoom: null, playhead: -1, playing: null };
  let raf = 0, lightRaf = 0, waveRaf = 0, rulerRaf = 0;
  let pendingAnchor = null;
  let scrubbing = false;
  let sceneDrag = null;       // {id, mode}
  let clipDrag = null;
  const sceneEls = new Map();
  const clipEls = new Map();
  const trackEls = new Map(); // trackId -> {row, lane, hint, head}
  const thumbCache = new Map();
  let themeNames = null;      // assetId -> name (best effort)
  let themeNamesFor = null;

  const state = () => store.get();
  const cur = () => state().movie;
  const pxOf = (ms) => ms * view.pps;
  const msOfClientX = (cx) => {
    const r = R.scroll.getBoundingClientRect();
    return (cx - r.left + R.scroll.scrollLeft) / view.pps;
  };

  // ---------------------------------------------------------------- commands (single place for store shapes)
  const send = (cmd) => store.dispatch(cmd);
  const cmd = {
    select: (sceneId, elemId, kind) => send({ type: 'select', sceneId, elemId, kind }),
    zoom: (zoom) => send({ type: 'setZoom', zoom }),
    updateSound: (id, patch, coalesce) => send({ type: 'updateSound', soundId: id, id, patch, ...(coalesce ? { coalesce } : {}) }),
    addSound: (sound) => send({ type: 'addSound', sound }),
    removeSound: (id) => send({ type: 'removeSound', soundId: id, id }),
    sceneProps: (sceneId, patch, coalesce) => send({ type: 'setSceneProps', sceneId, patch, ...(coalesce ? { coalesce } : {}) }),
    addScene: (index) => send({ type: 'addScene', index }),
    dupScene: (sceneId) => send({ type: 'duplicateScene', sceneId }),
    delScene: (sceneId) => send({ type: 'removeScene', sceneId }),
    moveScene: (sceneId, toIndex) => send({ type: 'moveScene', sceneId, toIndex }),
  };

  function toast(msg, kind = 'info', ms = 3600) {
    const t = document.createElement('div');
    t.className = 'tl-toast';
    t.dataset.kind = kind;
    t.textContent = msg;
    R.toasts.append(t);
    setTimeout(() => t.remove(), ms);
  }

  // ---------------------------------------------------------------- selection helpers
  const selection = () => state().selection ?? { sceneId: null, elemId: null, kind: null };
  const selectedClipId = () => (selection().kind === 'sound' ? selection().elemId : null);
  const selectedClip = () => cur().sounds.find((c) => c.id === selectedClipId()) ?? null;
  const currentSceneId = () => {
    const s = selection().sceneId;
    const m = cur();
    if (s && m.scenes.some((x) => x.id === s)) return s;
    return sceneAt(m, state().playhead)?.scene.id ?? m.scenes[0]?.id ?? null;
  };
  function selectScene(id) {
    const sel = selection();
    if (sel.kind === 'scene' && sel.sceneId === id) return;
    cmd.select(id, null, 'scene');
  }
  function selectClip(id) {
    const sel = selection();
    if (sel.kind === 'sound' && sel.elemId === id) return;
    cmd.select(currentSceneId(), id, 'sound');
  }

  // ---------------------------------------------------------------- thumbnails & names
  function thumbFor(assetId) {
    if (!assetId) return Promise.resolve(null);
    let p = thumbCache.get(assetId);
    if (!p) {
      p = (async () => {
        let r = null;
        // the stage shares its thumbnail cache with thumbs.js, so prefer it; fall back to thumbs.js directly
        if (typeof stage?.thumbnail === 'function') {
          try { r = await stage.thumbnail(assetId, 160, 'bg'); } catch { r = null; }
        }
        if (!r) {
          try {
            const mod = await import('./thumbs.js');
            if (mod?.getAssetThumb) r = await mod.getAssetThumb(assetId, 'bg');
          } catch { r = null; }
        }
        if (r instanceof Blob) r = URL.createObjectURL(r);
        return r || null;
      })();
      thumbCache.set(assetId, p);
    }
    return p;
  }

  function loadNames() {
    const themeId = cur().themeId;
    if (themeNamesFor === themeId) return;
    themeNamesFor = themeId;
    themeNames = null;
    import('./themes.js').then((t) => t.loadTheme?.(themeId)).then((th) => {
      if (!th || themeNamesFor !== themeId) return;
      themeNames = new Map((th.sounds ?? []).map((s) => [s.assetId, s.name]));
      scheduleRender();
    }).catch(() => {});
  }
  const nameOf = (assetId) => themeNames?.get(assetId) ?? null;

  // ---------------------------------------------------------------- render scheduling
  function scheduleRender() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); }
  function scheduleLight() { if (!lightRaf) lightRaf = requestAnimationFrame(() => { lightRaf = 0; renderLight(); }); }
  function scheduleWaves() { if (!waveRaf) waveRaf = requestAnimationFrame(() => { waveRaf = 0; drawWaves(); }); }
  function scheduleRuler() { if (!rulerRaf) rulerRaf = requestAnimationFrame(() => { rulerRaf = 0; drawRuler(); }); }

  const unsub = store.subscribe((s0, c, prev) => {
    const s = state();
    if (s.movie !== last.movie || s.selection !== last.selection || s.zoom !== last.zoom) scheduleRender();
    else if (s.playhead !== last.playhead || s.playing !== last.playing) scheduleLight();
  });
  const unsubAssets = audio?.onAssets?.(() => scheduleRender());

  // ---------------------------------------------------------------- full render
  function render() {
    const s = state();
    const movie = s.movie;
    const sel = selection();
    loadNames();

    const zoom = clampZoom(Number.isFinite(s.zoom) ? s.zoom : DEFAULT_ZOOM);
    const zoomChanged = zoom !== view.zoom;
    const soundEnd = movie.sounds.reduce((m, c) => Math.max(m, c.end), 0);
    const total = movieDuration(movie);
    view = { zoom, pps: zoom / 1000, total };
    const contentMs = Math.max(total, soundEnd, 5000);
    const contentW = Math.ceil(contentMs * view.pps + PAD_RIGHT);
    R.content.style.width = `${contentW}px`;
    R.content.style.setProperty('--pps', String(view.pps));

    // scene count + total
    R.sceneCount.textContent = movie.scenes.length ? String(movie.scenes.length) : '';
    R.total.textContent = fmtTime(total);

    renderScenes(movie, sel);
    renderTracks(movie, sel, soundEnd);
    renderBounds(movie, total);
    renderClipbar(movie);
    renderBar(movie, s);

    if (zoomChanged) {
      R.zoom.value = String(zoomToSlider(zoom));
      if (pendingAnchor) { R.scroll.scrollLeft = Math.max(0, pendingAnchor.t * view.pps - pendingAnchor.off); pendingAnchor = null; }
    }
    R.zoom.value = String(zoomToSlider(zoom));
    last = { movie, selection: s.selection, zoom: s.zoom, playhead: -1, playing: null };
    renderLight();
    scheduleRuler();
    scheduleWaves();
    syncHeads();
  }

  function renderBar(movie, s) {
    btn('delScene').disabled = movie.scenes.length <= 1;
    btn('dupScene').disabled = !movie.scenes.length;
    btn('mute').setAttribute('aria-pressed', String(!!audio?.isMuted?.()));
    btn('mute').innerHTML = ic(audio?.isMuted?.() ? 'mute' : 'volume');
    btn('loop').setAttribute('aria-pressed', String(!!audio?.getLoop?.()));
    for (const b of ['start', 'play', 'end']) btn(b).disabled = !total() ;
  }
  const total = () => view.total;

  function renderClipbar(movie) {
    const c = selectedClip();
    R.clipbar.hidden = !c;
    if (!c) return;
    R.clipname.textContent = clipLabel(c, nameOf);
    R.clipname.title = R.clipname.textContent;
    const v = Math.round((c.volume ?? 1) * 100);
    if (document.activeElement !== R.clipvol) R.clipvol.value = String(v);
    R.clipvolout.textContent = `${v}%`;
  }

  // ---- scenes
  function renderScenes(movie, sel) {
    const seen = new Set();
    let t = 0;
    const ph = state().playhead;
    movie.scenes.forEach((sc, i) => {
      seen.add(sc.id);
      let e = sceneEls.get(sc.id);
      if (!e) { e = createSceneEl(sc); sceneEls.set(sc.id, e); R.sceneRow.append(e.el); }
      const w = Math.max(6, sc.duration * view.pps - 3);
      if (sceneDrag?.id !== sc.id || sceneDrag.mode !== 'reorder') e.el.style.left = `${t * view.pps}px`;
      e.el.style.width = `${w}px`;
      e.el.dataset.size = w < 64 ? 'xs' : w < 120 ? 's' : 'm';
      e.el.classList.toggle('is-sel', sel.kind === 'scene' && sel.sceneId === sc.id);
      e.el.classList.toggle('is-current', ph >= t && (ph < t + sc.duration || (i === movie.scenes.length - 1 && ph <= t + sc.duration)));
      e.num.textContent = String(i + 1);
      e.dur.textContent = fmtDur(sc.duration);
      e.el.setAttribute('aria-label', `Scene ${i + 1}, ${fmtDur(sc.duration)}${sc.transitionOut ? ', transition out' : ''}`);
      e.el.setAttribute('aria-pressed', String(e.el.classList.contains('is-sel')));
      e.trans.hidden = !sc.transitionOut;
      const bg = sc.bg?.assetId ?? null;
      if (e.bg !== bg) {
        e.bg = bg;
        e.thumb.style.backgroundImage = '';
        e.thumb.classList.toggle('is-empty', !bg);
        e.thumb.style.setProperty('--seed', String(hash(bg ?? sc.id) % 360));
        if (bg) thumbFor(bg).then((u) => { if (u && e.bg === bg) e.thumb.style.backgroundImage = `url("${u}")`; });
      }
      e.start = t;
      t += sc.duration;
    });
    for (const [id, e] of sceneEls) if (!seen.has(id)) { e.el.remove(); sceneEls.delete(id); }

    // empty / add affordances
    let add = R.sceneRow.querySelector('.tl-scene-add');
    if (!add) {
      add = document.createElement('button');
      add.type = 'button';
      add.className = 'tl-scene-add';
      add.innerHTML = `${ic('plus')}<span>Add scene</span>`;
      add.addEventListener('click', () => addSceneAt(cur().scenes.length), { signal });
      R.sceneRow.append(add);
    }
    add.style.left = `${t * view.pps + 6}px`;
    add.classList.toggle('is-first', movie.scenes.length === 0);
    add.title = 'Add a scene at the end';
  }

  function createSceneEl(sc) {
    const el = document.createElement('div');
    el.className = 'tl-scene';
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.dataset.id = sc.id;
    el.innerHTML = `<div class="tl-scene-thumb"></div><span class="tl-scene-n tnum"></span><span class="tl-scene-d tnum"></span><span class="tl-scene-trans" hidden title="Has a transition out"></span><div class="tl-scene-grip" title="Drag to change the scene length" aria-hidden="true"></div>`;
    const e = {
      el, thumb: el.querySelector('.tl-scene-thumb'), num: el.querySelector('.tl-scene-n'), dur: el.querySelector('.tl-scene-d'),
      trans: el.querySelector('.tl-scene-trans'), grip: el.querySelector('.tl-scene-grip'), bg: undefined, start: 0,
    };
    el.addEventListener('pointerdown', (ev) => onScenePointerDown(ev, sc.id, e), { signal });
    el.addEventListener('keydown', (ev) => onSceneKey(ev, sc.id), { signal });
    return e;
  }

  function addSceneAt(index) {
    cmd.addScene(index); // the store selects the new scene
    const id = selection().sceneId;
    if (id) { audio?.seek(sceneStartOf(id)); reveal(sceneStartOf(id)); }
  }

  const sceneStartOf = (id) => {
    let t = 0;
    for (const s of cur().scenes) { if (s.id === id) return t; t += s.duration; }
    return 0;
  };

  function onSceneKey(ev, id) {
    const movie = cur();
    const idx = movie.scenes.findIndex((s) => s.id === id);
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault(); ev.stopPropagation();
      selectScene(id); audio?.seek(sceneStartOf(id));
    } else if (ev.altKey && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight')) {
      ev.preventDefault(); ev.stopPropagation();
      const to = clamp(idx + (ev.key === 'ArrowLeft' ? -1 : 1), 0, movie.scenes.length - 1);
      if (to !== idx) cmd.moveScene(id, to);
    } else if (ev.shiftKey && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight')) {
      ev.preventDefault(); ev.stopPropagation();
      const sc = movie.scenes[idx];
      const d = clamp(sc.duration + (ev.key === 'ArrowLeft' ? -500 : 500), MIN_SCENE_MS, 600000);
      cmd.sceneProps(id, { duration: d }, `dur-${id}`);
    }
  }

  // ---- scene pointer interactions: click = select, drag = reorder, grip = duration
  function onScenePointerDown(ev, id, e) {
    if (ev.button !== 0) return;
    const movie = cur();
    const idx = movie.scenes.findIndex((s) => s.id === id);
    const sc = movie.scenes[idx];
    const isGrip = ev.target === e.grip;
    ev.preventDefault();
    e.el.focus({ preventScroll: true });
    e.el.setPointerCapture(ev.pointerId);
    const x0 = ev.clientX;
    let moved = false;

    if (isGrip) {
      sceneDrag = { id, mode: 'duration' };
      e.el.classList.add('is-dragging');
      const orig = sc.duration;
      const tip = showTip();
      const move = (m) => {
        const dx = (m.clientX - x0) / view.pps;
        const step = m.shiftKey ? 10 : 100;
        const d = clamp(Math.round((orig + dx) / step) * step, MIN_SCENE_MS, 3600000);
        moved = true;
        if (d !== cur().scenes.find((s) => s.id === id)?.duration) cmd.sceneProps(id, { duration: d }, `dur-${id}`);
        tip(`${(d / 1000).toFixed(step === 10 ? 2 : 1)}s`, m.clientX, e.el.getBoundingClientRect().top);
        autoScroll(m.clientX);
      };
      const end = () => { cleanup(); tip(null); sceneDrag = null; e.el.classList.remove('is-dragging'); scheduleRender(); };
      const cleanup = bindDrag(e.el, ev.pointerId, move, end);
      return;
    }

    const bounds = () => { let t = 0; return cur().scenes.map((s) => { const o = { start: t, end: t + s.duration }; t += s.duration; return o; }); };
    const moveFn = (m) => {
      const dxPx = m.clientX - x0;
      if (!moved && Math.abs(dxPx) < 5) return;
      if (!moved) {
        moved = true;
        sceneDrag = { id, mode: 'reorder' };
        e.el.classList.add('is-dragging');
        selectScene(id);
      }
      e.el.style.transform = `translateX(${dxPx}px)`;
      const b = bounds();
      const center = b[idx].start + sc.duration / 2 + dxPx / view.pps;
      const to = reorderIndex(b, idx, center);
      sceneDrag.to = to;
      R.drop.hidden = to === idx;
      R.drop.style.left = `${dropMarkerMs(b, idx, to) * view.pps - 1}px`;
      R.drop.style.top = '0px';
      R.drop.style.height = `${SCENE_H}px`;
      autoScroll(m.clientX);
    };
    const endFn = (m, cancelled) => {
      cleanup();
      e.el.classList.remove('is-dragging');
      e.el.style.transform = '';
      R.drop.hidden = true;
      const to = sceneDrag?.to;
      sceneDrag = null;
      if (!moved) {
        if (!cancelled) { selectScene(id); audio?.seek(sceneStartOf(id)); reveal(sceneStartOf(id)); }
      } else if (!cancelled && to !== undefined && to !== idx) {
        cmd.moveScene(id, to);
      }
      scheduleRender();
    };
    const cleanup = bindDrag(e.el, ev.pointerId, moveFn, endFn);
  }

  // ---- tracks / clips
  function ensureTrack(tr) {
    let t = trackEls.get(tr.id);
    if (t) return t;
    const row = document.createElement('div');
    row.className = 'tl-track';
    row.dataset.track = tr.id;
    const lane = document.createElement('div');
    lane.className = 'tl-lane';
    lane.addEventListener('pointerdown', (ev) => { if (ev.target === lane || ev.target.classList.contains('tl-hint')) { cmd.select(currentSceneId(), null, 'scene'); startScrub(ev); } }, { signal });
    const accepts = (ev) => { const t = ev.dataTransfer?.types; return !!t && (t.includes('Files') || t.includes('application/x-redrawn-asset')); };
    lane.addEventListener('dragover', (ev) => { if (accepts(ev)) { ev.preventDefault(); ev.dataTransfer.dropEffect = 'copy'; row.classList.add('is-drop'); } }, { signal });
    lane.addEventListener('dragleave', (ev) => { if (!lane.contains(ev.relatedTarget)) row.classList.remove('is-drop'); }, { signal });
    lane.addEventListener('drop', (ev) => {
      row.classList.remove('is-drop');
      // a sound dragged from the assets panel (payload set by assets-panel.js startDrag)
      let payload = null;
      try { payload = JSON.parse(ev.dataTransfer?.getData('application/x-redrawn-asset') || 'null'); } catch { /* not ours */ }
      if (payload?.kind === 'sound' && payload.assetId) {
        ev.preventDefault();
        ev.stopPropagation();
        const start = Math.max(0, Math.round(msOfClientX(ev.clientX)));
        const len = Math.max(500, Number(payload.duration) || (tr.addKind === 'bgmusic' ? 30000 : 1500));
        cmd.addSound({ kind: tr.addKind, assetId: payload.assetId, start, end: start + len, volume: tr.addKind === 'bgmusic' ? 0.5 : 1 });
        return;
      }
      const f = ev.dataTransfer?.files?.[0];
      if (!f) return;
      ev.preventDefault();
      uploadAndAdd(f, tr.addKind, Math.max(0, msOfClientX(ev.clientX)));
    }, { signal });
    const hint = document.createElement('div');
    hint.className = 'tl-hint';
    hint.innerHTML = HINTS[tr.id];
    hint.querySelector('button')?.addEventListener('click', () => (tr.id === 'voice' ? openTts() : openUpload(tr.addKind)), { signal });
    lane.append(hint);
    row.append(lane);
    R.tracks.append(row);

    const head = document.createElement('div');
    head.className = 'tl-head tl-head-track';
    head.dataset.track = tr.id;
    head.innerHTML = `<span class="tl-head-ic" data-kind="${tr.id}">${ic(TRACK_ICON[tr.id])}</span><span class="tl-head-name">${tr.label}</span>
      <button class="tl-mini" type="button" title="${tr.id === 'voice' ? 'Add a voice with text to speech' : `Upload ${tr.label.toLowerCase()} audio`}" aria-label="Add ${tr.label}">${ic('plus')}</button>`;
    head.querySelector('button').addEventListener('click', () => (tr.id === 'voice' ? openTts() : openUpload(tr.addKind)), { signal });
    R.heads.append(head);
    t = { row, lane, hint, head };
    trackEls.set(tr.id, t);
    return t;
  }

  const HINTS = {
    voice: `<span>No voice yet. Type a line and Redrawn will speak it.</span><button class="tl-link" type="button">${ic('mic')}Add a voice</button>`,
    music: `<span>No music. Upload a track to set the mood.</span><button class="tl-link" type="button">${ic('upload')}Upload music</button>`,
    sfx: `<span>No sound effects. Drop an audio file here.</span><button class="tl-link" type="button">${ic('upload')}Upload a sound</button>`,
  };

  function renderTracks(movie, sel, soundEnd) {
    const byTrack = new Map(TRACKS.map((t) => [t.id, []]));
    for (const c of movie.sounds) byTrack.get(trackOf(c.kind)).push(c);
    const seen = new Set();
    for (const tr of TRACKS) {
      const t = ensureTrack(tr);
      const clips = byTrack.get(tr.id);
      const { lanes, count } = packLanes(clips);
      const h = clips.length ? count * (LANE_H + LANE_GAP) - LANE_GAP + TRACK_PAD * 2 : LANE_H + TRACK_PAD * 2;
      t.row.style.height = `${h}px`;
      t.head.style.height = `${h}px`;
      t.hint.hidden = clips.length > 0;
      t.head.querySelector('.tl-head-name').dataset.count = clips.length ? String(clips.length) : '';
      for (const c of clips) {
        seen.add(c.id);
        let e = clipEls.get(c.id);
        if (!e) { e = createClipEl(c); clipEls.set(c.id, e); }
        if (e.el.parentNode !== t.lane) t.lane.append(e.el);
        updateClipEl(e, c, lanes.get(c.id) ?? 0, tr, sel);
      }
    }
    for (const [id, e] of clipEls) if (!seen.has(id)) { e.el.remove(); clipEls.delete(id); }

    const beyond = soundEnd > view.total || view.total > 0;
    R.beyond.hidden = !beyond;
    R.beyond.style.left = `${view.total * view.pps}px`;
  }

  function createClipEl(c) {
    const el = document.createElement('div');
    el.className = 'tl-clip';
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.dataset.id = c.id;
    el.innerHTML = `<canvas class="tl-wave" aria-hidden="true"></canvas><div class="tl-clip-fill"></div>
      <div class="tl-clip-label"><span class="tl-clip-ic"></span><span class="tl-clip-text"></span></div>
      <div class="tl-clip-status"></div>
      <div class="tl-vol-line" title="Drag to change volume"><span class="tl-vol-tag tnum"></span></div>
      <div class="tl-trim tl-trim-l" aria-hidden="true"></div><div class="tl-trim tl-trim-r" aria-hidden="true"></div>`;
    const e = {
      el, wave: el.querySelector('.tl-wave'), text: el.querySelector('.tl-clip-text'), ico: el.querySelector('.tl-clip-ic'),
      status: el.querySelector('.tl-clip-status'), vol: el.querySelector('.tl-vol-line'), volTag: el.querySelector('.tl-vol-tag'),
      lane: 0, w: 0, left: 0, drawn: '',
    };
    el.addEventListener('pointerdown', (ev) => onClipPointerDown(ev, c.id, e), { signal });
    el.addEventListener('keydown', (ev) => onClipKey(ev, c.id), { signal });
    el.addEventListener('dblclick', () => audio?.seek(cur().sounds.find((x) => x.id === c.id)?.start ?? 0), { signal });
    return e;
  }

  function updateClipEl(e, c, lane, tr, sel) {
    const el = e.el;
    const left = c.start * view.pps;
    const w = Math.max(6, (c.end - c.start) * view.pps);
    e.left = left; e.w = w; e.lane = lane;
    el.style.left = `${left}px`;
    el.style.width = `${w}px`;
    el.style.top = `${TRACK_PAD + lane * (LANE_H + LANE_GAP)}px`;
    el.style.height = `${LANE_H}px`;
    el.dataset.kind = tr.id;
    const info = audio?.info?.(c.assetId) ?? { status: 'ready', duration: 0, peaks: null };
    el.dataset.status = info.status;
    const selected = sel.kind === 'sound' && sel.elemId === c.id;
    el.classList.toggle('is-sel', selected);
    el.setAttribute('aria-pressed', String(selected));
    const label = clipLabel(c, nameOf);
    e.text.textContent = label;
    e.ico.innerHTML = ic(info.status === 'unsupported' ? 'flash' : info.status === 'error' ? 'alert' : TRACK_ICON[tr.id]);
    const vol = clamp(c.volume ?? 1, 0, 1);
    e.vol.style.top = `${(1 - vol) * 100}%`;
    e.volTag.textContent = `${Math.round(vol * 100)}%`;
    el.classList.toggle('is-quiet', vol <= 0.001);
    const msg = info.status === 'loading' ? 'Loading audio' : info.status === 'unsupported' ? 'Sound cannot be previewed (unsupported file)' : info.status === 'error' ? 'Could not load. Click to retry' : '';
    e.status.textContent = w > 90 || info.status === 'ready' ? msg : '';
    e.status.hidden = !msg;
    el.title = `${label}\n${fmtTime(c.start)} to ${fmtTime(c.end)}${msg ? `\n${msg}` : ''}`;
    el.setAttribute('aria-label', `${tr.label}: ${label}, ${fmtTime(c.start)} to ${fmtTime(c.end)}, volume ${Math.round(vol * 100)} percent${msg ? `, ${msg}` : ''}`);
    e.drawn = ''; // force waveform refresh
  }

  // ---- scene bounds overlay
  function renderBounds(movie, total) {
    const want = movie.scenes.length + 1;
    while (R.bounds.children.length < want) { const d = document.createElement('i'); R.bounds.append(d); }
    while (R.bounds.children.length > want) R.bounds.lastChild.remove();
    let t = 0;
    const kids = R.bounds.children;
    for (let i = 0; i < movie.scenes.length; i++) { kids[i].style.left = `${t * view.pps}px`; t += movie.scenes[i].duration; }
    kids[movie.scenes.length].style.left = `${total * view.pps}px`;
  }

  // ---------------------------------------------------------------- light render (playhead, time, play state)
  function renderLight() {
    const s = state();
    const x = s.playhead * view.pps;
    R.playhead.style.transform = `translateX(${x}px)`;
    R.cap.style.transform = `translateX(${x}px)`;
    R.now.textContent = fmtTime(s.playhead);
    if (last.playing !== s.playing) {
      playBtn.innerHTML = ic(s.playing ? 'pause' : 'play');
      playBtn.setAttribute('aria-label', s.playing ? 'Pause' : 'Play');
      playBtn.title = s.playing ? 'Pause (Space)' : 'Play (Space)';
      root.classList.toggle('is-playing', !!s.playing);
    }
    if (s.playing && !scrubbing) follow(x);
    // current-scene highlight
    const m = s.movie;
    const at = sceneAt(m, s.playhead);
    for (const [id, e] of sceneEls) e.el.classList.toggle('is-current', at?.scene.id === id);
    last.playhead = s.playhead;
    last.playing = s.playing;
  }

  function follow(x) {
    const sc = R.scroll;
    const vw = sc.clientWidth;
    if (x > sc.scrollLeft + vw - 48 || x < sc.scrollLeft) sc.scrollLeft = Math.max(0, x - vw * 0.2);
  }

  /** Scroll horizontally so ms is visible (used for keyboard/seek). */
  function reveal(ms) {
    const x = ms * view.pps;
    const sc = R.scroll;
    if (x < sc.scrollLeft + 8) sc.scrollLeft = Math.max(0, x - 48);
    else if (x > sc.scrollLeft + sc.clientWidth - 24) sc.scrollLeft = x - sc.clientWidth + 96;
  }

  // ---------------------------------------------------------------- ruler & waveforms (canvas, viewport-sized)
  function drawRuler() {
    const cv = R.rulerCv;
    const dpr = window.devicePixelRatio || 1;
    const w = R.scroll.clientWidth, h = RULER_H;
    if (!w) return;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
      cv.style.width = `${w}px`; cv.style.height = `${h}px`;
    }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const cs = getComputedStyle(R.ruler);
    const ink = cs.getPropertyValue('--tl-ruler-ink').trim() || '#888';
    const tick = cs.getPropertyValue('--tl-ruler-tick').trim() || '#888';
    g.font = `500 10.5px ${cs.fontFamily}`;
    g.textBaseline = 'middle';
    const pps = view.zoom; // px per second
    const step = tickStep(pps);
    const minor = step >= 5 ? 5 : step >= 1 ? (step === 1 ? 5 : step === 2 ? 4 : 5) : 5;
    const sub = step / minor;
    const sl = R.scroll.scrollLeft;
    const t0 = Math.floor(sl / pps / sub) * sub;
    for (let t = t0; t * pps - sl < w + 40; t += sub) {
      const x = Math.round(t * pps - sl) + 0.5;
      const isMajor = Math.abs(t / step - Math.round(t / step)) < 1e-6;
      g.strokeStyle = tick;
      g.globalAlpha = isMajor ? 0.9 : 0.45;
      g.beginPath();
      g.moveTo(x, h);
      g.lineTo(x, h - (isMajor ? 10 : 5));
      g.stroke();
      if (isMajor) {
        g.globalAlpha = 1;
        g.fillStyle = ink;
        g.fillText(tickLabel(Math.round(t * 1000) / 1000, step), x + 9, h / 2 - 3);
      }
    }
    g.globalAlpha = 1;
  }

  const waveColors = {};
  const probe = document.createElement('i');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText = 'position:absolute;width:0;height:0;visibility:hidden';
  root.append(probe);
  function drawWaves() {
    const sl = R.scroll.scrollLeft, vw = R.scroll.clientWidth;
    const dpr = window.devicePixelRatio || 1;
    for (const tr of TRACKS) {
      probe.style.color = `var(--tl-${tr.id}-wave)`;
      waveColors[tr.id] = getComputedStyle(probe).color || '#fff';
    }
    for (const [id, e] of clipEls) {
      const c = cur().sounds.find((x) => x.id === id);
      if (!c) continue;
      const x0 = Math.max(0, sl - e.left - 200);
      const x1 = Math.min(e.w, sl + vw - e.left + 200);
      if (x1 <= x0 + 1) { e.wave.width = 0; e.drawn = ''; continue; }
      const info = audio?.info?.(c.assetId);
      const key = `${x0}|${x1}|${e.w}|${info?.status}|${c.offset ?? 0}|${dpr}|${info?.peaks?.length ?? 0}|${view.pps}`;
      if (key === e.drawn) continue;
      e.drawn = key;
      const cw = Math.max(1, Math.round(x1 - x0)), ch = LANE_H;
      e.wave.style.left = `${x0}px`;
      e.wave.style.width = `${cw}px`;
      e.wave.style.height = `${ch}px`;
      e.wave.width = Math.round(cw * dpr);
      e.wave.height = Math.round(ch * dpr);
      const g = e.wave.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, cw, ch);
      if (!info?.peaks) continue;
      g.fillStyle = waveColors[trackOf(c.kind)];
      const peaks = info.peaks;
      const msPerPx = 1 / view.pps;
      const off = c.offset ?? 0;
      const srcMs = info.duration || peaks.length * (1000 / PEAK_RATE);
      const mid = ch / 2, maxH = ch - 10;
      const bar = 2, gap = 1;
      for (let px = 0; px < cw; px += bar + gap) {
        const tA = off + (x0 + px) * msPerPx;
        const tB = tA + (bar + gap) * msPerPx;
        let a = tA, b = tB;
        if (srcMs > 0 && a >= srcMs) { a %= srcMs; b = a + (tB - tA); } // looped music
        const iA = Math.floor((a / 1000) * PEAK_RATE);
        const iB = Math.max(iA + 1, Math.ceil((b / 1000) * PEAK_RATE));
        let p = 0;
        for (let i = iA; i < iB && i < peaks.length; i++) if (peaks[i] > p) p = peaks[i];
        const bh = Math.max(1.5, p * maxH);
        g.fillRect(px, mid - bh / 2, bar, bh);
      }
    }
  }

  // ---------------------------------------------------------------- heads sync (vertical)
  function syncHeads() { R.heads.style.transform = `translateY(${-R.scroll.scrollTop}px)`; }
  R.scroll.addEventListener('scroll', () => { syncHeads(); scheduleRuler(); scheduleWaves(); }, { signal, passive: true });
  const ro = new ResizeObserver(() => { scheduleRuler(); scheduleWaves(); });
  ro.observe(R.scroll);

  // ---------------------------------------------------------------- scrubbing
  R.ruler.addEventListener('pointerdown', (ev) => { if (ev.button === 0) startScrub(ev); }, { signal });
  R.sceneRow.addEventListener('pointerdown', (ev) => { if (ev.button === 0 && ev.target === R.sceneRow) startScrub(ev); }, { signal });

  function startScrub(ev) {
    ev.preventDefault();
    const wasPlaying = audio?.isPlaying?.() ?? false;
    if (wasPlaying) audio.pause();
    scrubbing = true;
    root.classList.add('is-scrubbing');
    const el = ev.currentTarget && ev.currentTarget.setPointerCapture ? ev.currentTarget : R.scroll;
    const seekTo = (cx) => {
      const ms = clamp(msOfClientX(cx), 0, Math.max(0, view.total));
      audio?.seek(ms);
    };
    seekTo(ev.clientX);
    const move = (m) => { seekTo(m.clientX); autoScroll(m.clientX); };
    const end = () => { cleanup(); scrubbing = false; root.classList.remove('is-scrubbing'); if (wasPlaying) audio.play(); };
    const cleanup = bindDrag(el, ev.pointerId, move, end);
  }

  // ---------------------------------------------------------------- generic drag plumbing
  function bindDrag(target, pointerId, onMove, onEnd) {
    try { target.setPointerCapture(pointerId); } catch { /* element may have been replaced */ }
    const move = (e) => { if (e.pointerId === pointerId) onMove(e); };
    const up = (e) => { if (e.pointerId === pointerId) onEnd(e, false); };
    const cancel = (e) => { if (e.pointerId === pointerId) onEnd(e, true); };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', cancel);
    let done = false;
    return () => {
      if (done) return; done = true;
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', cancel);
      try { target.releasePointerCapture(pointerId); } catch { /* already released */ }
    };
  }

  /** Edge auto-scroll while dragging near the scroller's left/right edge. */
  function autoScroll(cx) {
    const r = R.scroll.getBoundingClientRect();
    const edge = 36;
    if (cx > r.right - edge) R.scroll.scrollLeft += Math.min(24, (cx - (r.right - edge)) / 2 + 2);
    else if (cx < r.left + edge) R.scroll.scrollLeft -= Math.min(24, (r.left + edge - cx) / 2 + 2);
  }

  let tipEl = null;
  function showTip() {
    return (text, x, y) => {
      if (text === null) { tipEl?.remove(); tipEl = null; return; }
      if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'tl-tip tnum'; root.append(tipEl); }
      const r = root.getBoundingClientRect();
      tipEl.textContent = text;
      tipEl.style.left = `${x - r.left}px`;
      tipEl.style.top = `${y - r.top - 4}px`;
    };
  }

  // ---------------------------------------------------------------- clip interactions
  function sceneBoundsNow() {
    let t = 0;
    return cur().scenes.map((s) => { const o = { start: t, end: t + s.duration }; t += s.duration; return o; });
  }

  function onClipPointerDown(ev, id, e) {
    if (ev.button !== 0) return;
    const clip = cur().sounds.find((c) => c.id === id);
    if (!clip) return;
    ev.preventDefault();
    e.el.focus({ preventScroll: true });
    selectClip(id);
    const info = audio?.info?.(clip.assetId);
    if (info?.status === 'error' && !ev.target.closest('.tl-trim, .tl-vol-line')) audio.retry?.(clip.assetId);

    const mode = ev.target.closest('.tl-trim-l') ? 'l' : ev.target.closest('.tl-trim-r') ? 'r' : ev.target.closest('.tl-vol-line') ? 'vol' : 'move';
    const x0 = ev.clientX, y0 = ev.clientY;
    const orig = { start: clip.start, end: clip.end };
    const off0 = clip.offset ?? 0;
    const total = view.total || Infinity;
    const bounds = sceneBoundsNow();
    const thr = () => (SNAP_PX / view.pps);
    let moved = false;
    const tip = showTip();
    const co = `drag-${id}`;
    const targets = (m) => (m.altKey ? [] : snapTargets(bounds, cur().sounds, id, state().playhead));
    const srcDur = info?.duration || 0;
    const loops = clip.kind === 'bgmusic';

    clipDrag = { id, mode };
    e.el.classList.add('is-dragging');

    const move = (m) => {
      const dx = (m.clientX - x0) / view.pps;
      const dy = m.clientY - y0;
      if (!moved && Math.abs(m.clientX - x0) < 3 && Math.abs(dy) < 3) return;
      moved = true;
      const tg = targets(m);
      const th = m.altKey ? 0 : thr();
      let guide = null;
      if (mode === 'move') {
        const r = moveClip(orig, dx, { total, targets: tg, threshold: th });
        guide = r.guide;
        cmd.updateSound(id, { start: r.start, end: r.end }, co);
        tip(fmtTime(r.start), m.clientX, e.el.getBoundingClientRect().top);
      } else if (mode === 'l') {
        const r = trimLeft(orig, off0, dx, { targets: tg, threshold: th });
        guide = r.guide;
        cmd.updateSound(id, { start: r.start, offset: r.offset }, co);
        tip(fmtTime(r.start), m.clientX, e.el.getBoundingClientRect().top);
      } else if (mode === 'r') {
        const maxLen = srcDur && !loops ? Math.max(MIN_CLIP_MS, srcDur - off0) : Infinity;
        const r = trimRight(orig, dx, { targets: tg, threshold: th, maxLen });
        guide = r.guide;
        cmd.updateSound(id, { end: r.end }, co);
        tip(fmtTime(r.end), m.clientX, e.el.getBoundingClientRect().top);
      } else {
        const r = e.el.getBoundingClientRect();
        const v = clamp(1 - (m.clientY - r.top) / r.height, 0, 1);
        const q = Math.round((m.shiftKey ? v * 100 : Math.round(v * 20) * 5)) / 100;
        cmd.updateSound(id, { volume: q }, `vol-${id}`);
        tip(`${Math.round(q * 100)}%`, m.clientX, r.top);
      }
      if (guide !== null) { R.snap.hidden = false; R.snap.style.transform = `translateX(${guide * view.pps}px)`; } else R.snap.hidden = true;
      autoScroll(m.clientX);
    };
    const end = () => {
      cleanup(); tip(null);
      R.snap.hidden = true;
      clipDrag = null;
      e.el.classList.remove('is-dragging');
      scheduleRender();
    };
    const cleanup = bindDrag(e.el, ev.pointerId, move, end);
  }

  function onClipKey(ev, id) {
    const clip = cur().sounds.find((c) => c.id === id);
    if (!clip) return;
    const k = ev.key;
    if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
    let handled = true;
    if (k === 'ArrowLeft' || k === 'ArrowRight') {
      const dir = k === 'ArrowLeft' ? -1 : 1;
      const step = ev.shiftKey ? 1000 : 100;
      const r = moveClip(clip, dir * step, { total: view.total || Infinity });
      cmd.updateSound(id, { start: r.start, end: r.end }, `nudge-${id}`);
    } else if (k === 'ArrowUp' || k === 'ArrowDown') {
      const v = clamp(Math.round(((clip.volume ?? 1) + (k === 'ArrowUp' ? 0.05 : -0.05)) * 100) / 100, 0, 1);
      cmd.updateSound(id, { volume: v }, `vol-${id}`);
    } else if (k === 'Enter') {
      selectClip(id); audio?.seek(clip.start);
    } else handled = false;
    if (handled) { ev.preventDefault(); ev.stopPropagation(); }
  }

  // ---------------------------------------------------------------- toolbar
  root.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-act]');
    if (!b || !root.contains(b)) return;
    act(b.dataset.act, ev);
    if (ev.detail > 0) b.blur(); // mouse click: hand keyboard focus back so Space keeps meaning play/pause
  }, { signal });

  function act(name) {
    const movie = cur();
    const sid = currentSceneId();
    switch (name) {
      case 'play': audio?.isPlaying?.() ? audio.pause() : audio?.play(); break;
      case 'start': audio?.seek(0); reveal(0); break;
      case 'end': audio?.seek(movieDuration(movie)); reveal(movieDuration(movie)); break;
      case 'loop': { audio?.setLoop(!audio.getLoop()); scheduleRender(); break; }
      case 'mute': { audio?.setMuted(!audio.isMuted()); scheduleRender(); break; }
      case 'addScene': {
        const i = movie.scenes.findIndex((s) => s.id === sid);
        addSceneAt(i < 0 ? movie.scenes.length : i + 1);
        break;
      }
      case 'dupScene': if (sid) cmd.dupScene(sid); break;
      case 'delScene': if (sid && movie.scenes.length > 1) cmd.delScene(sid); break;
      case 'tts': openTts(); break;
      case 'upload': openUpload('voice'); break;
      case 'split': splitSelected(); break;
      case 'delClip': deleteSelectedClip(); break;
      case 'zoomIn': setZoom(view.zoom * 1.35); break;
      case 'zoomOut': setZoom(view.zoom / 1.35); break;
      case 'fit': fit(); break;
      default: break;
    }
  }

  R.clipvol.addEventListener('input', () => {
    const id = selectedClipId();
    if (id) cmd.updateSound(id, { volume: Number(R.clipvol.value) / 100 }, `vol-${id}`);
  }, { signal });
  R.zoom.addEventListener('input', () => setZoom(sliderToZoom(Number(R.zoom.value)), null), { signal });

  const sliderToZoom = (v) => clampZoom(MIN_ZOOM * Math.pow(MAX_ZOOM / MIN_ZOOM, v / 100));
  const zoomToSlider = (z) => Math.round((Math.log(z / MIN_ZOOM) / Math.log(MAX_ZOOM / MIN_ZOOM)) * 100);

  function setZoom(z, anchorClientX) {
    const next = clampZoom(z);
    if (Math.abs(next - view.zoom) < 1e-6) return;
    const sc = R.scroll;
    let off;
    if (anchorClientX === undefined || anchorClientX === null) off = sc.clientWidth / 2;
    else off = anchorClientX - sc.getBoundingClientRect().left;
    pendingAnchor = { t: (sc.scrollLeft + off) / view.pps, off };
    cmd.zoom(Math.round(next * 100) / 100);
  }

  function fit() {
    const total = Math.max(view.total, 1000);
    pendingAnchor = { t: 0, off: 0 };
    cmd.zoom(Math.round(fitZoom(total, R.scroll.clientWidth - 40) * 100) / 100);
  }

  R.scroll.addEventListener('wheel', (ev) => {
    if (ev.ctrlKey || ev.metaKey) {
      ev.preventDefault();
      setZoom(view.zoom * Math.exp(-ev.deltaY * 0.0035), ev.clientX);
    } else if (ev.shiftKey && ev.deltaX === 0) {
      ev.preventDefault();
      R.scroll.scrollLeft += ev.deltaY;
    }
  }, { signal, passive: false });

  // ---------------------------------------------------------------- clip editing helpers
  function deleteSelectedClip() {
    const c = selectedClip();
    if (!c) return;
    cmd.removeSound(c.id);
    cmd.select(currentSceneId(), null, 'scene');
    toast('Clip removed. Undo with Ctrl+Z.', 'info', 2600);
  }

  function splitSelected() {
    const c = selectedClip();
    if (!c) return;
    const parts = splitClip(c, state().playhead);
    if (!parts) { toast('Move the playhead inside the clip to split it.', 'info'); return; }
    cmd.updateSound(c.id, parts[0]);
    cmd.addSound({ kind: c.kind, assetId: c.assetId, volume: c.volume, text: c.text, voice: c.voice, ...parts[1] }); // store selects it
  }

  // ---------------------------------------------------------------- keyboard
  function isTyping(t) {
    return t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  }

  function onKey(ev) {
    if (ev.defaultPrevented || !root.isConnected) return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const t = ev.target;
    if (isTyping(t) && !(t === R.clipvol || t === R.zoom)) return;
    if (t instanceof Element && t.closest('dialog')) return;
    if (!el.offsetParent && el.getClientRects().length === 0) return; // collapsed panel
    const inside = root.contains(t) || root.contains(document.activeElement);
    const onBody = t === document.body || t === document.documentElement;
    if (!inside && !onBody) return;
    const k = ev.key;
    const lower = k.length === 1 ? k.toLowerCase() : k;
    const ph = state().playhead;
    const end = movieDuration(cur());
    const seek = (ms) => { const v = clamp(ms, 0, end); audio?.seek(v); reveal(v); };
    const isBtn = t instanceof HTMLElement && /^(BUTTON|A)$/.test(t.tagName);
    let h = true;
    if (k === ' ') {
      if (isBtn && !onBody) return; // let the focused button activate
      if (t instanceof HTMLElement && t.getAttribute('role') === 'button' && inside) { /* clip/scene handles Space as play */ }
      act('play');
    } else if (lower === 'k') audio?.pause();
    else if (lower === 'l' && ev.shiftKey) act('loop');
    else if (lower === 'l') { audio?.isPlaying?.() ? seek(ph + 1000) : audio?.play(); }
    else if (lower === 'j') seek(ph - 1000);
    else if (lower === 's' && selectedClipId()) splitSelected();
    else if ((k === 'Delete' || k === 'Backspace') && selectedClipId()) deleteSelectedClip();
    else if (k === '[' ) gotoScene(-1);
    else if (k === ']') gotoScene(1);
    else if (inside) {
      if (k === 'ArrowLeft') seek(ph - (ev.shiftKey ? 1000 : FRAME_MS));
      else if (k === 'ArrowRight') seek(ph + (ev.shiftKey ? 1000 : FRAME_MS));
      else if (k === 'ArrowUp') gotoScene(-1);
      else if (k === 'ArrowDown') gotoScene(1);
      else if (k === 'Home') seek(0);
      else if (k === 'End') seek(end);
      else if (k === '+' || k === '=') setZoom(view.zoom * 1.35);
      else if (k === '-' || k === '_') setZoom(view.zoom / 1.35);
      else if (k === '0') fit();
      else if ((k === 'Delete' || k === 'Backspace') && selection().kind === 'scene' && cur().scenes.length > 1) act('delScene');
      else h = false;
    } else h = false;
    if (h) ev.preventDefault();
  }
  document.addEventListener('keydown', onKey, { signal });

  function gotoScene(dir) {
    const m = cur();
    const at = sceneAt(m, state().playhead);
    if (!at) return;
    // "previous" first jumps to the start of the current scene when we are well inside it
    let idx = at.index;
    if (dir < 0 && at.local < 300) idx -= 1;
    else if (dir > 0) idx += 1;
    idx = clamp(idx, 0, m.scenes.length - 1);
    const sc = m.scenes[idx];
    selectScene(sc.id);
    audio?.seek(sceneStartOf(sc.id));
    reveal(sceneStartOf(sc.id));
  }

  // ---------------------------------------------------------------- dialogs
  function makeDialog(html, cls = '') {
    const d = document.createElement('dialog');
    d.className = `tl-dialog ${cls}`;
    d.innerHTML = html;
    root.append(d);
    d.addEventListener('close', () => d.remove());
    d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
    d.showModal();
    return d;
  }

  const movieKey = () => cur().id || cur().meta?.presaveId || '';

  // ---- text to speech
  async function openTts() {
    const d = makeDialog(`
      <form method="dialog" class="tl-form" novalidate>
        <h2>Add a voice</h2>
        <p class="tl-form-sub">Type what the character says. The clip lands at the playhead (<span class="tnum">${fmtTime(state().playhead)}</span>).</p>
        <label class="tl-field"><span>Voice</span>
          <select class="select" data-r="voice" disabled><option>Loading voices</option></select>
        </label>
        <label class="tl-field"><span>Text <small class="tnum" data-r="count">0 / 500</small></span>
          <textarea class="input" data-r="text" rows="4" maxlength="500" placeholder="Hello! Welcome to my video."></textarea>
        </label>
        <div class="tl-form-status" data-r="status" role="status" aria-live="polite"></div>
        <div class="dialog-actions">
          <button class="btn btn-ghost" type="button" data-r="cancel">Cancel</button>
          <button class="btn btn-primary" type="submit" data-r="go" disabled>${ic('mic')}Add voice</button>
        </div>
      </form>`);
    const q = (n) => d.querySelector(`[data-r="${n}"]`);
    const sel = q('voice'), txt = q('text'), status = q('status'), go = q('go');
    q('cancel').addEventListener('click', () => d.close());
    txt.addEventListener('input', () => { q('count').textContent = `${txt.value.length} / 500`; go.disabled = !txt.value.trim() || sel.disabled; });
    setTimeout(() => txt.focus(), 30);

    const setStatus = (msg, kind) => { status.textContent = msg; status.dataset.kind = kind || ''; };
    const loadVoices = async () => {
      setStatus('', '');
      sel.disabled = true; sel.innerHTML = '<option>Loading voices</option>';
      try {
        voicesPromise ??= fetch('/goapi/getTextToSpeechVoices', { method: 'POST' })
          .then((r) => { if (!r.ok) throw new Error(`Server responded ${r.status}`); return r.text(); })
          .then(parseVoicesXml);
        const langs = await voicesPromise;
        if (!langs.length) { sel.innerHTML = '<option>No voices available</option>'; setStatus('No text-to-speech voices are enabled on this server. You can still upload audio.', 'warn'); return; }
        const saved = safeGet(VOICE_KEY);
        sel.innerHTML = langs.map((l) => `<optgroup label="${esc(l.desc)}">${l.voices.map((v) => `<option value="${esc(v.id)}"${v.id === saved ? ' selected' : ''}>${esc(v.desc)}${v.sex ? ` (${esc(v.sex)})` : ''}</option>`).join('')}</optgroup>`).join('');
        sel.disabled = false;
        go.disabled = !txt.value.trim();
      } catch (err) {
        voicesPromise = null;
        sel.innerHTML = '<option>Voices unavailable</option>';
        setStatus('Could not load the voice list. Check your connection.', 'error');
        const retry = document.createElement('button');
        retry.type = 'button'; retry.className = 'tl-link'; retry.innerHTML = `${ic('refresh')}Try again`;
        retry.addEventListener('click', loadVoices);
        status.append(' ', retry);
      }
    };
    loadVoices();

    d.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (go.disabled) return;
      const text = txt.value.trim();
      const voice = sel.value;
      const mk = movieKey();
      if (!mk) { setStatus('This movie is not ready yet. Wait a moment, or save it once, then try again.', 'error'); return; }
      go.disabled = true; sel.disabled = true; txt.disabled = true;
      setStatus('Generating voice', 'busy');
      try {
        const body = new URLSearchParams({ voice, text, presaveId: String(mk), movieId: String(mk) });
        const res = await fetch('/goapi/convertTextToSoundAsset', { method: 'POST', body });
        const parsed = parseConvertResponse(await res.text());
        if (!parsed.ok) throw new Error(parsed.error);
        safeSet(VOICE_KEY, voice);
        const start = Math.round(state().playhead);
        const assetId = ugcAssetId(parsed.id);
        const dur = parsed.duration > 0 ? parsed.duration : 2000;
        cmd.addSound({ kind: 'tts', assetId, start, end: start + dur, volume: 1, text, voice }); // store selects it
        audio?.probe?.(assetId);
        reveal(start);
        d.close();
        toast('Voice added to the timeline.', 'info', 2400);
      } catch (err) {
        setStatus(err instanceof Error ? err.message : 'The voice could not be generated.', 'error');
        go.disabled = false; sel.disabled = false; txt.disabled = false;
      }
    });
  }

  // ---- upload
  function openUpload(kind = 'voice') {
    const d = makeDialog(`
      <form method="dialog" class="tl-form" novalidate>
        <h2>Upload audio</h2>
        <p class="tl-form-sub">MP3, WAV or OGG, up to 25 MB. It is placed at the playhead (<span class="tnum">${fmtTime(state().playhead)}</span>).</p>
        <div class="tl-field"><span>Add it as</span>
          <div class="segmented" role="radiogroup" aria-label="Audio type">
            ${[['voice', 'Voice'], ['bgmusic', 'Music'], ['sfx', 'Sound FX']].map(([v, l]) => `<label><input type="radio" name="kind" value="${v}"${v === kind ? ' checked' : ''}><span>${l}</span></label>`).join('')}
          </div>
        </div>
        <button type="button" class="tl-drop-zone" data-r="zone">${ic('upload')}<b data-r="zonetext">Choose a file</b><small>or drop it here</small></button>
        <div class="tl-form-status" data-r="status" role="status" aria-live="polite"></div>
        <div class="dialog-actions">
          <button class="btn btn-ghost" type="button" data-r="cancel">Cancel</button>
        </div>
      </form>`);
    const q = (n) => d.querySelector(`[data-r="${n}"]`);
    const status = q('status'), zone = q('zone');
    q('cancel').addEventListener('click', () => d.close());
    const kindNow = () => d.querySelector('input[name="kind"]:checked')?.value || kind;
    const run = async (file) => {
      if (!file) return;
      zone.disabled = true;
      status.dataset.kind = 'busy';
      status.textContent = `Uploading ${file.name}`;
      try {
        await uploadAndAdd(file, kindNow(), Math.round(state().playhead), (m) => { status.textContent = m; });
        d.close();
      } catch (err) {
        status.dataset.kind = 'error';
        status.textContent = err instanceof Error ? err.message : 'Upload failed.';
        zone.disabled = false;
      }
    };
    zone.addEventListener('click', () => { R.file.value = ''; R.file.onchange = () => run(R.file.files?.[0]); R.file.click(); });
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('is-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('is-over'));
    zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('is-over'); run(e.dataTransfer?.files?.[0]); });
  }

  /** POST /upload_asset (multipart field `import`, returns the new asset id as plain text), then add a clip. */
  async function uploadAndAdd(file, kind, startMs, progress) {
    try {
      if (!/^audio\//.test(file.type) && !/\.(mp3|wav|ogg|m4a|aac)$/i.test(file.name)) throw new Error('That does not look like an audio file.');
      if (file.size > 25 * 1024 * 1024) throw new Error('That file is larger than 25 MB.');
      const fd = new FormData();
      fd.append('import', file, file.name);
      const res = await fetch('/upload_asset', { method: 'POST', body: fd });
      const body = (await res.text()).trim();
      if (!res.ok || !body) throw new Error(res.status === 400 ? 'Open or save a movie first, then upload.' : `Upload failed (${res.status}).`);
      progress?.('Reading audio');
      const assetId = ugcAssetId(body);
      const info = await audio?.probe?.(assetId);
      if (info && info.status === 'error') throw new Error('The server stored the file but it could not be decoded as audio.');
      let dur = info?.duration || 3000;
      const total = view.total;
      let start = startMs;
      if (kind === 'bgmusic' && !cur().sounds.some((c) => c.kind === 'bgmusic')) start = 0;
      let end = start + dur;
      if (kind === 'bgmusic' && total > start) end = Math.min(end, Math.max(total, start + 1000));
      cmd.addSound({ kind, assetId, start: Math.round(start), end: Math.round(end), volume: kind === 'bgmusic' ? 0.5 : 1 });
      reveal(start);
      toast(`${file.name} added.`, 'info', 2400);
    } catch (err) {
      if (!progress) toast(err instanceof Error ? err.message : 'Upload failed.', 'error', 5000);
      throw err;
    }
  }

  // ---------------------------------------------------------------- go
  last = { movie: null, selection: null, zoom: null, playhead: -1, playing: null };
  render();
  const initial = state();
  if (!Number.isFinite(initial.zoom) || initial.zoom <= 0) cmd.zoom(DEFAULT_ZOOM);

  return {
    destroy() {
      ac.abort();
      unsub();
      unsubAssets?.();
      ro.disconnect();
      cancelAnimationFrame(raf); cancelAnimationFrame(lightRaf); cancelAnimationFrame(waveRaf); cancelAnimationFrame(rulerRaf);
      thumbCache.clear(); // object URLs belong to the shared thumbs cache; do not revoke them
      el.innerHTML = '';
      el.classList.remove('tl-host');
    },
    /** Fit the whole movie into the visible width. */
    fit,
  };
}

function ensureStylesheet() {
  if ([...document.styleSheets].some((s) => s.href && s.href.endsWith(CSS_HREF))) return;
  if (document.querySelector(`link[href="${CSS_HREF}"]`)) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = CSS_HREF;
  document.head.append(l);
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
