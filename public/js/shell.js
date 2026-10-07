// Shared app chrome: header, mobile tab bar, upload forms, theme toggle, toast, confirm dialog.
import { icon } from './icons.js';
import { getPrefs, setPref, applyTheme } from './prefs.js';
import { api } from './api.js';

const NAV = [
  { id: 'videos', href: '/', label: 'Videos', icon: 'film' },
  { id: 'studio', href: '/studio', label: 'Studio', icon: 'edit' },
  { id: 'characters', href: '/characters.html', label: 'Characters', icon: 'users' },
  { id: 'settings', href: '/settings.html', label: 'Settings', icon: 'sliders' },
];

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Where "Make a video" goes, honouring the autosave preference. */
export const makeVideoHref = () => (getPrefs().autosave ? '/studio' : '/studio?noAutosave=1');
/** The original Flash editor (go_full.swf), still available next to Studio. */
export const classicHref = () => (getPrefs().autosave ? '/go_full' : '/go_full?noAutosave=1');

export function initShell({ active, title } = {}) {
  applyTheme(getPrefs().theme);
  const host = document.getElementById('shell-header');
  host.outerHTML = `
  <header class="app-header">
    <div class="app-header-inner">
      <a class="brand" href="/" aria-label="Redrawn home"><img src="/img/logo.png" alt="Redrawn" width="124" height="44"></a>
      <nav class="main-nav" aria-label="Main">
        ${NAV.map((n) => `<a href="${n.href}" ${n.id === active ? 'aria-current="page"' : ''}>${n.label}</a>`).join('')}
      </nav>
      ${title ? `<span class="header-title">${esc(title)}</span>` : ''}
      <div class="header-actions">
        <div class="menu" id="upload-menu">
          <button class="btn btn-sm" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="upload-panel">
            ${icon('upload')}<span class="label-wide">Upload</span>${icon('chevron')}
          </button>
        </div>
        <a class="btn btn-sm btn-ghost label-wide" href="${classicHref()}" data-classic>Classic editor</a>
        <a class="btn btn-primary btn-make" href="${makeVideoHref()}" aria-label="Make a video" data-make>${icon('plus')}<span class="label-wide">Make a video</span></a>
      </div>
    </div>
  </header>`;

  if (active) {
    document.body.classList.add('has-tabbar');
    document.body.insertAdjacentHTML('beforeend', `
    <nav class="tabbar" aria-label="Main">
      ${NAV.map((n) => `<a href="${n.href}" ${n.id === active ? 'aria-current="page"' : ''}>${icon(n.icon)}${n.label}</a>`).join('')}
    </nav>`);
  }

  // Hidden native upload forms (backend replies 302 to the editor).
  document.body.insertAdjacentHTML('beforeend', `
    <form hidden enctype="multipart/form-data" action="/upload_movie" method="post"><input id="file-movie" type="file" name="import" accept=".xml,.zip" tabindex="-1"></form>
    <form hidden enctype="multipart/form-data" action="/upload_character" method="post"><input id="file-char" type="file" name="import" accept=".xml,.zip" tabindex="-1"></form>
    <div class="toasts" role="status" aria-live="polite" id="toasts"></div>`);
  for (const id of ['file-movie', 'file-char']) {
    document.getElementById(id).addEventListener('change', (e) => { if (e.target.files.length) { toast('Uploading...'); e.target.form.submit(); } });
  }

  const upload = document.getElementById('upload-menu');
  popoverMenu(upload, `
    <button type="button" role="menuitem" data-pick="file-movie">${icon('film')}<span>Movie<span class="menu-hint">Import a video file</span></span></button>
    <button type="button" role="menuitem" data-pick="file-char">${icon('user')}<span>Character<span class="menu-hint">Import a character file</span></span></button>`,
    (btn) => document.getElementById(btn.dataset.pick).click());

  // Keep the Make-a-video links in sync with the autosave preference.
  addEventListener('storage', () => { document.querySelectorAll('[data-make]').forEach((a) => (a.href = makeVideoHref())); document.querySelectorAll('[data-classic]').forEach((a) => (a.href = classicHref())); });
}

/** Accessible popover menu: toggle button + panel, outside click / Escape / arrow keys. */
export function popoverMenu(root, panelHtml, onPick) {
  const btn = root.querySelector('button');
  let panel;
  const close = (focus) => {
    if (!panel) return;
    panel.remove(); panel = null; btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', onKey);
    if (focus) btn.focus();
  };
  const outside = (e) => { if (!root.contains(e.target)) close(); };
  const onKey = (e) => {
    if (e.key === 'Escape') return close(true);
    const items = [...panel.querySelectorAll('[role=menuitem]')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    if (e.key === 'Tab') close();
  };
  btn.addEventListener('click', () => {
    if (panel) return close();
    root.insertAdjacentHTML('beforeend', `<div class="menu-panel" id="upload-panel" role="menu">${panelHtml}</div>`);
    panel = root.lastElementChild; btn.setAttribute('aria-expanded', 'true');
    panel.addEventListener('click', (e) => { const it = e.target.closest('[role=menuitem]'); if (it) { close(); onPick(it); } });
    document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', onKey);
    panel.querySelector('[role=menuitem]').focus();
  });
}

export function toast(message, { kind = 'info', ms = 3200 } = {}) {
  const host = document.getElementById('toasts'); if (!host) return;
  const el = document.createElement('div'); el.className = 'toast'; el.dataset.kind = kind; el.textContent = message;
  host.appendChild(el); setTimeout(() => el.remove(), ms);
}

/** Promise-based confirm using <dialog>. */
export function confirmDialog({ title, body, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.setAttribute('aria-labelledby', 'dlg-title');
    d.innerHTML = `<form method="dialog"><h2 id="dlg-title">${esc(title)}</h2><p>${esc(body)}</p>
      <div class="dialog-actions"><button class="btn" value="cancel" autofocus>Cancel</button>
      <button class="btn ${danger ? 'btn-danger' : 'btn-brand'}" value="ok">${esc(confirmLabel)}</button></div></form>`;
    d.addEventListener('close', () => { resolve(d.returnValue === 'ok'); d.remove(); });
    document.body.appendChild(d); d.showModal();
  });
}

export { api, getPrefs, setPref };
