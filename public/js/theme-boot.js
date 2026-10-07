// Classic (non-module) script loaded in <head> to set the theme before first paint.
(function () {
  try {
    var t = (JSON.parse(localStorage.getItem('redrawn.prefs.v1') || '{}')).theme;
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  } catch (e) { /* ignore */ }
})();
