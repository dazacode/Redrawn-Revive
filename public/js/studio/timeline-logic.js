/**
 * Pure helpers for the timeline (no DOM, unit-tested in tests/timeline-logic.test.ts).
 */

export const MIN_CLIP_MS = 100;
export const MIN_ZOOM = 10;   // px per second
export const MAX_ZOOM = 600;
export const DEFAULT_ZOOM = 80;
export const FRAME_MS = 1000 / 24;

/** @typedef {{id:string,kind:string,assetId:string,start:number,end:number,volume:number,offset?:number,text?:string,voice?:string}} Clip */

export const TRACKS = [
  { id: 'voice', label: 'Voice', kinds: ['voice', 'tts'], addKind: 'voice' },
  { id: 'music', label: 'Music', kinds: ['bgmusic'], addKind: 'bgmusic' },
  { id: 'sfx', label: 'Sound FX', kinds: ['sfx'], addKind: 'sfx' },
];

/** Which track a clip belongs on. Unknown kinds fall back to sound effects. */
export function trackOf(kind) {
  return TRACKS.find((t) => t.kinds.includes(kind))?.id ?? 'sfx';
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function clampZoom(z) {
  return Number.isFinite(z) ? clamp(z, MIN_ZOOM, MAX_ZOOM) : DEFAULT_ZOOM;
}

/** Zoom (px/s) that makes `totalMs` fit in `viewPx`. */
export function fitZoom(totalMs, viewPx) {
  if (!(totalMs > 0) || !(viewPx > 0)) return DEFAULT_ZOOM;
  return clampZoom((viewPx / totalMs) * 1000);
}

/** m:ss.d (or h:mm:ss.d) */
export function fmtTime(ms) {
  const t = Math.max(0, Math.round(ms / 100) / 10);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  const ss = s.toFixed(1).padStart(4, '0');
  if (m >= 60) return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${ss}`;
  return `${m}:${ss}`;
}

/** Short duration label for scene cards: "3s", "3.5s", "1:05". */
export function fmtDur(ms) {
  const s = ms / 1000;
  if (s >= 60) return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
  return `${Number.isInteger(s) ? s : s.toFixed(1)}s`;
}

const STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
/** Pick a ruler major step (seconds) so labels are at least `minPx` apart. */
export function tickStep(pxPerSec, minPx = 72) {
  for (const s of STEPS) if (s * pxPerSec >= minPx) return s;
  return STEPS[STEPS.length - 1];
}

/** Ruler label for second value `sec` at step `step`. */
export function tickLabel(sec, step) {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  if (step < 1) return `${m}:${s.toFixed(1).padStart(4, '0')}`;
  return `${m}:${String(Math.round(s)).padStart(2, '0')}`;
}

/**
 * Greedy lane assignment so overlapping clips stack instead of hiding each other.
 * @param {Clip[]} clips
 * @returns {{lanes: Map<string, number>, count: number}}
 */
export function packLanes(clips) {
  const order = [...clips].sort((a, b) => a.start - b.start || a.end - b.end);
  const ends = [];
  const lanes = new Map();
  for (const c of order) {
    let i = ends.findIndex((e) => e <= c.start);
    if (i < 0) { i = ends.length; ends.push(0); }
    ends[i] = Math.max(c.end, c.start + 1);
    lanes.set(c.id, i);
  }
  return { lanes, count: Math.max(1, ends.length) };
}

/** Snap `ms` to the closest target within `threshold`. Returns {ms, target|null}. */
export function snap(ms, targets, threshold) {
  let best = null, bd = threshold;
  for (const t of targets) {
    const d = Math.abs(t - ms);
    if (d <= bd) { bd = d; best = t; }
  }
  return best === null ? { ms, target: null } : { ms: best, target: best };
}

/**
 * Move a clip by dx ms, snapping either edge. Returns the new {start, end, guide}.
 * @param {{start:number,end:number}} orig
 */
export function moveClip(orig, dx, { total = Infinity, targets = [], threshold = 0 } = {}) {
  const len = orig.end - orig.start;
  let start = orig.start + dx;
  let guide = null;
  if (threshold > 0) {
    const a = snap(start, targets, threshold);
    const b = snap(start + len, targets, threshold);
    const da = a.target === null ? Infinity : Math.abs(a.ms - start);
    const db = b.target === null ? Infinity : Math.abs(b.ms - (start + len));
    if (da <= db && a.target !== null) { start = a.ms; guide = a.target; }
    else if (b.target !== null) { start = b.ms - len; guide = b.target; }
  }
  const maxStart = Math.max(0, total - len);
  start = Math.round(clamp(start, 0, maxStart));
  return { start, end: start + len, guide };
}

/**
 * Trim the left edge (moves start, advances the source offset). `srcOffset` is ms into the source at orig.start.
 * Returns {start, offset, guide}.
 */
export function trimLeft(orig, srcOffset, dx, { targets = [], threshold = 0 } = {}) {
  let start = orig.start + dx;
  let guide = null;
  if (threshold > 0) { const s = snap(start, targets, threshold); if (s.target !== null) { start = s.ms; guide = s.target; } }
  const lo = Math.max(0, orig.start - srcOffset);
  start = Math.round(clamp(start, lo, orig.end - MIN_CLIP_MS));
  return { start, offset: Math.max(0, Math.round(srcOffset + (start - orig.start))), guide };
}

/**
 * Trim the right edge. `maxLen` (ms) limits clip length (source remainder) when known.
 * Returns {end, guide}.
 */
export function trimRight(orig, dx, { targets = [], threshold = 0, maxLen = Infinity } = {}) {
  let end = orig.end + dx;
  let guide = null;
  if (threshold > 0) { const s = snap(end, targets, threshold); if (s.target !== null) { end = s.ms; guide = s.target; } }
  end = Math.round(clamp(end, orig.start + MIN_CLIP_MS, orig.start + maxLen));
  return { end, guide };
}

/** Split a clip at absolute `at`. Returns [left, rightPatch] or null if `at` is not strictly inside. */
export function splitClip(clip, at) {
  if (!(at > clip.start + MIN_CLIP_MS && at < clip.end - MIN_CLIP_MS)) return null;
  const off = clip.offset ?? 0;
  return [
    { end: Math.round(at) },
    { start: Math.round(at), end: clip.end, offset: Math.round(off + (at - clip.start)) },
  ];
}

/** Snap targets: scene boundaries, other clip edges, playhead, 0. */
export function snapTargets(sceneBounds, clips, excludeId, playhead) {
  const set = new Set([0, Math.round(playhead)]);
  for (const b of sceneBounds) { set.add(b.start); set.add(b.end); }
  for (const c of clips) if (c.id !== excludeId) { set.add(c.start); set.add(c.end); }
  return [...set];
}

/** Scene index a dragged card (center at `cx` ms) should be inserted at, given drag source index. */
export function reorderIndex(sceneBounds, fromIndex, cx) {
  // position among the *other* scenes by their midpoints
  let idx = 0;
  for (let i = 0; i < sceneBounds.length; i++) {
    if (i === fromIndex) continue;
    const mid = (sceneBounds[i].start + sceneBounds[i].end) / 2;
    if (cx > mid) idx++;
  }
  return idx;
}

/** x (ms), in the current (undragged) layout, where a reorder to `toIndex` will land. */
export function dropMarkerMs(sceneBounds, fromIndex, toIndex) {
  const others = sceneBounds.filter((_, i) => i !== fromIndex);
  if (!others.length) return 0;
  return toIndex < others.length ? others[toIndex].start : others[others.length - 1].end;
}

/** Friendly name from a dotted/legacy asset id: "common.rockMain.swf" -> "rockMain". */
export function prettyAssetName(assetId) {
  if (!assetId) return 'Untitled';
  let s = String(assetId).replace(/\.(swf|mp3|wav|ogg|m4a|xml)$/i, '');
  const parts = s.split('.');
  s = parts[parts.length - 1] || s;
  if (/^\d{8,}/.test(s)) return 'Uploaded audio';
  return s.replace(/[_-]+/g, ' ').trim() || 'Untitled';
}

/** Clip label: tts text, else resolved friendly name, else prettified id. */
export function clipLabel(clip, nameOf) {
  if (clip.text) return clip.text;
  return (nameOf && nameOf(clip.assetId)) || prettyAssetName(clip.assetId);
}

// ------------------------------------------------------------------ server shapes (src/routes/legacy.ts)

/**
 * Parse the getTextToSpeechVoices XML:
 *   <voices><language id desc><voice id desc sex demo-url country plus/></language></voices>
 * @returns {{id:string, desc:string, voices:{id:string, desc:string, sex:string, country:string}[]}[]}
 */
export function parseVoicesXml(xml) {
  const out = [];
  const langRe = /<language\b([^>]*)>([\s\S]*?)<\/language>/g;
  const attr = (s, n) => {
    const m = new RegExp(`\\b${n}="([^"]*)"`).exec(s);
    return m ? unescapeXml(m[1]) : '';
  };
  let m;
  while ((m = langRe.exec(xml))) {
    const voices = [];
    const vRe = /<voice\b([^>]*?)\/?>/g;
    let v;
    while ((v = vRe.exec(m[2]))) {
      voices.push({ id: attr(v[1], 'id'), desc: attr(v[1], 'desc'), sex: attr(v[1], 'sex'), country: attr(v[1], 'country') });
    }
    if (voices.length) out.push({ id: attr(m[1], 'id'), desc: attr(m[1], 'desc') || attr(m[1], 'id'), voices });
  }
  return out;
}

/**
 * Parse convertTextToSoundAsset: "0<response><asset><id>..</id>..<duration>ms</duration>..</asset></response>"
 * or "1<error>..." on failure. Returns {ok:true,id,duration,title} | {ok:false,error}.
 */
export function parseConvertResponse(body) {
  const t = String(body ?? '').trim();
  if (!t.startsWith('0')) {
    const msg = /<message>([\s\S]*?)<\/message>/.exec(t)?.[1];
    return { ok: false, error: msg ? unescapeXml(msg) : 'The voice could not be generated. Try another voice or shorter text.' };
  }
  const id = /<id>([^<]+)<\/id>/.exec(t)?.[1];
  const dur = Number(/<duration>(\d+)<\/duration>/.exec(t)?.[1] ?? 0);
  const title = /<title>([\s\S]*?)<\/title>/.exec(t)?.[1] ?? '';
  if (!id) return { ok: false, error: 'The server returned no audio.' };
  return { ok: true, id: unescapeXml(id), duration: dur, title: unescapeXml(title) };
}

export function unescapeXml(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&amp;/g, '&');
}

/** Asset id used by clips for audio the server stored for this movie (matches audio.js resolveUrl). */
export const ugcAssetId = (serverId) => `ugc.${serverId}`;
