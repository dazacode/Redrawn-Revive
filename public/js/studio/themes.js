/**
 * Theme catalogue for Studio: list/load themes, map dotted asset ids to store URLs.
 *
 *   loadThemeList(): Promise<ThemeSummary[]>
 *   loadTheme(id): Promise<Theme>                       (cached; concurrent calls share one request)
 *   assetUrl(assetId, themeId?, opts?): string          opts: {kind?, movieId?}; '' when no URL exists
 *   assetKind(assetId): 'bg'|'prop'|'char'|'effect'|'sound'|null   (known once the owning theme was loaded)
 *   getTheme(id): Theme|null                            (sync, only if already loaded)
 *   findAsset(assetId): Asset|null                      (sync lookup across loaded themes)
 *   matchAsset(asset, query): boolean                   (search helper: name + tags)
 *   charActionAssetId(char, actionId): string
 *   storeBase(): string                                 e.g. "/store/3a981f5cb2739137"
 *
 * Source data: the static `<store>/<theme>/theme.xml` files (same documents `/goapi/getTheme` zips).
 * Store layout (src/pack.ts): <store>/<theme>/{bg,prop,effect,sound}/<file> and <store>/<theme>/char/<charId>/<action>.swf
 * Coordinates of composite background props are converted to model space (see model.js LEGACY_K).
 */
import { LEGACY_K } from './model.js';
import { kid, kids, attrOf, textOf, parseXmlTree } from './movie-xml.js';

/** @typedef {{assetId:string, name:string, thumbUrl?:string, tags:string[]}} AssetBase */
/** @typedef {AssetBase & {id:string, composite?:{props:{assetId:string,x:number,y:number,scale:number,flip:boolean,rotation:number,z:number}[]}}} BgAsset */
/** @typedef {{id:string, name:string, assetId:string, loop:boolean, frames:number, category:string}} ActionAsset */
/** @typedef {AssetBase & {id:string, facing:string, defaultAction:string, motion:string, cc?:boolean, ccThemeId?:string, actions:{emotion:ActionAsset[], action:ActionAsset[], motion:ActionAsset[]}}} CharAsset */
/** @typedef {AssetBase & {id:string, holdable:boolean, placeable:boolean, wearable:boolean, facing:string, states?:{id:string,name:string,assetId:string,isDefault:boolean}[]}} PropAsset */
/** @typedef {AssetBase & {id:string, subtype:string, kind:'bgmusic'|'sfx'|'voice', duration:number}} SoundAsset */
/** @typedef {AssetBase & {id:string, type:string, resize:boolean, move:boolean}} EffectAsset */
/** @typedef {{id:string, style:string, w:number, h:number, text:string, font:string, size:number, hasTail:boolean, name:string}} BubbleAsset */
/** @typedef {{id:string, name:string, thumb?:string, ccThemeId?:string}} ThemeSummary */
/** @typedef {{id:string, name:string, ccThemeId?:string, backgrounds:BgAsset[], characters:CharAsset[], props:PropAsset[], sounds:SoundAsset[], effects:EffectAsset[], bubbles:BubbleAsset[]}} Theme */

const DEFAULT_STORE = '/store/3a981f5cb2739137';
let base = DEFAULT_STORE;
let configPromise = null;

/** Theme ids the legacy server aliases (see src/routes/legacy.ts getTheme and src/pack.ts). */
const ALIAS = { family: 'custom', cc2: 'action' };
const resolveId = (id) => ALIAS[id] ?? id;

/** Fallback list when /goapi/getThemeList is unreachable (ids that have a store folder). */
const FALLBACK_THEMES = [
  ['common', 'Common'], ['custom', 'Comedy World'], ['action', "Lil' Peepz"], ['anime', 'Anime'],
  ['ninjaanime', 'Ninja Anime'], ['chibi', 'Chibi Peepz'], ['ninja', 'Chibi Ninjas'], ['space', 'Space Peepz'],
  ['spacecitizen', 'Space Citizens'], ['stick', 'Stick Figure'], ['animal', "Lil' Petz"], ['retro', 'Cartoon Classics'],
  ['politics2', 'White Houserz'], ['import', 'Imported Assets'],
];

