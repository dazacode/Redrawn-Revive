// Shared editor shell for the four SWF pages. Served for /cc, /cc_browser, /go_full, /player
// (backend rewrites those routes to editor.html) or directly as /editor.html?type=<name>&...
import { initShell, esc, getPrefs } from '../shell.js';
import { api } from '../api.js';
import { icon } from '../icons.js';
import { EDITOR_TYPES, buildEditorSpec } from '../flashvars.js';
import { mountPlayer } from '../player.js';

const params = new URLSearchParams(location.search);
const type = params.get('type') || location.pathname.replace(/^\/+|\.html$/g, '');
const stage = document.getElementById('stage');

if (!EDITOR_TYPES.includes(type)) {
  document.body.className = 'editor';
  initShell({ active: null, title: 'Editor' });
  overlayError('Unknown page', `"${type || '(none)'}" is not an editor. Expected one of: ${EDITOR_TYPES.join(', ')}.`);
} else {
  document.body.classList.add('editor', `mode-${type}`);
  params.delete('type');
  const query = Object.fromEntries(params);
  delete query.mock;
  boot();

  async function boot() {
    const titles = { cc: 'Character Creator', cc_browser: 'Character Browser', go_full: 'Video Editor', player: 'Video Player' };
    document.title = `${titles[type]} · Redrawn`;
    initShell({ active: null, title: titles[type] });
    document.getElementById('back').href = type === 'cc' || type === 'cc_browser' ? '/characters.html' : '/';
    document.getElementById('fs').addEventListener('click', () => handle?.fullscreen());
    let handle;
    const run = async () => {
      handle?.destroy(); handle = null;
      showLoading('player');
      try {
        const cfg = await api.config();
        const extra = {};
        if (type === 'go_full' && !(query.movieId && query.movieId.startsWith('m'))) extra.presaveId = await api.presaveMovie(!!query.noAutosave);
        const spec = buildEditorSpec(type, query, cfg, extra);
        window.flashvars = spec.flashvars; // page.js exposes this global; some SWFs read it
        handle = await mountPlayer({
          swfUrl: spec.swfUrl, flashvars: spec.flashvars, container: stage.querySelector('.stage-mount'),
          allowFullScreen: spec.allowFullScreen, quality: getPrefs().quality, onStatus: showLoading,
        });
        stage.querySelector('.stage-overlay')?.remove();
      } catch (e) { overlayError("Couldn't start this page", e.message || String(e), run, e.stack); }
    };
    run();
  }
}

function showLoading(step) {
  const order = ['player', 'movie', 'ready'];
  const labels = { player: 'Starting Flash player', movie: 'Loading the editor', ready: 'Ready', slow: 'Still loading. This can take a while the first time.' };
  const idx = order.indexOf(step);
  const state = (i) => (i < idx ? 'done' : i === idx ? 'active' : 'todo');
  setOverlay(`<div class="spinner" role="progressbar" aria-label="Loading"></div>
    <h2>${esc(labels[step] ?? labels.movie)}</h2>
    <ol class="steps"><li data-state="${state(0)}">Player</li><li data-state="${state(1)}">Editor</li></ol>`);
}

function overlayError(title, message, retry, stack) {
  setOverlay(`${icon('alert', 'icon-lg')}
    <h2>${esc(title)}</h2><p>${esc(message)}</p>
    <div class="state-actions">${retry ? `<button class="btn btn-primary" type="button" id="retry">${icon('refresh')}Try again</button>` : ''}
    <a class="btn" href="/">${icon('back')}Back to videos</a></div>
    ${stack ? `<details><summary>Technical details</summary><pre>${esc(stack)}</pre></details>` : ''}`);
  stage.querySelector('#retry')?.addEventListener('click', retry);
}

function setOverlay(html) {
  let o = stage.querySelector('.stage-overlay');
  if (!o) { o = document.createElement('div'); o.className = 'stage-overlay'; stage.appendChild(o); }
  o.setAttribute('role', 'status'); o.innerHTML = html;
}
