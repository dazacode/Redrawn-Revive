/**
 * Redrawn Studio data model (typedefs + pure factories). Everyone imports types from here:
 *   /** @typedef {import('./model.js').Movie} Movie *\/
 * Coordinates are stage pixels in a 550x310 space (origin top-left). Times are ms.
 */

import { nextId } from './ids.js';

export const STAGE_W = 550;
export const STAGE_H = 310;
export const DEFAULT_SCENE_MS = 3000;
export const MIN_SCENE_MS = 500;
/**
 * Legacy Flash scenes are authored in a 640x360 logical space (inferred from theme data: positions of
 * composite background props are centred on x~320). The studio model uses 550x310 = legacy * LEGACY_K.
 * movie-xml.js converts x and y by LEGACY_K on load/save. `scale` is NOT converted: scale 1 means the SWF's
 * native (legacy) size, so the stage must draw an element at  nativeSize * elem.scale * LEGACY_K  (the same
 * factor that maps legacy 640x360 onto 550x310). Set LEGACY_K to 1 to disable all conversion.
 */
export const LEGACY_W = 640;
export const LEGACY_H = 360;
export const LEGACY_K = STAGE_W / LEGACY_W;
/** Legacy timeline resolution: frames per second. */
export const FPS = 24;

/**
 * @typedef {Object} Elem
 * @property {string} id
 * @property {string} assetId   dotted legacy id, e.g. "common.Diner_bg.swf", "cc2.xml"-style "theme.charId.xml"
 * @property {number} x
 * @property {number} y
 * @property {number} scale     1 = 100%
 * @property {number} rotation  degrees
 * @property {boolean} flip
 * @property {number} z         layer; higher = in front
 * @property {string} [action]  character action asset id (e.g. "default.swf" or "theme.char.model.swf")
 * @property {string} [emotion]
 * @property {number} [start]   ms from scene start
 * @property {number} [end]     ms from scene start
 * @property {Object} [meta]    format-specific leftovers (raw XML etc); treat as opaque
 */

/**
 * @typedef {Object} Bubble
 * @property {string} id
 * @property {string} text
 * @property {number} x
 * @property {number} y
 * @property {string} style     legacy bubble type, lower-case: ellipse | roundrectangular | rectangular | blank | blanktail | boom | cloud | heart (see FORMAT.md)
 * @property {string} [targetId]  char Elem id the bubble belongs to
 * @property {number} start
 * @property {number} end
 * @property {Object} [meta]
 */

/**
 * @typedef {Object} Camera
 * @property {number} x
 * @property {number} y
 * @property {number} zoom
 */

/**
 * @typedef {Object} Scene
 * @property {string} id
 * @property {number} duration  ms
 * @property {Elem|null} bg
 * @property {Elem[]} chars
 * @property {Elem[]} props
 * @property {Bubble[]} bubbles
 * @property {Elem[]} effects
 * @property {Camera|null} camera
 * @property {string|null} transitionOut
 * @property {Object} [meta]
 */

/**
 * @typedef {'bgmusic'|'voice'|'sfx'|'tts'} SoundKind
 * @typedef {Object} SoundClip
 * @property {string} id
 * @property {SoundKind} kind
 * @property {string} assetId   "theme.name.swf" (store) or "ugc.xxx.mp3" (uploaded/tts)
 * @property {number} start     ms from movie start
 * @property {number} end       ms from movie start
 * @property {number} volume    0..1
 * @property {string} [text]    tts text
 * @property {string} [voice]   tts voice id
 * @property {Object} [meta]
 */

/**
 * @typedef {Object} Movie
 * @property {string|null} id
 * @property {string} title
 * @property {string} themeId
 * @property {number} width
 * @property {number} height
 * @property {Scene[]} scenes
 * @property {SoundClip[]} sounds
 * @property {Object} meta   meta.raw = unknown top-level XML preserved verbatim
 */

