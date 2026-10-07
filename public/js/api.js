// All backend calls live here. Endpoints are the legacy routes plus two small
// JSON additions the frontend needs (marked NEW) so the Bun server can reconcile.
//
//   GET  /ajax/config                  NEW  -> { SWF_URL, STORE_URL, CLIENT_URL }   (wrapper env.json values)
//   GET  /ajax/movie/list                   -> [{ id, title, date, duration, durationString }]
//   GET  /ajax/movie/presave?noAutosave=1 NEW -> { movieId }   (page.js go_full: fillNextFileId + sessions.set)
//   GET  /deleteMovie/:id                   -> 2xx on success
//   GET  /movie_thumbs/:id.png              (image)  note: legacy used `${id}.png`
//   GET  /movies/:id.xml                    (download)
//   GET  /goapi/getUserAssetsXml/?type=char[&themeId=] -> <ugc><char id name cc_theme_id thumbnail_url/>...</ugc>
//   GET  /characters/:id.png                (thumbnail, optional; UI falls back to a placeholder)
//   POST /upload_movie, /upload_character   multipart field `import`; 302 -> editor (native form post)

export class ApiError extends Error {
  constructor(message, status) { super(message); this.name = 'ApiError'; this.status = status; }
}

const isMock = () => new URLSearchParams(location.search).has('mock') || sessionStorage.getItem('redrawn.mock') === '1';
let mockReady;
/** Installs the dev mock (fetch override) when ?mock is present. Call once per page before any API call. */
export function initApi() {
  mockReady ??= isMock()
    ? (sessionStorage.setItem('redrawn.mock', '1'), import('./dev/mock.js').then((m) => m.installMock()))
    : Promise.resolve();
  return mockReady;
}

async function request(url, init) {
  await initApi();
  let res;
  try { res = await fetch(url, init); } catch (e) { throw new ApiError('Could not reach the Redrawn server.', 0); }
  if (!res.ok) throw new ApiError(`Server responded ${res.status}`, res.status);
  return res;
}

// Legacy meta() HTML-escapes titles; accept either raw or escaped text and render via textContent.
const decode = (s) => String(s ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

let cfgPromise;
export const api = {
  config() { return (cfgPromise ??= request('/ajax/config').then((r) => r.json()).catch((e) => { cfgPromise = null; throw e; })); },

  async movies() {
    const list = await (await request('/ajax/movie/list')).json();
    return (Array.isArray(list) ? list : []).filter(Boolean).map((m) => ({
      id: m.id, title: decode(m.title) || 'Untitled video', date: m.date ? new Date(m.date) : null,
      duration: Number(m.duration) || 0, durationString: m.durationString || '',
    }));
  },
  async deleteMovie(id) { await request(`/deleteMovie/${encodeURIComponent(id)}`); },
  async presaveMovie(noAutosave) {
    const r = await request(`/ajax/movie/presave${noAutosave ? '?noAutosave=1' : ''}`);
    return (await r.json()).movieId;
  },
  movieThumb: (id) => (window.__REDRAWN_MOCK ? window.__REDRAWN_MOCK.thumb(id) : `/movie_thumbs/${encodeURIComponent(id)}.png`),
  movieDownload: (id) => `/movies/${encodeURIComponent(id)}.xml`,

  async characters(themeId) {
    const q = new URLSearchParams({ type: 'char' });
    if (themeId) q.set('themeId', themeId);
    const text = await (await request(`/goapi/getUserAssetsXml/?${q}`)).text();
    const doc = new DOMParser().parseFromString(text, 'text/xml');
    return [...doc.querySelectorAll('char')].map((c) => ({
      id: c.getAttribute('id'), name: c.getAttribute('name') || 'Untitled', theme: c.getAttribute('cc_theme_id') || 'family',
    }));
  },
  characterThumb: (id) => (window.__REDRAWN_MOCK ? window.__REDRAWN_MOCK.charThumb(id) : `/characters/${encodeURIComponent(id)}.png`),
};
