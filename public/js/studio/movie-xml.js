/**
 * Legacy movie XML <-> Studio model. See FORMAT.md for everything known about the format.
 *
 *   parseMovieXml(xml: string): Movie
 *   serializeMovie(movie: Movie): string
 *
 * Round-trip strategy: every element the model understands keeps the original XML node in `meta.node`
 * (a plain-JSON tree) and serialization patches that node, so unknown children/attributes survive. Anything
 * the model does not understand at all (film-level <asset>, <cc_char>, <thumb>, unknown scene children...)
 * is kept as an XML string in `meta.raw` and re-emitted in its original position (`meta.layout`).
 *
 * Also exports a small tolerant XML tree parser (`parseXmlTree`) that works in browsers and Bun (no DOMParser
 * needed); themes.js reuses it.
 */
import {
  FPS, LEGACY_K, MIN_SCENE_MS, STAGE_H, STAGE_W, createMovie, createScene, movieDuration,
} from './model.js';
import { nextId } from './ids.js';

/** @typedef {import('./model.js').Movie} Movie */
/** @typedef {import('./model.js').Scene} Scene */
/** @typedef {import('./model.js').Elem} Elem */

// ---------------------------------------------------------------------------------------------
// XML tree
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {{n: string, a: [string,string][], c: (XNode|string|{cdata:string})[]}} XNode
 * Element: n = tag name, a = ordered attributes, c = children (elements, text strings, {cdata}).
 */

const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeEntities(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(cp); } catch { return m; }
    }
    return ENTITY[e] ?? m;
  });
}

export function escapeText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
export function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/\r?\n/g, '&#10;');
}

const ATTR_RE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/**
 * Parse an XML document into an element tree (root element returned). Tolerant: ignores the XML declaration,
 * DOCTYPE, comments and processing instructions; auto-closes unclosed tags; drops whitespace-only text that
 * sits between child elements. Throws only when there is no root element.
 * @param {string} xml
 * @returns {XNode}
 */
export function parseXmlTree(xml) {
  const s = xml.charCodeAt(0) === 0xfeff ? xml.slice(1) : xml;
  const len = s.length;
  /** @type {XNode} */
  const doc = { n: '#doc', a: [], c: [] };
  const stack = [doc];
  let i = 0;
  const top = () => stack[stack.length - 1];
  const pushText = (t) => {
    if (!t) return;
    const c = top().c;
    const last = c[c.length - 1];
    if (typeof last === 'string') c[c.length - 1] = last + t;
    else c.push(t);
  };
  while (i < len) {
    const lt = s.indexOf('<', i);
    if (lt < 0) { pushText(decodeEntities(s.slice(i))); break; }
    if (lt > i) pushText(decodeEntities(s.slice(i, lt)));
    if (s.startsWith('<!--', lt)) {
      const e = s.indexOf('-->', lt + 4);
      i = e < 0 ? len : e + 3;
    } else if (s.startsWith('<![CDATA[', lt)) {
      const e = s.indexOf(']]>', lt + 9);
      const body = s.slice(lt + 9, e < 0 ? len : e);
      top().c.push({ cdata: body });
      i = e < 0 ? len : e + 3;
    } else if (s.startsWith('<?', lt)) {
      const e = s.indexOf('?>', lt + 2);
      i = e < 0 ? len : e + 2;
    } else if (s.startsWith('<!', lt)) {
      // DOCTYPE (may contain [...] subset)
      let depth = 0; let j = lt + 2;
      for (; j < len; j++) {
        const ch = s[j];
        if (ch === '[') depth++;
        else if (ch === ']') depth--;
        else if (ch === '>' && depth <= 0) break;
      }
      i = j + 1;
    } else if (s[lt + 1] === '/') {
      const e = s.indexOf('>', lt + 2);
      const name = s.slice(lt + 2, e < 0 ? len : e).trim();
      i = e < 0 ? len : e + 1;
      let k = stack.length - 1;
      while (k > 0 && stack[k].n !== name) k--;
      if (k > 0) stack.length = k; // pop to the matching element (tolerates stray/unclosed tags)
    } else {
      // start tag: find the closing '>' outside quotes
      let j = lt + 1; let q = '';
      for (; j < len; j++) {
        const ch = s[j];
        if (q) { if (ch === q) q = ''; } else if (ch === '"' || ch === "'") q = ch;
        else if (ch === '>') break;
      }
      let inner = s.slice(lt + 1, j);
      const selfClose = inner.endsWith('/');
      if (selfClose) inner = inner.slice(0, -1);
      const ws = inner.search(/[\s]/);
      const name = ws < 0 ? inner : inner.slice(0, ws);
      /** @type {XNode} */
      const node = { n: name, a: [], c: [] };
      if (ws >= 0) {
        ATTR_RE.lastIndex = 0;
        const rest = inner.slice(ws);
        let m;
        while ((m = ATTR_RE.exec(rest))) node.a.push([m[1], decodeEntities(m[2] ?? m[3] ?? '')]);
      }
      top().c.push(node);
      if (!selfClose) stack.push(node);
      i = j + 1;
    }
  }
  // drop whitespace-only text next to sibling elements (formatting), keep it in text-only leaves
  const clean = (n) => {
    if (n.c.some((x) => typeof x === 'object' && x.n)) {
      n.c = n.c.filter((x) => typeof x !== 'string' || x.trim() !== '');
    }
    for (const x of n.c) if (typeof x === 'object' && x.n) clean(x);
  };
  clean(doc);
  const root = doc.c.find((x) => typeof x === 'object' && x.n);
  if (!root) throw new Error('no root element');
  return /** @type {XNode} */ (root);
}

