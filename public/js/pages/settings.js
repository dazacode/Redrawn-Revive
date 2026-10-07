import { initShell, toast } from '../shell.js';
import { getPrefs, setPref, resetPrefs } from '../prefs.js';

initShell({ active: 'settings' });

const form = document.getElementById('settings');
function paint(p) {
  form.elements.theme.value = p.theme;
  form.elements.shortThemeList.checked = p.shortThemeList;
  form.elements.autosave.checked = p.autosave;
  form.elements.quality.value = p.quality;
}
paint(getPrefs());

form.addEventListener('change', (e) => {
  const el = e.target, name = el.name;
  setPref(name, el.type === 'checkbox' ? el.checked : el.value);
  toast('Saved', { ms: 1400 });
});
form.addEventListener('submit', (e) => e.preventDefault());
document.getElementById('reset').addEventListener('click', () => { paint(resetPrefs()); toast('Settings reset'); });