/** Set the store base explicitly (tests, or when config was already fetched elsewhere). */
export function setStoreBase(url) {
  base = stripOrigin(String(url || DEFAULT_STORE)).replace(/\/+$/, '');
}
export function storeBase() {
  return base;
}

function stripOrigin(u) {
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/]+(\/.*)?$/i.exec(u);
  return m ? m[1] ?? '/' : u;
}

/** Fetch /ajax/config once and adopt STORE_URL. Never throws. */
export function initThemes() {
  configPromise ??= fetch('/ajax/config')
    .then((r) => (r.ok ? r.json() : null))
    .then((c) => { if (c?.STORE_URL) setStoreBase(c.STORE_URL); })
    .catch(() => {});
  return configPromise;
}

// ---- asset kind registry ------------------------------------------------------------------------

/** @type {Map<string, {kind:string, asset:object}>} */
const registry = new Map();
const loaded = new Map(); // themeId -> Theme
const inflight = new Map(); // themeId -> Promise<Theme>

function register(asset, kind) {
  if (asset?.assetId && !registry.has(asset.assetId)) registry.set(asset.assetId, { kind, asset });
}

export function assetKind(assetId) {
  const hit = registry.get(assetId);
  if (hit) return hit.kind;
  // char action ids ("common.matchBoyNew.stand.swf") resolve through their char
  const segs = String(assetId).split('.');
  if (segs.length >= 4) return registry.get(`${segs[0]}.${segs[1]}`)?.kind ?? null;
  return null;
}

export function findAsset(assetId) {
  return registry.get(assetId)?.asset ?? null;
}

export function getTheme(id) {
  return loaded.get(resolveId(id)) ?? null;
}

// ---- URL mapping --------------------------------------------------------------------------------

const enc = (s) => encodeURIComponent(s).replace(/%2F/gi, '/');

/**
 * Map a dotted legacy asset id to a URL.
 *   common.Diner_bg.swf          -> <store>/common/bg/Diner_bg.swf        (kind bg)
 *   common.02bat.swf             -> <store>/common/prop/02bat.swf         (kind prop)
 *   common.matchBoyNew.stand.swf -> <store>/common/char/matchBoyNew/stand.swf
 *   common.roadSide.swf          -> <store>/common/sound/roadSide.swf     (kind sound)
 *   ugc.abc.mp3                  -> /assets/<movieId>/abc.mp3            (needs opts.movieId; else '')
 * The kind comes from opts.kind, else from loaded theme data (assetKind), else from the file name
 * (.mp3 => sound, a char-shaped id => char, otherwise bg). `themeId` supplies the theme for ids without one.
 * @param {string} assetId
 * @param {string} [themeId]
 * @param {{kind?:string, movieId?:string}} [opts]
 */
export function assetUrl(assetId, themeId, opts = {}) {
  const s = String(assetId ?? '');
  if (!s) return '';
  const dot = s.indexOf('.');
  let theme = dot < 0 ? themeId || '' : s.slice(0, dot);
  const rest = dot < 0 ? s : s.slice(dot + 1);
  if (theme === 'ugc') return opts.movieId ? `/assets/${enc(opts.movieId)}/${enc(rest.replace(/\.xml$/, ''))}` : '';
  theme = resolveId(theme);
  if (!theme || !rest) return '';
  const segs = rest.split('.');
  let kind = opts.kind ?? assetKind(s);
  if (!kind) {
    if (/\.mp3$/i.test(rest)) kind = 'sound';
    else if (segs.length >= 3) kind = 'char';
    else kind = 'bg';
  }
  if (kind === 'char') {
    if (segs.length < 3) return '';
    return `${base}/${enc(theme)}/char/${enc(segs[0])}/${enc(segs.slice(1).join('.'))}`;
  }
  if (kind === 'prop') {
    // "msp_cake01" (a folder prop) -> its default state; "msp_cake01.full.swf" -> <prop>/msp_cake01/full.swf
    const folder = registry.get(`${theme}.${segs[0]}`)?.asset;
    if (segs.length === 1 && folder?.states?.length) return assetUrl(folder.states.find((x) => x.isDefault)?.assetId ?? folder.states[0].assetId, theme, { ...opts, kind });
    if (segs.length >= 3) return `${base}/${enc(theme)}/prop/${enc(segs[0])}/${enc(segs.slice(1).join('.'))}`;
  }
  return `${base}/${enc(theme)}/${kind}/${enc(rest)}`;
}

