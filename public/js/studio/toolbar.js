// Studio top toolbar: home menu, title, undo/redo, save status, panel toggles, preview, export, save.
import { icon } from '../icons.js';
import { esc } from '../shell.js';

const MAC = /Mac|iPhone|iPad/.test(navigator.platform || '');
export const MOD = MAC ? '⌘' : 'Ctrl';

/**
 * @param {HTMLElement} el
 * @param {{store: any, actions: Record<string, Function>, panels: () => Record<string, boolean>, classicHref: string}} o
 * @returns {{setStatus(state: 'saved'|'dirty'|'saving'|'error'|'new', text: string): void, setPanels(): void, destroy(): void}}
 */
export function mountToolbar(el, { store, actions, panels, classicHref }) {
  const tb = (id, ic, label, extra = '') =>
    `<button type="button" class="btn btn-ghost btn-sm btn-icon st-tb-btn" data-act="${id}" aria-label="${esc(label)}" title="${esc(label)}" ${extra}>${icon(ic)}</button>`;

  el.innerHTML = `
    <div class="menu" data-menu="home">
      <button type="button" class="st-home" aria-haspopup="menu" aria-expanded="false" aria-label="Studio menu"><img src="/img/logo.png" alt="Redrawn" width="90" height="32">${icon('chevron')}</button>
    </div>
    <span class="st-sep st-hide-sm"></span>
    <input class="st-title" type="text" aria-label="Video title" placeholder="Untitled video" maxlength="120" spellcheck="false" autocomplete="off">
    <span class="st-status" role="status" data-state="new"></span>
    <span class="st-spacer"></span>
    <div class="st-group">
      ${tb('undo', 'undo', `Undo (${MOD}+Z)`, 'disabled')}
      ${tb('redo', 'redo', `Redo (${MOD}+Shift+Z)`, 'disabled')}
    </div>
    <span class="st-sep st-hide-sm"></span>
    <div class="st-group st-hide-sm" aria-label="Panels">
      ${tb('toggle:left', 'panelLeft', 'Toggle assets panel', 'aria-pressed="true"')}
      ${tb('toggle:bottom', 'panelBottom', 'Toggle timeline', 'aria-pressed="true"')}
      ${tb('toggle:right', 'panelRight', 'Toggle inspector', 'aria-pressed="true"')}
    </div>
    <span class="st-sep"></span>
    <button type="button" class="btn btn-sm" data-act="preview" aria-label="Preview" title="Preview full screen (P)">${icon('play')}<span class="st-hide-sm">Preview</span></button>
    <div class="menu" data-menu="export">
      <button type="button" class="btn btn-sm" aria-label="Export" aria-haspopup="menu" aria-expanded="false">${icon('download')}<span class="st-hide-sm">Export</span>${icon('chevron')}</button>
    </div>
    <button type="button" class="btn btn-sm btn-brand" data-act="save" aria-label="Save" title="Save (${MOD}+S)">${icon('save')}<span class="st-save-label">Save</span></button>`;

  const q = (s) => el.querySelector(s);
  const title = q('.st-title');
  const status = q('.st-status');
  const cleanups = [];

  // Title: commit on input (coalesced into one undo step per edit session), reset on Escape.
  title.addEventListener('input', () => store.dispatch({ type: 'setTitle', title: title.value, coalesce: 'title' }));
  title.addEventListener('keydown', (e) => { if (e.key === 'Enter') title.blur(); });
  title.addEventListener('blur', () => { if (!title.value.trim()) store.dispatch({ type: 'setTitle', title: 'Untitled' }); });

  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    const act = b.dataset.act;
    if (act.startsWith('toggle:')) { actions.togglePanel(act.slice(7)); render(); } else actions[act]?.();
  });

  const menu = (sel, items, side) => popover(q(sel), items, side);
  menu('[data-menu=home]', () => `
    <a role="menuitem" href="/">${icon('film')}<span>All videos</span></a>
    <a role="menuitem" href="/characters.html">${icon('users')}<span>Characters</span></a>
    <a role="menuitem" href="/settings.html">${icon('sliders')}<span>Settings</span></a>
    <hr>
    <button type="button" role="menuitem" data-pick="new">${icon('plus')}<span>New video</span></button>
    <a role="menuitem" href="${esc(classicHref)}">${icon('external')}<span>Classic editor<span class="menu-hint">The original Flash editor</span></span></a>
    <hr>
    <button type="button" role="menuitem" data-pick="theme">${icon('moon')}<span>Toggle light / dark</span></button>
    <button type="button" role="menuitem" data-pick="shortcuts">${icon('keyboard')}<span>Keyboard shortcuts</span><span class="st-kbd">?</span></button>`, 'left', (k) => actions[k]?.());
  menu('[data-menu=export]', () => `
    <button type="button" role="menuitem" data-pick="exportXml">${icon('code')}<span>Movie file (.xml)<span class="menu-hint">Re-importable on the home page</span></span></button>
    <button type="button" role="menuitem" data-pick="exportZip">${icon('download')}<span>Package (.zip)<span class="menu-hint">Saves first, includes assets</span></span></button>
    <button type="button" role="menuitem" data-pick="exportPng">${icon('image')}<span>Thumbnail (.png)</span></button>`, 'right', (k) => actions[k]?.());

  function render() {
    const s = store.get();
    if (document.activeElement !== title && title.value !== s.movie.title) title.value = s.movie.title === 'Untitled' ? '' : s.movie.title;
    q('[data-act=undo]').disabled = !store.canUndo();
    q('[data-act=redo]').disabled = !store.canRedo();
    const p = panels();
    for (const k of ['left', 'bottom', 'right']) q(`[data-act="toggle:${k}"]`)?.setAttribute('aria-pressed', String(!!p[k]));
  }
  cleanups.push(store.subscribe(render));
  render();

  return {
    setStatus(state, text) { status.dataset.state = state; status.textContent = text; },
    setPanels: render,
    destroy() { cleanups.forEach((f) => f()); el.replaceChildren(); },
  };
}

/** Menu button + panel (re-using the site's .menu look). `items` is a function so labels can change. */
function popover(root, items, side, onPick) {
  const btn = root.querySelector('button');
  let panel = null;
  const close = (focus) => {
    if (!panel) return;
    panel.remove(); panel = null; btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', onKey);
    if (focus) btn.focus();
  };
  const outside = (e) => { if (!root.contains(e.target)) close(); };
  const onKey = (e) => {
    if (e.key === 'Escape') return close(true);
    const list = [...panel.querySelectorAll('[role=menuitem]')];
    const i = list.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length].focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length].focus(); }
    if (e.key === 'Tab') close();
  };
  btn.addEventListener('click', () => {
    if (panel) return close();
    root.insertAdjacentHTML('beforeend', `<div class="menu-panel ${side === 'left' ? 'left' : ''}" role="menu">${items()}</div>`);
    panel = root.lastElementChild; btn.setAttribute('aria-expanded', 'true');
    panel.addEventListener('click', (e) => {
      const it = e.target.closest('[role=menuitem]'); if (!it) return;
      close();
      if (it.dataset.pick) onPick(it.dataset.pick);
    });
    document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', onKey);
    panel.querySelector('[role=menuitem]').focus();
  });
}
