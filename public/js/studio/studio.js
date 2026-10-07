// Redrawn Studio: boots the editor and integrates core (store/model/xml), stage, assets, timeline, audio.
import { applyTheme, getPrefs, setPref } from '../prefs.js';
import { toast, esc } from '../shell.js';
import { api } from '../api.js';
import { icon } from '../icons.js';
import { createMovie } from './model.js';
import { createStore } from './store.js';
import { parseMovieXml } from './movie-xml.js';
import { mountToolbar, MOD } from './toolbar.js';
import { mountInspector } from './inspector.js';
import { saveMovie, exportXml, makeThumbnail, download, safeName, SaveError } from './export.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const noAutosave = params.has('noAutosave');
const LAYOUT_KEY = 'redrawn.studio.layout.v1';
const AUTOSAVE_MS = 4000;

/** Import an optional module; a missing or broken one degrades to a placeholder instead of killing the editor. */
async function optional(name) {
  try { return await import(`./${name}.js`); } catch (e) { console.warn(`[studio] ${name}.js unavailable:`, e); return null; }
}

boot().catch(bootError);

async function boot() {
  applyTheme(getPrefs().theme);
  const app = $('app');
  const msg = (t) => { $('boot-msg').textContent = t; };

  // ---- load or create the movie ----
  msg('Opening your video');
  const wantedId = params.get('movieId');
  let movieId = null;
  let presaveId = null;
  let movie;
  if (wantedId && /^m-\d+$/.test(wantedId)) {
    const res = await fetch(`/movies/${encodeURIComponent(wantedId)}.xml`).catch(() => null);
    if (!res?.ok) throw new Error(`Could not open video ${wantedId} (server responded ${res?.status ?? 'nothing'}).`);
    movie = parseMovieXml(await res.text());
    movie.id = wantedId; movieId = wantedId;
  } else {
    movie = createMovie();
    if (params.get('theme')) movie.themeId = params.get('theme');
  }
  const store = createStore(movie);

  // ---- optional modules (built by other agents) ----
  msg('Loading editor modules');
  const [themes, stageMod, assetsMod, timelineMod, audioMod, thumbsMod] = await Promise.all(
    ['themes', 'stage', 'assets-panel', 'timeline', 'audio', 'thumbs'].map(optional));
  const getThumb = thumbsMod?.getAssetThumb;

  // ---- layout ----
  const layout = loadLayout();
  const applyLayout = () => {
    const root = document.body;
    root.style.setProperty('--left-w', `${layout.leftW}px`);
    root.style.setProperty('--right-w', `${layout.rightW}px`);
    root.style.setProperty('--bottom-h', `${layout.bottomH}px`);
    for (const k of ['left', 'right', 'bottom']) app.dataset[k] = layout[k] ? 'on' : 'off';
    saveLayout(layout);
  };
  if (innerWidth < 1100) layout.right = false;
  applyLayout();
  initResizers(app, layout, applyLayout);

  // ---- modules ----
  const audio = audioMod?.createAudioEngine ? audioMod.createAudioEngine(store) : null;
  const stage = stageMod?.createStage ? await safe(() => stageMod.createStage($('stage'), { store, themes, audio }), 'stage') : null;
  if (!stage) $('stage').innerHTML = `<div class="st-stage-fallback"><div class="box">${icon('film')}</div><p>The stage is not available.</p></div>`;
  const assets = assetsMod?.mountAssetsPanel ? await safe(() => assetsMod.mountAssetsPanel($('assets'), { store, themes, stage }), 'assets') : null;
  if (!assets) $('assets').innerHTML = emptyPanel('Assets unavailable', 'The assets panel failed to load.');
  const timeline = timelineMod?.mountTimeline ? await safe(() => timelineMod.mountTimeline($('timeline'), { store, stage, audio }), 'timeline') : null;
  if (!timeline) $('timeline').innerHTML = emptyPanel('Timeline unavailable', 'The timeline failed to load.');
  const inspector = mountInspector($('inspector'), { store, themes });

  // ---- save ----
  let saving = false, queued = false, autosaveTimer = 0, lastSavedAt = null;
  const toolbar = mountToolbar($('toolbar'), {
    store, classicHref: getPrefs().autosave ? '/go_full' : '/go_full?noAutosave=1',
    panels: () => layout,
    actions: {
      undo: () => store.undo(), redo: () => store.redo(),
      save: () => save({ manual: true }),
      preview: () => togglePreview(),
      exportXml: () => exportXml(store.get().movie),
      exportZip: async () => { const id = await save({ manual: true }); if (id) download(await (await fetch(`/movies/${id}.zip`)).blob(), `${safeName(store.get().movie.title)}.zip`); },
      exportPng: async () => download((await makeThumbnail(store.get().movie, { stage, getThumb })).blob, `${safeName(store.get().movie.title)}.png`),
      shortcuts: () => showShortcuts(),
      theme: () => { const dark = document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches); setPref('theme', dark ? 'light' : 'dark'); },
      new: () => newVideo(),
      togglePanel: (k) => { layout[k] = !layout[k]; applyLayout(); },
    },
  });

  function status() {
    if (saving) return toolbar.setStatus('saving', 'Saving...');
    if (store.isDirty()) return toolbar.setStatus('dirty', movieId || presaveId ? 'Unsaved changes' : 'Not saved yet');
    if (lastSavedAt) return toolbar.setStatus('saved', `Saved ${lastSavedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
    toolbar.setStatus(movieId ? 'saved' : 'new', movieId ? 'Saved' : 'New video');
  }

  /** @returns {Promise<string|null>} the saved id, or null on failure */
  async function save({ manual = false } = {}) {
    clearTimeout(autosaveTimer);
    if (saving) { queued = true; return null; }
    saving = true; status();
    try {
      if (!movieId && !presaveId) presaveId = await api.presaveMovie(noAutosave);
      const snapshot = store.get().movie;
      const thumb = await makeThumbnail(snapshot, { stage, getThumb }).catch(() => null);
      const id = await saveMovie(snapshot, { movieId, presaveId, thumbnail: thumb?.base64 });
      movieId = id; presaveId = null; lastSavedAt = new Date();
      if (store.get().movie === snapshot) store.markSaved();
      if (params.get('movieId') !== id) { params.set('movieId', id); history.replaceState(null, '', `${location.pathname}?${params}`); }
      if (manual) toast('Saved');
      return id;
    } catch (e) {
      toolbar.setStatus('error', 'Save failed');
      toast(e instanceof SaveError || e instanceof Error ? e.message : 'Save failed', { kind: 'error', ms: 6000 });
      return null;
    } finally {
      saving = false; status();
      if (queued) { queued = false; scheduleAutosave(); }
    }
  }

  // Legacy rule: autosave only for videos that were saved once (a brand-new video is never saved unasked).
  function scheduleAutosave() {
    clearTimeout(autosaveTimer);
    if (!getPrefs().autosave || noAutosave || !movieId || !store.isDirty()) return;
    autosaveTimer = setTimeout(() => save(), AUTOSAVE_MS);
  }
  let lastMovie = store.get().movie;
  const unsub = store.subscribe((s) => {
    document.title = `${s.movie.title && s.movie.title !== 'Untitled' ? s.movie.title : 'Untitled video'} · Studio`;
    if (s.movie !== lastMovie) { lastMovie = s.movie; scheduleAutosave(); }
    status();
  });
  status();

  addEventListener('beforeunload', (e) => { if (store.isDirty()) { e.preventDefault(); e.returnValue = ''; } });
  addEventListener('pagehide', () => { if (store.isDirty() && movieId && getPrefs().autosave && !noAutosave) save(); });

  async function newVideo() {
    if (store.isDirty() && !confirm('You have unsaved changes. Start a new video anyway?')) return;
    store.markSaved();
    location.href = '/studio';
  }

  // ---- preview ----
  const center = $('center');
  let previewing = false;
  async function togglePreview(on = !previewing) {
    if (on === previewing) return;
    previewing = on;
    center.classList.toggle('is-preview', on);
    center.querySelector('.st-preview-bar')?.remove();
    if (on) {
      center.insertAdjacentHTML('afterbegin', `<div class="st-preview-bar"><button type="button" class="btn btn-sm" aria-label="Exit preview">${icon('close')}Exit preview (Esc)</button></div>`);
      center.querySelector('.st-preview-bar button').addEventListener('click', () => togglePreview(false));
      store.dispatch({ type: 'select', sceneId: store.get().selection?.sceneId, elemId: null, kind: 'scene' });
      try { await center.requestFullscreen?.(); } catch { /* the fixed overlay still fills the window */ }
      stage?.setTool?.('view'); stage?.seek?.(0); stage?.play?.();
    } else {
      stage?.pause?.(); stage?.setTool?.('select');
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    }
  }
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && previewing) togglePreview(false); });

  // ---- keyboard ----
  const onKey = (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const t = e.target;
    const typing = t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    if (e.key === 'Escape' && previewing) { e.preventDefault(); togglePreview(false); return; }
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save({ manual: true }); return; }
    if (typing || e.altKey) return;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? store.redo() : store.undo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); store.redo(); return; }
    if (mod) return;
    if (e.key === '?') { e.preventDefault(); showShortcuts(); }
    else if (e.key.toLowerCase() === 'p') { e.preventDefault(); togglePreview(); }
  };
  addEventListener('keydown', onKey);

  // ---- go ----
  app.dataset.ready = 'true';
  $('boot').classList.add('is-done');
  setTimeout(() => $('boot').remove(), 400);

  window.studio = { store, stage, audio, themes, save, togglePreview, get movieId() { return movieId; }, destroy() { unsub(); removeEventListener('keydown', onKey); inspector.destroy(); toolbar.destroy(); timeline?.destroy?.(); assets?.destroy?.(); stage?.destroy?.(); } };
}

async function safe(fn, name) {
  try { return await fn(); } catch (e) { console.error(`[studio] ${name} failed`, e); toast(`The ${name} failed to start.`, { kind: 'error', ms: 6000 }); return null; }
}

function emptyPanel(title, body) {
  return `<div class="st-empty">${icon('alert')}<h3>${esc(title)}</h3><p>${esc(body)}</p></div>`;
}

function bootError(e) {
  console.error(e);
  const boot = $('boot');
  boot.classList.add('is-error');
  boot.innerHTML = `<div class="st-error-box" role="alert"><h2>Studio could not start</h2><p>${esc(e?.message || String(e))}</p>
    <div class="state-actions" style="display:flex;gap:8px"><button class="btn btn-brand" type="button" id="retry">${icon('refresh')}Try again</button><a class="btn" href="/">Back to videos</a><a class="btn btn-ghost" href="/go_full">Classic editor</a></div></div>`;
  $('retry').addEventListener('click', () => location.reload());
}

// ---- layout persistence + resizers ----
function loadLayout() {
  const d = { leftW: 300, rightW: 280, bottomH: 232, left: true, right: true, bottom: true };
  try { return { ...d, ...JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}') }; } catch { return d; }
}
function saveLayout(l) { try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(l)); } catch { /* storage blocked */ } }

function initResizers(app, layout, apply) {
  const lim = { leftW: [220, 520], rightW: [220, 460], bottomH: [140, () => innerHeight * 0.6] };
  const clamp = (k, v) => Math.round(Math.min(typeof lim[k][1] === 'function' ? lim[k][1]() : lim[k][1], Math.max(lim[k][0], v)));
  const keyOf = { left: 'leftW', right: 'rightW', bottom: 'bottomH' };
  for (const r of app.querySelectorAll('[data-resize]')) {
    const side = r.dataset.resize, k = keyOf[side];
    r.addEventListener('pointerdown', (e) => {
      e.preventDefault(); r.setPointerCapture(e.pointerId); r.classList.add('is-active');
      document.body.style.userSelect = 'none';
      const move = (ev) => {
        layout[k] = clamp(k, side === 'left' ? ev.clientX : side === 'right' ? innerWidth - ev.clientX : innerHeight - ev.clientY);
        apply();
      };
      const up = () => { r.classList.remove('is-active'); document.body.style.userSelect = ''; r.removeEventListener('pointermove', move); r.removeEventListener('pointerup', up); r.removeEventListener('pointercancel', up); };
      r.addEventListener('pointermove', move); r.addEventListener('pointerup', up); r.addEventListener('pointercancel', up);
    });
    r.addEventListener('keydown', (e) => {
      const grow = side === 'left' ? 'ArrowRight' : side === 'right' ? 'ArrowLeft' : 'ArrowUp';
      const shrink = side === 'left' ? 'ArrowLeft' : side === 'right' ? 'ArrowRight' : 'ArrowDown';
      if (e.key !== grow && e.key !== shrink) return;
      e.preventDefault(); layout[k] = clamp(k, layout[k] + (e.key === grow ? 24 : -24)); apply();
    });
    r.addEventListener('dblclick', () => { layout[side] = false; apply(); });
  }
}

// ---- shortcuts dialog ----
function showShortcuts() {
  if (document.querySelector('dialog.st-shortcuts')) return;
  const rows = [
    ['Save', [MOD, 'S']], ['Undo', [MOD, 'Z']], ['Redo', [MOD, 'Shift', 'Z']], ['Preview full screen', ['P']],
    ['Play / pause', ['Space']], ['Step a frame', ['←', '→']], ['Delete selection', ['Del']],
    ['Nudge selection', ['Arrows']], ['Show this help', ['?']],
  ];
  const d = document.createElement('dialog');
  d.className = 'st-shortcuts'; d.setAttribute('aria-labelledby', 'sc-title');
  d.innerHTML = `<form method="dialog"><h2 id="sc-title">Keyboard shortcuts</h2><dl>${rows.map(([n, ks]) => `<dt>${n}</dt><dd>${ks.map((k) => `<kbd class="st-kbd">${k}</kbd>`).join('')}</dd>`).join('')}</dl>
    <div class="dialog-actions"><button class="btn btn-brand" value="ok" autofocus>Done</button></div></form>`;
  d.addEventListener('close', () => d.remove());
  document.body.appendChild(d); d.showModal();
}
