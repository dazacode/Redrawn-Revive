// DEV ONLY. Loaded by api.js when the page URL has ?mock (sticks for the tab session).
// Fakes the JSON endpoints and generates SVG thumbnails so the UI can be built and
// screenshotted without the backend. Not referenced by any production code path.
const TITLES = ['Untitled Video', 'Grounded for a Week', 'The Big Move', 'Space Citizens: Episode 1', 'My first video & more <3',
  'A very long title that keeps going to check how the grid copes with wrapping text on narrow screens', 'Chibi Ninja Training Day', 'Test',
  'Anime Opening Draft', 'Office Meeting', 'Birthday Surprise', 'Rocky vs Bob', 'Lil Peepz Intro', 'Final Cut v2'];

const movies = TITLES.map((title, i) => ({
  id: `m-${TITLES.length - i}`, title: title.replace(/&/g, '&amp;').replace(/</g, '&lt;'), // legacy escapes
  date: new Date(Date.now() - i * 86400000 * 3.7).toISOString(), duration: 20 + i * 17, durationString: `00:${String(20 + i * 17 % 40).padStart(2, '0')}`,
}));
const chars = ['family', 'anime', 'chibi', 'family', 'spacecitizen', 'ninjaanime'].map((t, i) => `<char id="c-${i}" name="Character ${i + 1}" cc_theme_id="${t}" thumbnail_url="char_default.png" copyable="Y"><tags/></char>`);

const hue = (id) => (String(id).split('').reduce((a, c) => a + c.charCodeAt(0) * 31, 0) * 37) % 360;
const svg = (body) => 'data:image/svg+xml;utf8,' + encodeURIComponent(body);

export function installMock() {
  window.__REDRAWN_MOCK = {
    thumb: (id) => svg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><rect width="320" height="180" fill="hsl(${hue(id)} 45% 78%)"/><circle cx="${60 + hue(id) % 200}" cy="120" r="46" fill="hsl(${(hue(id) + 40) % 360} 55% 55%)"/><rect y="140" width="320" height="40" fill="hsl(${hue(id)} 30% 40%)"/></svg>`),
    charThumb: (id) => svg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="32" r="18" fill="hsl(${hue(id)} 60% 60%)"/><rect x="28" y="54" width="44" height="40" rx="14" fill="hsl(${hue(id)} 50% 45%)"/></svg>`),
  };
  const real = window.fetch.bind(window);
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
  const delay = (v) => new Promise((r) => setTimeout(() => r(v), 350));
  window.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const p = url.pathname;
    if (p === '/ajax/config') return delay(json({ SWF_URL: '/animation/mock', STORE_URL: '/store/mock', CLIENT_URL: '/static/mock' }));
    if (p === '/ajax/movie/list') return delay(url.searchParams.has('empty') || sessionStorage.getItem('redrawn.mock.empty') ? json([]) : json(movies));
    if (p === '/ajax/movie/presave') return delay(json({ movieId: 'm-99' }));
    if (p.startsWith('/deleteMovie/')) { const i = movies.findIndex((m) => m.id === decodeURIComponent(p.slice(13))); if (i >= 0) movies.splice(i, 1); return delay(new Response('ok')); }
    if (p === '/goapi/getUserAssetsXml/') return delay(new Response(`<ugc more="0">${chars.join('')}</ugc>`));
    return real(input, init);
  };
}
