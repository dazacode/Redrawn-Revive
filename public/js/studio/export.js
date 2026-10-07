// Studio persistence + export helpers: save to the backend, download XML / zip / thumbnail.
import { serializeMovie } from './movie-xml.js';
import { STAGE_W, STAGE_H } from './model.js';

export class SaveError extends Error {}

/** Trigger a browser download of a Blob. */
export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const safeName = (title) => (String(title || 'video').trim().replace(/[^\w\- ]+/g, '').replace(/\s+/g, '-').slice(0, 60) || 'video');

/** Download the movie as legacy-compatible XML (works for unsaved movies, no server involved). */
export function exportXml(movie) {
  download(new Blob([serializeMovie(movie)], { type: 'text/xml' }), `${safeName(movie.title)}.xml`);
}

/**
 * Save through the JSON endpoint (POST /api/movies/save). The server wraps the XML exactly like the
 * Flash editor's save, so /player and /go_full open the result.
 * @returns {Promise<string>} the saved movie id (m-N)
 */
export async function saveMovie(movie, { movieId, presaveId, thumbnail }) {
  let res;
  try {
    res = await fetch('/api/movies/save', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ xml: serializeMovie(movie), movieId: movieId || undefined, presaveId: presaveId || undefined, thumbnail: thumbnail || undefined }),
    });
  } catch { throw new SaveError('Could not reach the Redrawn server.'); }
  let data = null;
  try { data = await res.json(); } catch { /* not json */ }
  if (!res.ok || !data?.movieId) throw new SaveError(data?.error || `Save failed (server responded ${res.status}).`);
  return data.movieId;
}

function loadImage(src) {
  return new Promise((resolve) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => resolve(null); i.src = src; });
}

/**
 * Render a PNG thumbnail (base64, no prefix). Prefers a stage snapshot if the stage offers one,
 * otherwise composes the background thumbnail + title on a canvas.
 * @returns {Promise<{base64: string, blob: Blob}>}
 */
export async function makeThumbnail(movie, { stage, getThumb } = {}) {
  const W = 352, H = Math.round((W * STAGE_H) / STAGE_W);
  const cv = Object.assign(document.createElement('canvas'), { width: W, height: H });
  const ctx = cv.getContext('2d');
  const css = getComputedStyle(document.documentElement);
  ctx.fillStyle = '#1b2433'; ctx.fillRect(0, 0, W, H);
  let drawn = false;
  try {
    const snap = await stage?.snapshot?.(W);
    const src = snap instanceof Blob ? URL.createObjectURL(snap) : typeof snap === 'string' ? snap : null;
    const img = src && await loadImage(src);
    if (img) { ctx.drawImage(img, 0, 0, W, H); drawn = true; }
  } catch { /* fall through */ }
  if (!drawn) {
    const bg = movie.scenes[0]?.bg;
    try {
      const url = bg && getThumb ? await getThumb(bg.assetId, 'bg') : null;
      const img = url && await loadImage(url);
      if (img) { ctx.drawImage(img, 0, 0, W, H); drawn = true; }
    } catch { /* ignore */ }
  }
  if (!drawn) {
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#24406b'); g.addColorStop(1, '#0f1b2e');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(255,255,255,.92)'; ctx.font = `600 ${Math.round(H / 8)}px ${css.getPropertyValue('--font') || 'sans-serif'}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText((movie.title || 'Untitled').slice(0, 28), W / 2, H / 2);
  }
  const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
  const base64 = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(String(fr.result).split(',')[1]); fr.readAsDataURL(blob); });
  return { base64, blob };
}