/**
 * @typedef {Object} Selection
 * @property {string|null} sceneId
 * @property {string|null} elemId
 * @property {'scene'|'bg'|'char'|'prop'|'effect'|'bubble'|'sound'|null} kind
 */

/**
 * @typedef {Object} StudioState
 * @property {Movie} movie
 * @property {Selection} selection
 * @property {number} playhead   ms, movie-absolute
 * @property {boolean} playing
 * @property {number} zoom       timeline zoom (px per second)
 */

/** Short unique id (see ids.js; deterministic after seedIds()). */
export function uid(prefix = 'x') {
  return nextId(prefix);
}

/** @returns {Elem} */
export function createElem(assetId, over = {}) {
  return { id: uid('e'), assetId, x: STAGE_W / 2, y: STAGE_H / 2, scale: 1, rotation: 0, flip: false, z: 0, ...over };
}

/** @returns {Bubble} */
export function createBubble(over = {}) {
  return { id: uid('b'), text: '', x: STAGE_W / 2, y: 60, style: 'ellipse', start: 0, end: 2000, ...over };
}

/** @returns {SoundClip} */
export function createSound(over = {}) {
  return { id: uid('s'), kind: 'sfx', assetId: '', start: 0, end: 1000, volume: 1, ...over };
}

/** @returns {Scene} */
export function createScene(over = {}) {
  return {
    id: uid('sc'), duration: DEFAULT_SCENE_MS, bg: null, chars: [], props: [], bubbles: [], effects: [],
    camera: null, transitionOut: null, ...over,
  };
}

/** @returns {Movie} */
export function createMovie(over = {}) {
  return {
    id: null, title: 'Untitled', themeId: 'common', width: STAGE_W, height: STAGE_H,
    scenes: [createScene()], sounds: [], meta: {}, ...over,
  };
}

/** Total movie length in ms. */
export function movieDuration(movie) {
  return movie.scenes.reduce((a, s) => a + s.duration, 0);
}

/** Absolute start time (ms) of the scene with the given id, or -1. */
export function sceneStart(movie, sceneId) {
  let t = 0;
  for (const s of movie.scenes) {
    if (s.id === sceneId) return t;
    t += s.duration;
  }
  return -1;
}

/** Locate the scene at movie-absolute time. Returns {scene, index, start, local} (clamped to the last scene). */
export function sceneAt(movie, ms) {
  let t = 0;
  for (let i = 0; i < movie.scenes.length; i++) {
    const s = movie.scenes[i];
    if (ms < t + s.duration || i === movie.scenes.length - 1) {
      return { scene: s, index: i, start: t, local: Math.max(0, Math.min(s.duration, ms - t)) };
    }
    t += s.duration;
  }
  return null;
}

export function findScene(movie, sceneId) {
  return movie.scenes.find((s) => s.id === sceneId) ?? null;
}

/** Find an element by id in a scene. Returns {elem, kind} where kind is bg|char|prop|effect, or null. */
export function findElem(scene, elemId) {
  if (!scene || !elemId) return null;
  if (scene.bg?.id === elemId) return { elem: scene.bg, kind: 'bg' };
  for (const [list, kind] of [[scene.chars, 'char'], [scene.props, 'prop'], [scene.effects, 'effect']]) {
    const e = list.find((x) => x.id === elemId);
    if (e) return { elem: e, kind };
  }
  return null;
}

/** All elements of a scene in draw order (bg, then by z ascending; stable by kind order). */
export function sceneElems(scene) {
  const list = [...scene.props.map((e) => ({ e, kind: 'prop' })), ...scene.chars.map((e) => ({ e, kind: 'char' })), ...scene.effects.map((e) => ({ e, kind: 'effect' }))];
  list.sort((a, b) => a.e.z - b.e.z);
  const out = [];
  if (scene.bg) out.push({ e: scene.bg, kind: 'bg' });
  return out.concat(list);
}

/** Deep clone of plain JSON-like data. */
export function clone(v) {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}
