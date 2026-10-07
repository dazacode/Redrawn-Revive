/**
 * Id helpers for Studio. Pure; no DOM. Two id spaces exist:
 *  - model ids (Elem/Scene/Bubble/Sound ids): short unique strings made by `newId`.
 *  - asset ids (dotted legacy ids, e.g. "common.Diner_bg.swf", "ugc.c-12.xml"): parsed by `parseAssetId`.
 */

let counter = 0;

/** Unique id with a type prefix: sc (scene), e (elem), b (bubble), s (sound). */
export function newId(prefix = 'x') {
  counter = (counter + 1) % 0x7fffffff;
  const rnd = Math.floor(Math.random() * 0x1000000).toString(36);
  return `${prefix}-${Date.now().toString(36)}${counter.toString(36)}${rnd}`;
}

/** Test hook: make ids deterministic (`newId` returns prefix-1, prefix-2, ...). Pass null to restore. */
let det = null;
export function seedIds(n) {
  det = n == null ? null : { n };
}
export function nextId(prefix = 'x') {
  if (det) return `${prefix}-${++det.n}`;
  return newId(prefix);
}

/**
 * Split a dotted legacy asset id. Theme ids never contain dots; the file name may ("a.b.swf").
 * "common.Diner_bg.swf"        -> { theme: 'common', parts: ['Diner_bg.swf'], file: 'Diner_bg.swf', ext: 'swf', ugc: false }
 * "common.matchBoyNew.stand.swf" -> parts ['matchBoyNew','stand.swf']  (char model + action)
 * "ugc.c-12.xml"               -> ugc: true
 * @param {string} assetId
 */
export function parseAssetId(assetId) {
  const s = String(assetId ?? '');
  const dot = s.indexOf('.');
  if (dot < 0) return { theme: '', parts: [s], file: s, ext: '', ugc: false, raw: s };
  const theme = s.slice(0, dot);
  const rest = s.slice(dot + 1);
  const segs = rest.split('.');
  const ext = segs.length > 1 ? segs[segs.length - 1] : '';
  const parts = [];
  // Re-join "name.ext" pairs: a char action is "<charId>.<action>.<ext>", everything else is "<file>.<ext>".
  if (segs.length >= 3) parts.push(segs[0], segs.slice(1).join('.'));
  else parts.push(rest);
  return { theme, parts, file: rest, ext, ugc: theme === 'ugc', raw: s };
}

/** Join theme + file back into a dotted asset id. */
export function makeAssetId(theme, ...parts) {
  return [theme, ...parts].join('.');
}

/** Theme part of an asset id ("common.x.swf" -> "common"); '' when none. */
export function themeOf(assetId) {
  const s = String(assetId ?? '');
  const i = s.indexOf('.');
  return i < 0 ? '' : s.slice(0, i);
}

/** Asset id of a stock sound ("common.roadSide.swf") or uploaded one ("ugc.abc.mp3"). */
export function isUgcAsset(assetId) {
  return themeOf(assetId) === 'ugc';
}