/** Serialize a node tree (no pretty-printing; the exact text content is preserved). */
export function nodeToXml(node) {
  if (typeof node === 'string') return escapeText(node);
  if (node.cdata !== undefined) return `<![CDATA[${String(node.cdata).replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
  let out = `<${node.n}`;
  for (const [k, v] of node.a) out += ` ${k}="${escapeAttr(v)}"`;
  if (!node.c.length) return `${out}/>`;
  out += '>';
  for (const c of node.c) out += nodeToXml(c);
  return `${out}</${node.n}>`;
}

const isEl = (x) => typeof x === 'object' && x !== null && x.n !== undefined;
/** Child elements (optionally by name). */
export function kids(node, name) {
  return node ? node.c.filter((x) => isEl(x) && (name === undefined || x.n === name)) : [];
}
export function kid(node, name) {
  return node ? node.c.find((x) => isEl(x) && x.n === name) : undefined;
}
/** Concatenated text (incl. CDATA) of a node, trimmed. '' for missing. */
export function textOf(node) {
  if (!node) return '';
  let t = '';
  for (const c of node.c) t += typeof c === 'string' ? c : c.cdata !== undefined ? c.cdata : isEl(c) ? textOf(c) : '';
  return t.trim();
}
export function attrOf(node, name) {
  const p = node?.a.find((x) => x[0] === name);
  return p ? p[1] : undefined;
}
export function setAttr(node, name, value) {
  const p = node.a.find((x) => x[0] === name);
  if (p) p[1] = String(value);
  else node.a.push([name, String(value)]);
}
export function delAttr(node, name) {
  node.a = node.a.filter((x) => x[0] !== name);
}
/** Set the text of child <name>, creating it when absent. Keeps CDATA-ness of an existing text. */
export function setChildText(node, name, value) {
  let k = kid(node, name);
  if (!k) { k = { n: name, a: [], c: [] }; node.c.push(k); }
  const wasCdata = k.c.length === 1 && typeof k.c[0] === 'object' && k.c[0].cdata !== undefined;
  k.c = [wasCdata ? { cdata: String(value) } : String(value)];
  return k;
}
export function delChild(node, name) {
  node.c = node.c.filter((x) => !(isEl(x) && x.n === name));
}

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

const clone = (v) => JSON.parse(JSON.stringify(v));
const num = (s, d) => { const v = parseFloat(s); return Number.isFinite(v) ? v : d; };
const round = (v, p = 3) => { const m = 10 ** p; return Math.round(v * m) / m; };
/** Format a number the way the legacy files do (no trailing zeros). */
const fmt = (v, p = 3) => String(round(v, p));
const near = (a, b, eps = 1e-4) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));
const framesToMs = (f) => (f / FPS) * 1000;
const msToFrames = (ms) => Math.round((ms / 1000) * FPS);

/** Legacy-style id: PREFIX-N. */
const LEGACY_ID = /^[A-Z]+-\d+$/;

// ---------------------------------------------------------------------------------------------
// parse
// ---------------------------------------------------------------------------------------------

const ELEM_TAGS = {
  bg: 'bg', prop: 'prop', char: 'char', effect: 'effect', effectAsset: 'effect',
};

/** Read the transform children shared by bg/prop/char/effect nodes. */
function readTransform(node, isBg) {
  const x = num(textOf(kid(node, 'x')), NaN);
  const y = num(textOf(kid(node, 'y')), NaN);
  const xs = num(textOf(kid(node, 'xscale')), 1);
  const ys = num(textOf(kid(node, 'yscale')), xs);
  const face = num(textOf(kid(node, 'face')), 1);
  const rot = num(textOf(kid(node, 'rotation')), 0);
  return {
    x: Number.isFinite(x) ? x * LEGACY_K : isBg ? 0 : STAGE_W / 2,
    y: Number.isFinite(y) ? y * LEGACY_K : isBg ? 0 : STAGE_H / 2,
    scale: Math.abs(xs) || 1,
    yRatio: xs ? Math.abs(ys / xs) || 1 : 1,
    flip: face < 0 || xs < 0,
    rotation: rot,
  };
}

function uniqueId(base, used) {
  let id = base || nextId('e');
  if (used.has(id)) {
    let n = 2;
    while (used.has(`${id}~${n}`)) n++;
    id = `${id}~${n}`;
  }
  used.add(id);
  return id;
}

/** @returns {Elem} */
function parseElem(node, kind, used, z) {
  const tag = node.n;
  const xmlId = attrOf(node, 'id');
  const t = readTransform(node, kind === 'bg');
  let assetId = textOf(kid(node, 'file'));
  let action;
  if (kind === 'char') {
    assetId = textOf(kid(node, 'action'));
    const segs = assetId.split('.');
    if (segs.length >= 4 && segs[segs.length - 1] === 'swf') action = segs.slice(2).join('.');
  }
  const index = attrOf(node, 'index');
  /** @type {Elem} */
  const e = {
    id: uniqueId(xmlId ? xmlId : nextId('e'), used),
    assetId,
    x: t.x, y: t.y, scale: t.scale, rotation: t.rotation, flip: t.flip,
    z: index !== undefined && Number.isFinite(parseFloat(index)) ? parseFloat(index) : z,
    meta: { node: clone(node), tag, yRatio: t.yRatio, xmlId },
  };
  if (action) e.action = action;
  const rs = attrOf(node, 'rstart'); const re = attrOf(node, 'rstop');
  if (rs !== undefined) e.start = num(rs, 0);
  if (re !== undefined) e.end = num(re, 0);
  return e;
}

function parseBubble(node, used, sceneMs) {
  const bubble = kid(node, 'bubble');
  const textNode = kid(bubble, 'text');
  const type = (attrOf(bubble, 'type') ?? 'ELLIPSE').toLowerCase();
  const bx = num(attrOf(bubble, 'x'), 0); const by = num(attrOf(bubble, 'y'), 0);
  const bw = num(attrOf(bubble, 'w'), 0); const bh = num(attrOf(bubble, 'h'), 0);
  const ax = kid(node, 'x') ? num(textOf(kid(node, 'x')), 0) : bx + bw / 2;
  const ay = kid(node, 'y') ? num(textOf(kid(node, 'y')), 0) : by + bh / 2;
  const xmlId = attrOf(node, 'id');
  const rs = attrOf(node, 'rstart'); const re = attrOf(node, 'rstop');
  return {
    id: uniqueId(xmlId ? xmlId : nextId('b'), used),
    text: textOf(textNode),
    x: ax * LEGACY_K, y: ay * LEGACY_K,
    style: type,
    targetId: attrOf(node, 'rtarget') || undefined,
    start: rs !== undefined ? num(rs, 0) : 0,
    end: re !== undefined ? num(re, sceneMs) : sceneMs,
    meta: { node: clone(node), xmlId },
  };
}

/** Sentinel for scenes without a duration attribute. */
const NO_DUR = -1;

function parseScene(node, index, used, filmMs) {
  const attrs = node.a.map((p) => [...p]);
  const adelay = attrOf(node, 'adelay');
  let duration = adelay !== undefined && num(adelay, NaN) > 0 ? framesToMs(num(adelay, 0)) : NO_DUR;
  const xmlId = attrOf(node, 'id');
  const scene = createScene({
    id: uniqueId(xmlId || nextId('sc'), used), duration, bg: null, chars: [], props: [], bubbles: [], effects: [],
  });
  const layout = [];
  const raw = [];
  const bubbleNodes = [];
  let z = 0;
  for (const c of node.c) {
    if (!isEl(c)) { continue; }
    const kind = ELEM_TAGS[c.n];
    if (kind) {
      const e = parseElem(c, kind, used, z++);
      if (kind === 'bg') { if (!scene.bg) scene.bg = e; else { raw.push(nodeToXml(c)); layout.push({ raw: raw.length - 1 }); continue; } layout.push({ k: 'bg', id: e.id }); }
      else {
        (kind === 'char' ? scene.chars : kind === 'prop' ? scene.props : scene.effects).push(e);
        layout.push({ k: kind, id: e.id });
      }
    } else if (c.n === 'bubbleAsset') {
      bubbleNodes.push(c);
      layout.push({ k: 'bubble', id: `\u0000${bubbleNodes.length - 1}` });
    } else if (c.n === 'camera') {
      const cam = {
        x: num(attrOf(c, 'x') ?? textOf(kid(c, 'x')), STAGE_W / 2),
        y: num(attrOf(c, 'y') ?? textOf(kid(c, 'y')), STAGE_H / 2),
        zoom: num(attrOf(c, 'zoom') ?? textOf(kid(c, 'zoom')), 1),
      };
      scene.camera = cam;
      raw.push(nodeToXml(c));
      layout.push({ k: 'camera', raw: raw.length - 1, orig: { ...cam } });
    } else if (c.n === 'trans') {
      const v = textOf(kid(c, 'file')) || attrOf(c, 'id') || attrOf(c, 'type') || textOf(c);
      scene.transitionOut = v || null;
      raw.push(nodeToXml(c));
      layout.push({ k: 'trans', raw: raw.length - 1, orig: scene.transitionOut });
    } else {
      raw.push(nodeToXml(c));
      layout.push({ raw: raw.length - 1 });
    }
  }
  scene._index = index;
  scene._bubbleNodes = bubbleNodes;
  scene._layout = layout;
  scene._raw = raw;
  scene._attrs = attrs;
  scene._xmlId = xmlId;
  scene._filmMs = filmMs;
  return scene;
}

function soundKindFrom(node, id) {
  const rk = attrOf(node, 'rkind');
  if (rk === 'bgmusic' || rk === 'voice' || rk === 'sfx' || rk === 'tts') return rk;
  if (kid(node, 'ttsdata')) return 'tts';
  const st = (attrOf(node, 'subtype') ?? '').toLowerCase();
  if (st === 'bgmusic') return 'bgmusic';
  if (st === 'voiceover' || st === 'voice') return 'voice';
  const up = (id ?? '').toUpperCase();
  if (up.includes('MUSIC')) return 'bgmusic';
  if (up.includes('VOICE')) return 'voice';
  return 'sfx';
}

function parseSound(node, used) {
  const xmlId = attrOf(node, 'id');
  const sfile = textOf(kid(node, 'sfile'));
  const startF = num(textOf(kid(node, 'start')), 0);
  const stopNode = kid(node, 'stop');
  const stopF = stopNode ? num(textOf(stopNode), startF) : startF;
  const tts = kid(node, 'ttsdata');
  const kind = soundKindFrom(node, xmlId);
  const s = {
    id: uniqueId(xmlId || nextId('s'), used),
    kind,
    assetId: sfile,
    start: framesToMs(startF),
    end: framesToMs(stopF),
    volume: Math.max(0, Math.min(1, num(attrOf(node, 'rvolume'), 1))),
    meta: { node: clone(node), xmlId },
  };
  // trimStart: frames trimmed off the source's head (left-trim); model keeps it as `offset` ms.
  const trimF = num(textOf(kid(node, 'trimStart')), 0);
  if (trimF > 0) s.offset = framesToMs(trimF);
  if (tts) {
    s.text = textOf(kid(tts, 'text'));
    s.voice = textOf(kid(tts, 'voice'));
  }
  return s;
}

/** Most common non-ugc theme prefix among the movie's assets (default 'common'). */
function guessTheme(movie) {
  const counts = new Map();
  const add = (assetId) => {
    const t = assetId?.slice(0, assetId.indexOf('.'));
    if (t && t !== 'ugc') counts.set(t, (counts.get(t) ?? 0) + 1);
  };
  for (const s of movie.scenes) {
    if (s.bg) add(s.bg.assetId);
    for (const e of [...s.chars, ...s.props, ...s.effects]) add(e.assetId);
  }
  let best = 'common'; let n = 0;
  for (const [t, c] of counts) if (c > n) { best = t; n = c; }
  return best === 'family' ? 'custom' : best === 'cc2' ? 'action' : best;
}

/**
 * Parse a legacy movie XML document.
 * @param {string} xml
 * @returns {Movie}
 */
export function parseMovieXml(xml) {
  const root = parseXmlTree(xml);
  if (root.n !== 'film') throw new Error(`not a movie document (root <${root.n}>)`);
  const used = new Set();
  const movie = createMovie({ scenes: [], sounds: [], title: 'Untitled' });
  const raw = [];
  const layout = [];
  let metaNode = null;
  const sceneNodes = [];
  let filmSeconds = num(attrOf(root, 'duration'), 0);
  for (const c of root.c) {
    if (!isEl(c)) continue;
    if (c.n === 'meta' && !metaNode) {
      metaNode = c;
      layout.push('meta');
    } else if (c.n === 'scene') {
      sceneNodes.push(c);
      if (!layout.includes('scenes')) layout.push('scenes');
    } else if (c.n === 'sound') {
      movie.sounds.push(parseSound(c, used));
      if (!layout.includes('sounds')) layout.push('sounds');
    } else {
      raw.push(nodeToXml(c));
      layout.push(raw.length - 1);
    }
  }
  // scenes: distribute film duration over scenes lacking an explicit delay
  const explicit = sceneNodes.map((n) => num(attrOf(n, 'adelay'), 0));
  const known = explicit.reduce((a, b) => a + (b > 0 ? framesToMs(b) : 0), 0);
  const unknownCount = explicit.filter((v) => !(v > 0)).length;
  const leftover = Math.max(0, filmSeconds * 1000 - known);
  sceneNodes.forEach((n, i) => {
    const s = parseScene(n, i, used, filmSeconds * 1000);
    if (s.duration === NO_DUR) s.duration = Math.max(MIN_SCENE_MS, unknownCount ? Math.round(leftover / unknownCount) || 3000 : 3000);
    // bubbles need the final scene duration
    s.bubbles = s._bubbleNodes.map((bn) => parseBubble(bn, used, s.duration));
    const idByPlaceholder = new Map();
    s._layout.forEach((t) => { if (t.k === 'bubble') idByPlaceholder.set(t.id, true); });
    let bi = 0;
    for (const t of s._layout) if (t.k === 'bubble') t.id = s.bubbles[bi++].id;
    // bubble targets: legacy has none; keep extension attr
    s.meta = { attrs: s._attrs, layout: s._layout, raw: s._raw, xmlId: s._xmlId };
    delete s._bubbleNodes; delete s._layout; delete s._raw; delete s._attrs; delete s._xmlId; delete s._index; delete s._filmMs;
    movie.scenes.push(s);
  });
  if (!movie.scenes.length) movie.scenes.push(createScene());
  // meta
  if (metaNode) {
    movie.title = textOf(kid(metaNode, 'title')) || 'Untitled';
  }
  movie.themeId = guessTheme(movie);
  movie.meta = {
    filmAttrs: root.a.map((p) => [...p]),
    metaNode: metaNode ? clone(metaNode) : null,
    raw,
    layout,
  };
  return movie;
}

// ---------------------------------------------------------------------------------------------
// serialize
// ---------------------------------------------------------------------------------------------

export const XML_HEADER = '<?xml version="1.0" encoding="utf-8"?>\n';

const PREFIX = { bg: 'BG', char: 'CHARACTER', prop: 'PROP', effect: 'EFFECT', bubble: 'BUBBLE', scene: 'SCENE', sound: 'SOUND' };

/** Allocates unique legacy-style ids at serialization. */
function makeIdAllocator() {
  const taken = new Set();
  const counters = {};
  return {
    /** keep `want` when it is legacy-shaped and unused; else mint PREFIX-N. */
    take(kind, modelId, original) {
      for (const cand of [original, modelId]) {
        if (cand && LEGACY_ID.test(cand) && !taken.has(cand)) { taken.add(cand); return cand; }
      }
      if (original && !taken.has(original)) { taken.add(original); return original; }
      let n = counters[kind] ?? 0;
      let id;
      do { id = `${PREFIX[kind]}-${n++}`; } while (taken.has(id));
      counters[kind] = n;
      taken.add(id);
      return id;
    },
  };
}

/** Compose the char <action> id from the model fields. */
export function charActionId(elem) {
  const a = elem.assetId ?? '';
  if (!elem.action) return a;
  const segs = a.split('.');
  if (segs.length < 3 || segs[segs.length - 1] !== 'swf') return a;
  return `${segs[0]}.${segs[1]}.${elem.action}`;
}

/** Patch a transform child only if its numeric value actually differs (keeps original text otherwise). */
function patchNum(node, name, legacyValue, create) {
  const k = kid(node, name);
  if (k) {
    if (!near(num(textOf(k), NaN), legacyValue, 1e-6)) setChildText(node, name, fmt(legacyValue, 4));
  } else if (create) setChildText(node, name, fmt(legacyValue, 4));
}

function buildElemNode(e, kind, tag, ids, z) {
  const node = e.meta?.node ? clone(e.meta.node) : { n: tag, a: [], c: [] };
  const isNew = !e.meta?.node;
  node.n = e.meta?.tag ?? tag;
  const xmlId = ids.take(kind, e.id, e.meta?.xmlId);
  setAttr(node, 'id', xmlId);
  const idx = attrOf(node, 'index');
  if (idx === undefined || !near(parseFloat(idx), e.z)) setAttr(node, 'index', fmt(e.z));
  if (kind === 'char') {
    const act = charActionId(e);
    if (textOf(kid(node, 'action')) !== act) setChildText(node, 'action', act);
  } else if (textOf(kid(node, 'file')) !== e.assetId) setChildText(node, 'file', e.assetId);
  if (kind !== 'bg' || !isNew) {
    patchNum(node, 'x', e.x / LEGACY_K, isNew);
    patchNum(node, 'y', e.y / LEGACY_K, isNew);
  }
  if (kind !== 'bg') {
    const ratio = e.meta?.yRatio ?? 1;
    patchNum(node, 'xscale', e.scale, isNew);
    patchNum(node, 'yscale', e.scale * ratio, isNew);
    const faceOrig = num(textOf(kid(node, 'face')), 1);
    const xsOrig = num(textOf(kid(node, 'xscale')), 1);
    const wasFlip = faceOrig < 0 || xsOrig < 0;
    if (isNew || wasFlip !== e.flip) setChildText(node, 'face', e.flip ? '-1' : '1');
    patchNum(node, 'rotation', e.rotation, isNew);
  }
  const rs = attrOf(node, 'rstart'); const re = attrOf(node, 'rstop');
  if (e.start != null) { if (rs === undefined || !near(num(rs, 0), e.start)) setAttr(node, 'rstart', fmt(e.start, 0)); } else if (rs !== undefined) delAttr(node, 'rstart');
  if (e.end != null) { if (re === undefined || !near(num(re, 0), e.end)) setAttr(node, 'rstop', fmt(e.end, 0)); } else if (re !== undefined) delAttr(node, 'rstop');
  return { node, xmlId };
}

function buildBubbleNode(b, scene, ids, targetXml) {
  const isNew = !b.meta?.node;
  const node = isNew ? { n: 'bubbleAsset', a: [], c: [] } : clone(b.meta.node);
  setAttr(node, 'id', ids.take('bubble', b.id, b.meta?.xmlId));
  let bubble = kid(node, 'bubble');
  if (!bubble) {
    bubble = {
      n: 'bubble',
      a: [['x', '-90'], ['y', '-45'], ['w', '180'], ['h', '90'], ['rotate', '0'], ['type', 'ELLIPSE'], ['hasTail', '1']],
      c: [
        { n: 'body', a: [['rgb', '0xFFFFFF'], ['linergb', '0'], ['tailx', '90'], ['taily', '65']], c: [] },
        { n: 'text', a: [['rgb', '0'], ['font', 'Lato'], ['size', '20'], ['align', 'center'], ['bold', 'false'], ['italic', 'false']], c: [] },
      ],
    };
    node.c.push(bubble);
  }
  let textNode = kid(bubble, 'text');
  if (!textNode) { textNode = { n: 'text', a: [], c: [] }; bubble.c.push(textNode); }
  if (textOf(textNode) !== b.text) textNode.c = b.text ? [{ cdata: b.text }] : [];
  const origType = (attrOf(bubble, 'type') ?? '').toLowerCase();
  if (origType !== b.style) setAttr(bubble, 'type', String(b.style).toUpperCase());
  if (b.style === 'blank' && attrOf(bubble, 'hasTail') === undefined) setAttr(bubble, 'hasTail', '0');
  const ax = kid(node, 'x'); const ay = kid(node, 'y');
  if (isNew || ax || ay) {
    patchNum(node, 'x', b.x / LEGACY_K, true);
    patchNum(node, 'y', b.y / LEGACY_K, true);
  } else {
    // anchor was bubble box: x/y attrs describe centre offset
    const w = num(attrOf(bubble, 'w'), 0); const h = num(attrOf(bubble, 'h'), 0);
    const nx = b.x / LEGACY_K - w / 2; const ny = b.y / LEGACY_K - h / 2;
    if (!near(nx, num(attrOf(bubble, 'x'), 0), 1e-6)) setAttr(bubble, 'x', fmt(nx));
    if (!near(ny, num(attrOf(bubble, 'y'), 0), 1e-6)) setAttr(bubble, 'y', fmt(ny));
  }
  if (b.targetId && targetXml.has(b.targetId)) setAttr(node, 'rtarget', targetXml.get(b.targetId));
  else delAttr(node, 'rtarget');
  const defaultEnd = scene.duration;
  if (b.start > 0 || attrOf(node, 'rstart') !== undefined) setAttr(node, 'rstart', fmt(b.start, 0));
  if (Math.round(b.end) !== Math.round(defaultEnd) || attrOf(node, 'rstop') !== undefined) setAttr(node, 'rstop', fmt(b.end, 0));
  return node;
}

function buildSoundNode(s, ids) {
  const isNew = !s.meta?.node;
  const node = isNew ? { n: 'sound', a: [], c: [] } : clone(s.meta.node);
  setAttr(node, 'id', ids.take('sound', s.id, s.meta?.xmlId));
  if (textOf(kid(node, 'sfile')) !== s.assetId) setChildText(node, 'sfile', s.assetId);
  const startF = msToFrames(s.start); const stopF = msToFrames(s.end);
  const so = kid(node, 'start'); const sp = kid(node, 'stop');
  if (!so || msToFrames(framesToMs(num(textOf(so), 0))) !== startF) setChildText(node, 'start', String(startF));
  if (!sp || msToFrames(framesToMs(num(textOf(sp), 0))) !== stopF) setChildText(node, 'stop', String(stopF));
  const offF = msToFrames(Math.max(0, s.offset ?? 0));
  if (isNew) {
    setChildText(node, 'trimStart', String(offF));
    setChildText(node, 'trimEnd', String(offF + Math.max(0, stopF - startF)));
  } else {
    // keep fade nodes; rewrite trim only when the offset really changed
    const oldF = num(textOf(kid(node, 'trimStart')), 0);
    if (msToFrames(framesToMs(oldF)) !== offF) {
      setChildText(node, 'trimStart', String(offF));
      setChildText(node, 'trimEnd', String(offF + Math.max(0, stopF - startF)));
    }
  }
  if (s.volume !== 1 || attrOf(node, 'rvolume') !== undefined) setAttr(node, 'rvolume', fmt(s.volume));
  const rk = attrOf(node, 'rkind');
  if (rk !== s.kind && (rk !== undefined || soundKindFrom(node, s.id) !== s.kind)) setAttr(node, 'rkind', s.kind);
  if (s.kind === 'tts' || kid(node, 'ttsdata')) {
    let t = kid(node, 'ttsdata');
    if (!t) { t = { n: 'ttsdata', a: [], c: [] }; node.c.push(t); }
    if (textOf(kid(t, 'text')) !== (s.text ?? '')) {
      let tx = kid(t, 'text');
      if (!tx) { tx = { n: 'text', a: [], c: [] }; t.c.push(tx); }
      tx.c = [{ cdata: s.text ?? '' }];
    }
    if (textOf(kid(t, 'voice')) !== (s.voice ?? '')) setChildText(t, 'voice', s.voice ?? '');
  }
  return node;
}

function ordered(scene) {
  const all = [];
  if (scene.bg) all.push({ e: scene.bg, kind: 'bg' });
  for (const e of scene.props) all.push({ e, kind: 'prop' });
  for (const e of scene.chars) all.push({ e, kind: 'char' });
  for (const e of scene.effects) all.push({ e, kind: 'effect' });
  return all;
}

function serializeScene(scene, index, ids, targetXml) {
  const meta = scene.meta ?? {};
  const attrs = (meta.attrs ?? []).map((p) => [...p]);
  const node = { n: 'scene', a: attrs, c: [] };
  setAttr(node, 'id', ids.take('scene', scene.id, meta.xmlId));
  const adelay = attrOf(node, 'adelay');
  if (adelay === undefined || msToFrames(framesToMs(num(adelay, 0))) !== msToFrames(scene.duration)) {
    setAttr(node, 'adelay', String(msToFrames(scene.duration)));
  }
  const byId = new Map();
  for (const it of ordered(scene)) byId.set(it.e.id, it);
  const bubbleById = new Map(scene.bubbles.map((b) => [b.id, b]));
  const used = new Set();
  const out = []; // XML strings in order
  const emitElem = (it) => {
    const tag = it.e.meta?.tag ?? (it.kind === 'effect' ? 'effectAsset' : it.kind);
    const { node: n, xmlId } = buildElemNode(it.e, it.kind, tag, ids);
    targetXml.set(it.e.id, xmlId);
    used.add(it.e.id);
    return nodeToXml(n);
  };
  // first pass: assign ids to chars so bubble targets resolve regardless of order
  const layout = meta.layout ?? [];
  const pending = [];
  for (const t of layout) {
    if (t.raw !== undefined && t.k === undefined) { pending.push({ xml: meta.raw[t.raw] }); continue; }
    if (t.k === 'camera') {
      const cam = scene.camera;
      if (!cam) continue;
      const o = t.orig ?? {};
      if (near(cam.x, o.x ?? NaN) && near(cam.y, o.y ?? NaN) && near(cam.zoom, o.zoom ?? NaN)) pending.push({ xml: meta.raw[t.raw] });
      else pending.push({ xml: nodeToXml({ n: 'camera', a: [['x', fmt(cam.x)], ['y', fmt(cam.y)], ['zoom', fmt(cam.zoom, 4)]], c: [] }) });
      used.add('camera');
      continue;
    }
    if (t.k === 'trans') {
      if (!scene.transitionOut) continue;
      if (scene.transitionOut === t.orig) pending.push({ xml: meta.raw[t.raw] });
      else pending.push({ xml: nodeToXml({ n: 'trans', a: [], c: [{ n: 'file', a: [], c: [scene.transitionOut] }] }) });
      used.add('trans');
      continue;
    }
    if (t.k === 'bubble') { const b = bubbleById.get(t.id); if (b) pending.push({ bubble: b }); continue; }
    const it = byId.get(t.id);
    if (it && it.kind === t.k) pending.push({ it });
  }
  const placed = new Set(pending.filter((p) => p.it).map((p) => p.it.e.id));
  const placedB = new Set(pending.filter((p) => p.bubble).map((p) => p.bubble.id));
  // new elements: bg first, others by z
  const fresh = ordered(scene).filter((it) => !placed.has(it.e.id)).sort((a, b) => (a.kind === 'bg' ? -1 : b.kind === 'bg' ? 1 : a.e.z - b.e.z));
  const all = [...fresh.filter((f) => f.kind === 'bg').map((it) => ({ it })), ...pending, ...fresh.filter((f) => f.kind !== 'bg').map((it) => ({ it }))];
  for (const b of scene.bubbles) if (!placedB.has(b.id)) all.push({ bubble: b });
  if (scene.camera && !used.has('camera') && !layout.some((t) => t.k === 'camera')) {
    all.push({ xml: nodeToXml({ n: 'camera', a: [['x', fmt(scene.camera.x)], ['y', fmt(scene.camera.y)], ['zoom', fmt(scene.camera.zoom, 4)]], c: [] }) });
  }
  if (scene.transitionOut && !layout.some((t) => t.k === 'trans')) {
    all.push({ xml: nodeToXml({ n: 'trans', a: [], c: [{ n: 'file', a: [], c: [scene.transitionOut] }] }) });
  }
  // elements first (so ids/targets are known), bubbles after
  const rendered = new Map();
  for (const p of all) if (p.it) rendered.set(p, emitElem(p.it));
  for (const p of all) {
    if (p.it) out.push(rendered.get(p));
    else if (p.bubble) out.push(nodeToXml(buildBubbleNode(p.bubble, scene, ids, targetXml)));
    else if (p.xml !== undefined) out.push(p.xml);
  }
  const open = nodeToXml({ n: node.n, a: node.a, c: [] });
  return `${open.slice(0, -2)}>${out.join('')}</scene>`;
}

/**
 * Serialize a movie to legacy XML.
 * @param {Movie} movie
 * @returns {string}
 */
export function serializeMovie(movie) {
  const meta = movie.meta ?? {};
  const ids = makeIdAllocator();
  const targetXml = new Map();
  const film = { n: 'film', a: (meta.filmAttrs ?? [['copyable', '0'], ['published', '0']]).map((p) => [...p]), c: [] };
  const seconds = Math.round((movieDuration(movie) / 1000) * 1000) / 1000;
  setAttr(film, 'duration', fmt(seconds));
  // meta node
  const mnode = meta.metaNode ? clone(meta.metaNode) : { n: 'meta', a: [], c: [] };
  const titleNode = kid(mnode, 'title');
  if (!titleNode) mnode.c.unshift({ n: 'title', a: [], c: [{ cdata: movie.title }] });
  else if (textOf(titleNode) !== movie.title) titleNode.c = [{ cdata: movie.title }];
  if (!meta.metaNode) {
    for (const [n, v] of [['hasWatermark', '0'], ['tag', ''], ['desc', '']]) mnode.c.push({ n, a: [], c: v ? [v] : [] });
  }
  const parts = [];
  const sceneXml = () => movie.scenes.map((s, i) => serializeScene(s, i, ids, targetXml)).join('');
  const soundXml = () => movie.sounds.map((s) => nodeToXml(buildSoundNode(s, ids))).join('');
  const layout = meta.layout ?? ['meta', 'scenes', 'sounds'];
  let didMeta = false; let didScenes = false; let didSounds = false;
  const emit = (t) => {
    if (t === 'meta') { if (!didMeta) { parts.push(nodeToXml(mnode)); didMeta = true; } }
    else if (t === 'scenes') { if (!didScenes) { parts.push(sceneXml()); didScenes = true; } }
    else if (t === 'sounds') { if (!didSounds) { parts.push(soundXml()); didSounds = true; } }
    else if (typeof t === 'number') parts.push((meta.raw ?? [])[t] ?? '');
  };
  // meta and scenes must come before big raw blobs even for fresh movies
  if (!layout.includes('meta')) emit('meta');
  const early = [];
  for (const t of layout) early.push(t);
  // ensure ordering: meta, scenes before sounds/raw only when they were absent from the layout
  const lead = [];
  if (!layout.includes('scenes')) lead.push('scenes');
  if (!layout.includes('sounds') && movie.sounds.length) lead.push('sounds');
  let inserted = false;
  for (const t of early) {
    emit(t);
    if (t === 'meta' && !inserted) { inserted = true; lead.forEach(emit); }
  }
  if (!inserted) lead.forEach(emit);
  emit('scenes'); emit('sounds');
  return `${XML_HEADER}${nodeToXml({ ...film, c: [] }).slice(0, -2)}>${parts.join('')}</film>`;
}
