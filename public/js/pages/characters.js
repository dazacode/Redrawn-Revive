import { initShell, api, esc } from '../shell.js';
import { icon } from '../icons.js';
import { getPrefs } from '../prefs.js';
import { visibleThemes } from '../themes.js';

initShell({ active: 'characters' });

const themes = visibleThemes(getPrefs().shortThemeList);
const q = encodeURIComponent;

document.getElementById('themes').innerHTML = themes.map((t) => `
  <li class="theme-row">
    <div><h3>${esc(t.name)}</h3><p class="sub">${esc(t.note)}</p></div>
    <div class="chips" role="group" aria-label="Create a ${esc(t.name)} character">
      ${t.bodies.map(([bs, label]) => `<a class="chip" href="/cc?themeId=${q(t.id)}&bs=${q(bs)}">${esc(label)}</a>`).join('')}
    </div>
    <a class="btn btn-sm" href="/cc_browser?themeId=${q(t.id)}" aria-label="Browse ${esc(t.name)} characters">${icon('search')}Browse</a>
  </li>`).join('');

// Saved characters (optional: hidden if the backend can't list them).
const mine = document.getElementById('mine');
api.characters().then((chars) => {
  if (!chars.length) return;
  mine.hidden = false;
  document.getElementById('mine-grid').innerHTML = chars.map((c) => `
    <li><a class="char" href="/cc?themeId=${q(c.theme)}&id=${q(c.id)}" aria-label="Edit ${esc(c.name)}">
      <span class="thumb"><img src="${api.characterThumb(c.id)}" alt="" loading="lazy"><span class="ph">${icon('user')}</span></span>
      <span>${esc(c.name)}</span></a></li>`).join('');
  document.getElementById('mine-grid').addEventListener('error', (e) => { if (e.target.tagName === 'IMG') e.target.closest('.thumb')?.classList.add('is-broken'); }, true);
}).catch(() => {});
