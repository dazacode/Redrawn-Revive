// The ONLY module that knows about Ruffle. Everything else calls mountPlayer().
// To change Ruffle version/config once the spike finishes, edit RUFFLE below.
import { encodeFlashvars } from './flashvars.js';

const RUFFLE = {
  // Where the self-hosted build lives (files: ruffle.js, core.ruffle.*.js, *.wasm).
  // TODO(spike): confirm the final path/version. Override at runtime with window.REDRAWN_RUFFLE_BASE.
  base: '/vendor/ruffle/',
  entry: 'ruffle.js',
  // Passed to window.RufflePlayer.config (global) before the script loads.
  // compatibilityRules off + longer script limit: required for go_full.swf to get past its preloader (found in the spike).
  globalConfig: { polyfills: false, warnOnUnsupportedContent: false, logLevel: 'warn', compatibilityRules: false, maxExecutionDuration: 3000 },
  // Per-player config merged into player.load().
  playerConfig: { autoplay: 'on', unmuteOverlay: 'visible', letterbox: 'on', contextMenu: 'rightClickOnly',
    splashScreen: false, allowScriptAccess: true, openUrlMode: 'allow', menu: false },
  loadTimeoutMs: 45000,
};

let scriptPromise;
function loadScript() {
  if (window.RufflePlayer?.newest) return Promise.resolve();
  return (scriptPromise ??= new Promise((resolve, reject) => {
    const base = window.REDRAWN_RUFFLE_BASE || RUFFLE.base;
    window.RufflePlayer = window.RufflePlayer || {};
    window.RufflePlayer.config = { ...RUFFLE.globalConfig, publicPath: base, ...(window.RufflePlayer.config || {}) };
    const s = document.createElement('script');
    s.src = base + RUFFLE.entry;
    s.onload = () => (window.RufflePlayer?.newest ? resolve() : reject(new Error('Ruffle loaded but window.RufflePlayer is missing.')));
    s.onerror = () => { scriptPromise = null; reject(new Error(`Could not load the Flash player from ${s.src}`)); };
    document.head.appendChild(s);
  }));
}

/**
 * @param {object} o
 * @param {string} o.swfUrl
 * @param {Record<string,any>|string} o.flashvars  object (legacy encoding applied) or ready-made query string
 * @param {HTMLElement} o.container                element to fill; cleared of any previous player
 * @param {boolean} [o.allowFullScreen]
 * @param {string} [o.quality]                     'high' | 'medium' | 'low'
 * @param {(stage:'player'|'movie'|'ready'|'slow')=>void} [o.onStatus]
 * @returns {Promise<{destroy():void, fullscreen():void, element:HTMLElement}>}  rejects with Error on failure
 */
export async function mountPlayer({ swfUrl, flashvars, container, allowFullScreen = false, quality, onStatus = () => {} }) {
  onStatus('player');
  await loadScript();
  const ruffle = window.RufflePlayer.newest();
  const el = ruffle.createPlayer();
  el.style.width = '100%'; el.style.height = '100%';
  container.replaceChildren(el);
  onStatus('movie');

  const parameters = typeof flashvars === 'string' ? flashvars : encodeFlashvars(flashvars);
  const config = { ...RUFFLE.playerConfig, url: swfUrl, base: swfUrl.replace(/[^/]*$/, ''), parameters, allowFullscreen: allowFullScreen, ...(quality ? { quality } : {}) };

  let settled = false;
  const slow = setTimeout(() => !settled && onStatus('slow'), RUFFLE.loadTimeoutMs);
  // A hidden tab should cost nothing: pause the movie (and its audio) until the tab is visible again.
  const onVis = () => { try { document.hidden ? el.pause?.() : el.play?.(); } catch { /* player not ready */ } };
  document.addEventListener('visibilitychange', onVis);
  const handle = {
    element: el,
    destroy() { clearTimeout(slow); document.removeEventListener('visibilitychange', onVis); try { el.remove(); } catch { /* gone */ } },
    fullscreen() { el.enterFullscreen?.() ?? el.requestFullscreen?.(); },
  };

  await new Promise((resolve, reject) => {
    const ok = () => { if (!settled) { settled = true; clearTimeout(slow); onStatus('ready'); resolve(); } };
    el.addEventListener('loadedmetadata', ok, { once: true });
    try {
      const p = el.load(config);
      if (p?.then) p.then(ok, (e) => { if (!settled) { settled = true; clearTimeout(slow); reject(e instanceof Error ? e : new Error(String(e))); } });
      else setTimeout(ok, 0);
    } catch (e) { settled = true; clearTimeout(slow); reject(e); }
  }).catch((e) => { handle.destroy(); throw e; });

  return handle;
}