/** "common.matchBoyNew" + "talk.swf" -> "common.matchBoyNew.talk.swf". */
export function charActionAssetId(char, actionId) {
  const segs = String(char.assetId).split('.');
  return `${segs[0]}.${segs[1]}.${actionId}`;
}

/** Case-insensitive match of a search string against name, id and tags (all words must match). */
export function matchAsset(asset, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return true;
  const hay = `${asset.name ?? ''} ${asset.assetId ?? ''} ${(asset.tags ?? []).join(' ')}`.toLowerCase();
  return q.split(/\s+/).every((w) => hay.includes(w));
}

// ---- parsing ------------------------------------------------------------------------------------

const yes = (v) => v === 'Y' || v === 'y' || v === 'true' || v === '1';
const tagsOf = (name, id, themeName) => {
  const words = new Set();
  for (const src of [name, id.replace(/\.\w+$/, '').replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2'), themeName]) {
    for (const w of String(src ?? '').toLowerCase().split(/[^a-z0-9]+/)) if (w.length > 1) words.add(w);
  }
  return [...words];
};
const fileTitle = (id) => id.replace(/\.\w+$/, '').replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();

function parseAction(node, themeId, charId, category) {
  const id = attrOf(node, 'id') ?? '';
  return {
    id,
    name: attrOf(node, 'name') || fileTitle(id),
    assetId: `${themeId}.${charId}.${id}`,
    loop: yes(attrOf(node, 'loop')),
    frames: Number(attrOf(node, 'totalframe')) || 0,
    category,
  };
}

/**
 * Parse a theme.xml document into a Theme. Pure (no network); exported for tests.
 * @param {string} xml
 * @param {string} [fallbackId]
 * @returns {Theme}
 */
export function parseThemeXml(xml, fallbackId = '') {
  const root = parseXmlTree(xml);
  const id = attrOf(root, 'id') || fallbackId;
  const name = attrOf(root, 'name') || id;
  const thumbFor = (dir, file) => (file ? `${base}/${enc(id)}/${dir}/${enc(file)}` : undefined);

  /** @type {Map<string, BgAsset>} */
  const bgs = new Map();
  for (const c of kids(root, 'compositebg')) {
    const bgNode = kid(c, 'bg');
    const bgFile = textOf(kid(bgNode, 'file'));
    if (!bgFile) continue;
    const props = kids(c, 'prop').map((p, i) => {
      const xs = parseFloat(textOf(kid(p, 'xscale'))) || 1;
      return {
        assetId: textOf(kid(p, 'file')),
        x: (parseFloat(textOf(kid(p, 'x'))) || 0) * LEGACY_K,
        y: (parseFloat(textOf(kid(p, 'y'))) || 0) * LEGACY_K,
        scale: Math.abs(xs),
        flip: (parseFloat(textOf(kid(p, 'face'))) || 1) < 0,
        rotation: parseFloat(textOf(kid(p, 'rotation'))) || 0,
        z: parseFloat(attrOf(p, 'index')) || i + 1,
      };
    }).filter((p) => p.assetId);
    const cid = attrOf(c, 'id') ?? bgFile;
    const nm = attrOf(c, 'name') || fileTitle(cid);
    const prev = bgs.get(bgFile);
    if (prev && !props.length) {
      prev.thumbUrl ??= thumbFor('bg', attrOf(c, 'thumb'));
      continue;
    }
    bgs.set(bgFile, {
      id: cid, assetId: bgFile, name: nm, thumbUrl: thumbFor('bg', attrOf(c, 'thumb')), tags: tagsOf(nm, cid, name),
      ...(props.length ? { composite: { props } } : {}),
    });
  }
  for (const b of kids(root, 'background')) {
    const bid = attrOf(b, 'id');
    if (!bid) continue;
    const assetId = `${id}.${bid}`;
    const prev = bgs.get(assetId);
    const nm = attrOf(b, 'name') || fileTitle(bid);
    if (prev) { if (!prev.name || prev.name === fileTitle(prev.id)) prev.name = nm; continue; }
    bgs.set(assetId, { id: bid, assetId, name: nm, thumbUrl: thumbFor('bg', attrOf(b, 'thumb')), tags: tagsOf(nm, bid, name) });
  }

  /** @type {CharAsset[]} */
  const characters = kids(root, 'char').map((c) => {
    const cid = attrOf(c, 'id') ?? '';
    const actions = { emotion: [], action: [], motion: [] };
    for (const cat of kids(c, 'category')) {
      const key = (attrOf(cat, 'name') ?? 'action').toLowerCase();
      const list = actions[key] ?? (actions[key] = []);
      for (const a of kids(cat, 'action')) list.push(parseAction(a, id, cid, key));
    }
    for (const a of kids(c, 'action')) actions.action.push(parseAction(a, id, cid, 'action'));
    for (const a of kids(c, 'motion')) actions.motion.push(parseAction(a, id, cid, 'motion'));
    const def = attrOf(c, 'default') || actions.action[0]?.id || '';
    const nm = attrOf(c, 'name') || cid;
    const ccTheme = attrOf(c, 'cc_theme_id');
    const hasActions = actions.emotion.length + actions.action.length + actions.motion.length > 0;
    if (!hasActions && cid) {
      // character-creator character (Comedy World stock characters): a cc_char document at /characters/<id>.xml
      return {
        id: cid, assetId: `${id}.${cid}.xml`, name: nm, facing: 'left', defaultAction: '', motion: '', cc: true, ccThemeId: ccTheme || undefined,
        tags: tagsOf(nm, cid, name), actions,
      };
    }
    return {
      id: cid, assetId: `${id}.${cid}.${def}`, name: nm, facing: attrOf(c, 'facing') ?? 'left',
      defaultAction: def, motion: attrOf(c, 'motion') ?? '',
      tags: tagsOf(nm, cid, name), actions,
    };
  });

  /** @type {PropAsset[]} */
  const props = kids(root, 'prop').map((p) => {
    const pid = attrOf(p, 'id') ?? '';
    const nm = attrOf(p, 'name') || fileTitle(pid);
    // A prop with <state> children is a folder (prop/<id>/<state>.swf): resolve it to its default state file.
    const states = kids(p, 'state').map((s) => ({ id: attrOf(s, 'id') ?? '', name: attrOf(s, 'name') || fileTitle(attrOf(s, 'id') ?? ''), isDefault: yes(attrOf(s, 'default')) })).filter((s) => s.id);
    const def = states.find((s) => s.isDefault) ?? states[0];
    const thumb = attrOf(p, 'thumb');
    return {
      id: pid, assetId: def ? `${id}.${pid}.${def.id}` : `${id}.${pid}`, name: nm,
      // an .swf "thumb" is rendered from the asset itself (thumbs.js), it is not an image URL
      thumbUrl: thumb && !/\.swf$/i.test(thumb) ? thumbFor('prop', thumb) : undefined,
      holdable: yes(attrOf(p, 'holdable')), placeable: attrOf(p, 'placeable') !== '0', wearable: yes(attrOf(p, 'wearable')),
      facing: attrOf(p, 'facing') ?? 'left', tags: tagsOf(nm, pid, name),
      ...(states.length ? { states: states.map((s) => ({ id: s.id, name: s.name, assetId: `${id}.${pid}.${s.id}`, isDefault: s === def })) } : {}),
    };
  }).filter((p) => p.id);

  /** @type {SoundAsset[]} */
  const sounds = kids(root, 'sound').map((s) => {
    const sid = attrOf(s, 'id') ?? '';
    const nm = attrOf(s, 'name') || fileTitle(sid);
    const subtype = attrOf(s, 'subtype') ?? 'soundeffect';
    return {
      id: sid, assetId: `${id}.${sid}`, name: nm, subtype, kind: subtype === 'bgmusic' ? 'bgmusic' : 'sfx',
      duration: Number(attrOf(s, 'duration')) || 0, tags: tagsOf(nm, sid, name),
    };
  }).filter((s) => s.id);

  /** @type {EffectAsset[]} */
  const effects = kids(root, 'effect').map((e) => {
    const eid = attrOf(e, 'id') ?? '';
    const nm = attrOf(e, 'name') || fileTitle(eid);
    return {
      id: eid, assetId: `${id}.${eid}`, name: nm, type: attrOf(e, 'type') ?? 'ANIME',
      resize: yes(attrOf(e, 'resize')), move: yes(attrOf(e, 'move')), tags: tagsOf(nm, eid, name),
    };
  }).filter((e) => e.id);

  /** @type {BubbleAsset[]} */
  const bubbles = kids(root, 'bubble').map((b) => {
    const t = kid(b, 'text');
    const bid = attrOf(b, 'id') ?? '';
    return {
      id: bid, name: fileTitle(bid), style: (attrOf(b, 'type') ?? 'ELLIPSE').toLowerCase(),
      w: Number(attrOf(b, 'w')) || 180, h: Number(attrOf(b, 'h')) || 90,
      text: textOf(t), font: attrOf(t, 'font') ?? '', size: Number(attrOf(t, 'size')) || 20, hasTail: attrOf(b, 'hasTail') !== '0',
    };
  }).filter((b) => b.id);

  return { id, name, ccThemeId: attrOf(root, 'cc_theme_id') || undefined, backgrounds: [...bgs.values()], characters, props, sounds, effects, bubbles };
}

function registerTheme(t) {
  for (const a of t.backgrounds) register(a, 'bg');
  for (const a of t.characters) {
    register(a, 'char');
    register({ ...a, assetId: `${t.id}.${a.id}` }, 'char');
  }
  for (const a of t.props) {
    register(a, 'prop');
    if (a.states) { // the bare folder id and every state resolve to this prop
      register({ ...a, assetId: `${t.id}.${a.id}` }, 'prop');
      for (const st of a.states) register({ ...a, assetId: st.assetId }, 'prop');
    }
  }
  for (const a of t.sounds) register(a, 'sound');
  for (const a of t.effects) register(a, 'effect');
  // composite props are ordinary props even if the theme does not list them standalone
  for (const bg of t.backgrounds) for (const p of bg.composite?.props ?? []) if (!registry.has(p.assetId)) registry.set(p.assetId, { kind: 'prop', asset: { assetId: p.assetId, name: fileTitle(p.assetId.split('.').slice(1).join('.')), tags: [] } });
}

/** Register a parsed theme directly (tests, or themes obtained elsewhere). */
export function addTheme(theme) {
  loaded.set(theme.id, theme);
  registerTheme(theme);
  return theme;
}

/** Forget cached themes (tests). */
export function resetThemes() {
  loaded.clear(); inflight.clear(); registry.clear(); listPromise = null;
}

/**
 * @param {string} id
 * @returns {Promise<Theme>}
 */
export function loadTheme(id) {
  const tid = resolveId(id);
  const have = loaded.get(tid);
  if (have) return Promise.resolve(have);
  let p = inflight.get(tid);
  if (!p) {
    p = (async () => {
      await initThemes();
      const res = await fetch(`${base}/${encodeURIComponent(tid)}/theme.xml`);
      if (!res.ok) throw new Error(`theme ${tid}: HTTP ${res.status}`);
      return addTheme(parseThemeXml(await res.text(), tid));
    })().finally(() => inflight.delete(tid));
    inflight.set(tid, p);
  }
  return p;
}

// ---- user (character creator) characters ---------------------------------------------------------

/** @type {Map<string, Promise<CharAsset[]>>} */
const userChars = new Map();

/**
 * Characters the user made with the character creator for a CC theme ("family", "cc2", "anime" ...), newest first.
 * Each is a cc_char document: assetId "ugc.c-N.xml". Never rejects (an unreachable server gives []).
 * @param {string} ccThemeId
 * @param {boolean} [fresh]
 * @returns {Promise<CharAsset[]>}
 */
export function loadUserChars(ccThemeId, fresh = false) {
  if (!ccThemeId) return Promise.resolve([]);
  if (fresh) userChars.delete(ccThemeId);
  let p = userChars.get(ccThemeId);
  if (!p) {
    p = (async () => {
      try {
        const res = await fetch(`/goapi/getUserAssetsXml?type=char&themeId=${encodeURIComponent(ccThemeId)}`);
        if (!res.ok) return [];
        const root = parseXmlTree(await res.text());
        return kids(root, 'char').map((c) => {
          const cid = attrOf(c, 'id') ?? '';
          return {
            id: cid, assetId: `ugc.${cid}.xml`, name: `Character ${cid.replace(/^c-/, '#')}`, facing: 'left', defaultAction: '', motion: '', cc: true,
            ccThemeId: attrOf(c, 'cc_theme_id') || ccThemeId, tags: ['yours', 'custom', 'character'], actions: { emotion: [], action: [], motion: [] },
          };
        }).filter((c) => c.id);
      } catch { return []; }
    })();
    userChars.set(ccThemeId, p);
  }
  return p;
}

// ---- theme list ---------------------------------------------------------------------------------

let listPromise = null;

/** Read one entry of a zip (stored or deflate) with the browser's DecompressionStream. */
export async function unzipText(bytes, name) {
  let u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8[0] === 0 && u8[1] === 0x50) u8 = u8.subarray(1); // legacy status byte
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let i = u8.length - 22;
  while (i >= 0 && dv.getUint32(i, true) !== 0x06054b50) i--;
  if (i < 0) throw new Error('not a zip');
  const count = dv.getUint16(i + 10, true);
  let p = dv.getUint32(i + 16, true);
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true);
    const elen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const off = dv.getUint32(p + 42, true);
    const fname = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nlen));
    if (fname === name) {
      const lnlen = dv.getUint16(off + 26, true);
      const lelen = dv.getUint16(off + 28, true);
      const data = u8.subarray(off + 30 + lnlen + lelen, off + 30 + lnlen + lelen + csize);
      if (method === 0) return new TextDecoder().decode(data);
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new TextDecoder().decode(await new Response(stream).arrayBuffer());
    }
    p += 46 + nlen + elen + clen;
  }
  throw new Error(`zip entry ${name} not found`);
}

/** Parse the legacy themelist.xml into summaries. Pure; exported for tests. */
export function parseThemeList(xml) {
  const root = parseXmlTree(xml);
  /** @type {ThemeSummary[]} */
  const out = [];
  for (const t of kids(root, 'theme')) {
    const id = attrOf(t, 'id');
    if (!id) continue;
    out.push({ id, name: attrOf(t, 'name') || id, thumb: attrOf(t, 'thumb') || undefined, ccThemeId: attrOf(t, 'cc_theme_id') || undefined });
  }
  return out;
}

/** @returns {Promise<ThemeSummary[]>} */
export function loadThemeList() {
  listPromise ??= (async () => {
    await initThemes();
    let list = [];
    try {
      const res = await fetch('/goapi/getThemeList', { method: 'POST' });
      if (res.ok) list = parseThemeList(await unzipText(new Uint8Array(await res.arrayBuffer()), 'themelist.xml'));
    } catch { /* fall through to the built-in list */ }
    if (!list.length) list = FALLBACK_THEMES.map(([id, name]) => ({ id, name }));
    if (!list.some((t) => t.id === 'common')) list.push({ id: 'common', name: 'Common' });
    return list;
  })();
  return listPromise.catch((e) => { listPromise = null; throw e; });
}
