import { initShell, api, esc, toast, confirmDialog, makeVideoHref } from '../shell.js';
import { icon } from '../icons.js';

initShell({ active: 'videos' });

const PAGE = 48;
const $ = (s) => document.querySelector(s);
const grid = $('#grid'), content = $('#content');
const fmtDate = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
let all = [], shown = PAGE, query = '', sort = 'newest';

const SORTS = {
  newest: (a, b) => (b.date ?? 0) - (a.date ?? 0),
  oldest: (a, b) => (a.date ?? 0) - (b.date ?? 0),
  title: (a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }),
  longest: (a, b) => b.duration - a.duration,
};

function skeleton() {
  content.innerHTML = `<ul class="grid grid-skeleton" aria-hidden="true">${Array.from({ length: 8 }, () =>
    '<li><div class="thumb skeleton"></div><div class="line skeleton" style="width:70%"></div><div class="line skeleton" style="width:40%"></div></li>').join('')}</ul>`;
}

function stateBlock({ title, body, actions = '' }) {
  content.innerHTML = `<div class="state"><h2>${title}</h2><p>${body}</p><div class="state-actions">${actions}</div></div>`;
}

function tile(m, i) {
  const t = esc(m.title);
  return `<li class="tile" data-id="${esc(m.id)}" style="--i:${i}">
    <a class="thumb" href="/player?movieId=${encodeURIComponent(m.id)}" aria-label="Play ${t}" tabindex="-1">
      <img src="${api.movieThumb(m.id)}" alt="" loading="lazy" width="320" height="180">
      <span class="ph">${icon('film')}</span>
      ${m.durationString ? `<span class="dur tnum">${esc(m.durationString)}</span>` : ''}
    </a>
    <div>
      <div class="tile-title" title="${t}">${t}</div>
      <div class="tile-meta tnum">${m.date ? fmtDate.format(m.date) : ''}</div>
    </div>
    <div class="tile-actions">
      <a class="btn btn-sm btn-brand" href="/go_full?movieId=${encodeURIComponent(m.id)}">${icon('edit')}Edit</a>
      <a class="btn btn-sm" href="/player?movieId=${encodeURIComponent(m.id)}">${icon('play')}Play</a>
      <span class="spacer"></span>
      <a class="btn btn-sm btn-ghost btn-icon" href="${api.movieDownload(m.id)}" download="${t}.xml" aria-label="Download ${t}" title="Download">${icon('download')}</a>
      <button class="btn btn-sm btn-ghost btn-icon btn-danger-ghost" type="button" data-delete aria-label="Delete ${t}" title="Delete">${icon('trash')}</button>
    </div>
  </li>`;
}

function render() {
  const q = query.trim().toLowerCase();
  const list = all.filter((m) => !q || m.title.toLowerCase().includes(q)).sort(SORTS[sort]);
  $('#count').textContent = all.length ? `${all.length}` : '';
  if (!all.length) {
    stateBlock({
      title: 'No videos yet',
      body: 'Make your first video, or upload one you saved from another Redrawn or Wrapper install.',
      actions: `<a class="btn btn-primary" href="${makeVideoHref()}" data-make>${icon('plus')}Make a video</a>`,
    });
    return;
  }
  const visible = list.slice(0, shown);
  content.innerHTML = `
    <ul class="grid" id="grid">
      ${q ? '' : `<li><a class="new-tile" href="${makeVideoHref()}" data-make>${icon('plus')}New video</a></li>`}
      ${visible.map(tile).join('')}
    </ul>
    ${!list.length ? `<div class="state"><h2>No match</h2><p>Nothing is titled like "${esc(query)}".</p></div>` : ''}
    ${list.length > visible.length ? `<div class="load-more"><button class="btn" type="button" id="more">Show ${Math.min(PAGE, list.length - visible.length)} more</button></div>` : ''}`;
}

async function load() {
  skeleton();
  try { all = await api.movies(); render(); } catch (e) {
    stateBlock({
      title: "Couldn't load your videos",
      body: esc(e.message) + ' Check that the Redrawn server is running, then try again.',
      actions: `<button class="btn btn-brand" type="button" id="retry">${icon('refresh')}Try again</button>`,
    });
  }
}

content.addEventListener('click', async (e) => {
  if (e.target.closest('#retry')) return load();
  if (e.target.closest('#more')) { shown += PAGE; return render(); }
  const del = e.target.closest('[data-delete]');
  if (!del) return;
  const li = del.closest('.tile'), id = li.dataset.id, m = all.find((x) => x.id === id);
  const ok = await confirmDialog({ title: 'Delete this video?', body: `"${m.title}" will be permanently deleted. This can't be undone.`, confirmLabel: 'Delete', danger: true });
  if (!ok) return;
  li.classList.add('is-removing');
  try { await api.deleteMovie(id); all = all.filter((x) => x.id !== id); render(); toast('Video deleted'); }
  catch { li.classList.remove('is-removing'); toast("Couldn't delete the video. Try again.", { kind: 'error' }); }
});
content.addEventListener('error', (e) => { if (e.target.tagName === 'IMG') e.target.closest('.thumb')?.classList.add('is-broken'); }, true);

$('#q').addEventListener('input', (e) => { query = e.target.value; shown = PAGE; render(); });
$('#sort').addEventListener('change', (e) => { sort = e.target.value; render(); });

load();
