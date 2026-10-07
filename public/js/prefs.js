// User preferences (browser-only). localStorage is the source of truth; the two
// legacy cookies (darkmode, shortthemelist) are mirrored for backend/legacy compatibility.
const KEY = 'redrawn.prefs.v1';
export const DEFAULTS = {
  theme: 'system',       // 'system' | 'light' | 'dark'
  shortThemeList: false, // hide extra character themes (legacy "shortthemelist")
  autosave: true,        // false => go_full gets noAutosave=1 (legacy query flag)
  quality: 'medium',      // Ruffle render quality: 'high' | 'medium' | 'low'
};

export function getPrefs() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { ...DEFAULTS }; }
}

export function setPref(name, value) {
  const next = { ...getPrefs(), [name]: value };
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* storage blocked */ }
  syncSideEffects(next);
  return next;
}

export function resetPrefs() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  syncSideEffects({ ...DEFAULTS });
  return { ...DEFAULTS };
}

function cookie(name, on) {
  document.cookie = on ? `${name}=1; path=/; max-age=31536000; samesite=lax` : `${name}=; path=/; max-age=0; samesite=lax`;
}

export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme; else delete root.dataset.theme;
}

function syncSideEffects(p) {
  applyTheme(p.theme);
  cookie('darkmode', p.theme === 'dark');
  cookie('shortthemelist', p.shortThemeList);
}
