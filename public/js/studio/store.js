/**
 * Studio store: single source of truth, command based, undoable.
 *
 *   const store = createStore(movie?)
 *   store.get()            -> StudioState (immutable snapshot; a new object after every change)
 *   store.subscribe(fn)    -> unsubscribe.  fn(state, cmd, prevState) after every state change
 *   store.dispatch(cmd)    -> true if state changed
 *   store.undo() / redo() / canUndo() / canRedo() / markSaved() / isDirty()
 *
 * Commands are `{type, ...}`. UI-only (not undoable): select, setPlayhead, setPlaying, setZoom.
 * Undoable: addScene, removeScene, duplicateScene, moveScene, setSceneProps, setBackground, addElem,
 *   updateElem, removeElem, reorderElem, addBubble, updateBubble, removeBubble, addSound, updateSound,
 *   removeSound, setTitle, setTheme, batch{cmds}.  `loadMovie{movie}` resets history.
 * A command may carry `coalesce: 'drag-<id>'`: consecutive commands with the same key form ONE undo step.
 *
 * Details others rely on:
 *  - select{sceneId?, elemId?, kind?}: omitted sceneId keeps the current one. When the selected scene
 *    changes and `keepPlayhead` is not true, the playhead jumps to that scene's start (unless playing).
 *  - setPlayhead{ms}: clamped to [0, movieDuration]; also moves selection.sceneId to the scene under the
 *    playhead (clearing elemId/kind when that scene changes, except a selected sound clip, which stays selected), so "current scene" == selection.sceneId.
 *  - A movie always has at least one scene (removing the last scene leaves a fresh empty one).
 *  - Movies are never mutated in place: untouched parts are shared between history entries.
 */
import {
  MIN_SCENE_MS, STAGE_H, STAGE_W, clone, createBubble, createElem, createMovie, createScene, createSound,
  findElem, findScene, movieDuration, sceneAt, sceneStart,
} from './model.js';
import { nextId } from './ids.js';

/** @typedef {import('./model.js').Movie} Movie */
/** @typedef {import('./model.js').Scene} Scene */
/** @typedef {import('./model.js').Elem} Elem */
/** @typedef {import('./model.js').StudioState} StudioState */

export const UI_COMMANDS = new Set(['select', 'setPlayhead', 'setPlaying', 'setZoom']);
const HISTORY_LIMIT = 200;
const ELEM_LISTS = { char: 'chars', prop: 'props', effect: 'effects' };
const FORBIDDEN_PATCH = new Set(['id']);

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Copy a patch without protected keys and with non-finite numbers dropped. */
function cleanPatch(patch) {
  const out = {};
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (FORBIDDEN_PATCH.has(k)) continue;
    if (typeof v === 'number' && !Number.isFinite(v)) continue;
    out[k] = v;
  }
  return out;
}

/** Shallow copy of a scene with its arrays copied (so a mutator can push/splice safely). */
function openScene(s) {
  return { ...s, chars: [...s.chars], props: [...s.props], effects: [...s.effects], bubbles: [...s.bubbles] };
}

/** New movie with scene `sceneId` replaced by mut(openedCopy) (mut may return a replacement). */
function withScene(movie, sceneId, mut) {
  const i = movie.scenes.findIndex((s) => s.id === sceneId);
  if (i < 0) return movie;
  const next = openScene(movie.scenes[i]);
  const r = mut(next) ?? next;
  if (r === false) return movie;
  const scenes = [...movie.scenes];
  scenes[i] = r;
  return { ...movie, scenes };
}

function maxZ(scene) {
  let z = 0;
  const bump = (e) => { if (e && e.z > z) z = e.z; };
  bump(scene.bg);
  scene.chars.forEach(bump); scene.props.forEach(bump); scene.effects.forEach(bump);
  return z;
}

/** Re-id a scene deeply (used by duplicateScene). Bubble targets are remapped. */
function reidScene(scene) {
  const c = clone(scene);
  const map = new Map();
  const re = (e) => { const id = nextId('e'); map.set(e.id, id); e.id = id; };
  if (c.bg) re(c.bg);
  c.chars.forEach(re); c.props.forEach(re); c.effects.forEach(re);
  c.id = nextId('sc');
  for (const b of c.bubbles) { b.id = nextId('b'); if (b.targetId) b.targetId = map.get(b.targetId); }
  return c;
}

/** Make a scene valid after external edits (duration, times). */
function normalizeScene(s) {
  return s.duration >= MIN_SCENE_MS ? s : { ...s, duration: MIN_SCENE_MS };
}

const SOUND_RIPPLE = new Set(['addScene', 'removeScene', 'duplicateScene', 'moveScene', 'setSceneProps']);

/**
 * Sound rule: SoundClips are movie-absolute but anchored to the scene that contains their `start`.
 * When scenes are added/moved/resized/removed/duplicated, a clip shifts by how far its anchor scene's
 * start moved (length preserved). Clips starting past the end of the movie are not anchored and stay.
 *  - removeScene: clips anchored in the removed scene and lying entirely inside it are deleted; the ones
 *    that run past it start where the next scene now begins and keep their remaining tail.
 *  - duplicateScene: clips anchored in the scene and lying entirely inside it are copied into the copy.
 * @param {Movie} before @param {Movie} after
 * @param {{type:string, sceneId?:string}} cmd
 * @returns {Movie}
 */
export function rippleSounds(before, after, cmd) {
  if (!before.sounds.length || before === after) return after;
  const oldStarts = new Map(); const oldDur = new Map();
  let t = 0;
  for (const s of before.scenes) { oldStarts.set(s.id, t); oldDur.set(s.id, s.duration); t += s.duration; }
  const total = t;
  const newStarts = new Map();
  t = 0;
  for (const s of after.scenes) { newStarts.set(s.id, t); t += s.duration; }
  const anchorOf = (clip) => {
    if (clip.start >= total) return null;
    for (const s of before.scenes) {
      const a = oldStarts.get(s.id);
      if (clip.start >= a && clip.start < a + s.duration) return s.id;
    }
    return null;
  };
  const out = [];
  const extra = [];
  for (const c of before.sounds) {
    const id = anchorOf(c);
    if (!id) { out.push(c); continue; }
    const a = oldStarts.get(id); const d = oldDur.get(id);
    if (cmd.type === 'removeScene' && id === cmd.sceneId) {
      if (c.end <= a + d) continue;
      // the next scene now begins where the removed one began
      out.push({ ...c, start: a, end: a + (c.end - (a + d)), offset: (c.offset ?? 0) + (a + d - c.start) });
      continue;
    }
    if (cmd.type === 'duplicateScene' && id === cmd.sceneId && c.end <= a + d) {
      extra.push({ ...clone(c), id: nextId('s'), start: c.start + d, end: c.end + d });
    }
    const na = newStarts.get(id);
    const shift = na === undefined ? 0 : na - a;
    out.push(shift ? { ...c, start: c.start + shift, end: c.end + shift } : c);
  }
  return { ...after, sounds: [...out, ...extra] };
}

/** Produce the next movie for an undoable command. Returns the same reference if nothing changed. */
function reduceMovie(movie, cmd, ctx) {
  const next = reduceCore(movie, cmd, ctx);
  if (next === movie || !SOUND_RIPPLE.has(cmd.type)) return next;
  if (cmd.type === 'setSceneProps' && !(cmd.patch && 'duration' in cmd.patch)) return next;
  return rippleSounds(movie, next, cmd);
}

function reduceCore(movie, cmd, ctx) {
  switch (cmd.type) {
    case 'addScene': {
      const scene = cmd.scene ? { ...createScene(), ...clone(cmd.scene) } : createScene();
      if (cmd.scene && !cmd.scene.id) scene.id = nextId('sc');
      if (movie.scenes.some((s) => s.id === scene.id)) scene.id = nextId('sc');
      const idx = Math.max(0, Math.min(movie.scenes.length, cmd.index ?? movie.scenes.length));
      const scenes = [...movie.scenes];
      scenes.splice(idx, 0, normalizeScene(scene));
      ctx.select = { sceneId: scene.id, elemId: null, kind: 'scene' };
      return { ...movie, scenes };
    }
    case 'removeScene': {
      const i = movie.scenes.findIndex((s) => s.id === cmd.sceneId);
      if (i < 0) return movie;
      let scenes = movie.scenes.filter((s) => s.id !== cmd.sceneId);
      if (!scenes.length) scenes = [createScene()];
      const near = scenes[Math.min(i, scenes.length - 1)];
      ctx.select = { sceneId: near.id, elemId: null, kind: 'scene' };
      return { ...movie, scenes };
    }
    case 'duplicateScene': {
      const i = movie.scenes.findIndex((s) => s.id === cmd.sceneId);
      if (i < 0) return movie;
      const copy = reidScene(movie.scenes[i]);
      const scenes = [...movie.scenes];
      scenes.splice(i + 1, 0, copy);
      ctx.select = { sceneId: copy.id, elemId: null, kind: 'scene' };
      return { ...movie, scenes };
    }
    case 'moveScene': {
      const from = movie.scenes.findIndex((s) => s.id === cmd.sceneId);
      if (from < 0) return movie;
      const to = Math.max(0, Math.min(movie.scenes.length - 1, cmd.toIndex | 0));
      if (to === from) return movie;
      const scenes = [...movie.scenes];
      const [s] = scenes.splice(from, 1);
      scenes.splice(to, 0, s);
      return { ...movie, scenes };
    }
    case 'setSceneProps':
      return withScene(movie, cmd.sceneId, (s) => {
        const patch = cleanPatch(cmd.patch);
        for (const k of ['chars', 'props', 'effects', 'bubbles', 'bg']) delete patch[k]; // use dedicated commands
        if ('duration' in patch) patch.duration = Math.max(MIN_SCENE_MS, Math.round(patch.duration));
        return normalizeScene({ ...s, ...patch });
      });
    case 'setBackground':
      return withScene(movie, cmd.sceneId, (s) => {
        if (!cmd.assetId) {
          if (!s.bg) return false;
          s.bg = null;
          return s;
        }
        s.bg = createElem(cmd.assetId, { x: STAGE_W / 2, y: STAGE_H / 2, z: 0, ...cleanPatch(cmd.patch), id: s.bg?.id ?? nextId('e') });
        ctx.select = { sceneId: s.id, elemId: s.bg.id, kind: 'bg' };
        return s;
      });
    case 'addElem': {
      const list = ELEM_LISTS[cmd.kind];
      if (!list) return movie;
      return withScene(movie, cmd.sceneId, (s) => {
        const e = createElem(cmd.assetId, {
          x: num(cmd.x, STAGE_W / 2), y: num(cmd.y, STAGE_H / 2), z: maxZ(s) + 1, ...cleanPatch(cmd.elem),
        });
        if (cmd.kind === 'char' && s.chars.length === 0 && cmd.x == null) e.y = Math.round(STAGE_H * 0.85);
        s[list].push(e);
        ctx.select = { sceneId: s.id, elemId: e.id, kind: cmd.kind };
        ctx.created = e.id;
        return s;
      });
    }
    case 'updateElem':
      return withScene(movie, cmd.sceneId, (s) => {
        const hit = findElem(s, cmd.elemId);
        if (!hit) return false;
        const patch = cleanPatch(cmd.patch);
        const e = { ...hit.elem, ...patch };
        if (hit.kind === 'bg') s.bg = e;
        else {
          const list = s[ELEM_LISTS[hit.kind]];
          list[list.findIndex((x) => x.id === e.id)] = e;
        }
        return s;
      });
    case 'removeElem':
      return withScene(movie, cmd.sceneId, (s) => {
        const hit = findElem(s, cmd.elemId);
        if (!hit) return false;
        if (hit.kind === 'bg') s.bg = null;
        else s[ELEM_LISTS[hit.kind]] = s[ELEM_LISTS[hit.kind]].filter((x) => x.id !== cmd.elemId);
        s.bubbles = s.bubbles.map((b) => (b.targetId === cmd.elemId ? { ...b, targetId: undefined } : b));
        if (ctx.state.selection.elemId === cmd.elemId) ctx.select = { sceneId: s.id, elemId: null, kind: 'scene' };
        return s;
      });
    case 'reorderElem':
      // {sceneId, elemId, to: 'front'|'back'|'forward'|'backward'|<number z>}
      return withScene(movie, cmd.sceneId, (s) => {
        const hit = findElem(s, cmd.elemId);
        if (!hit || hit.kind === 'bg') return false;
        const all = [...s.props, ...s.chars, ...s.effects].sort((a, b) => a.z - b.z);
        const idx = all.findIndex((e) => e.id === cmd.elemId);
        let order = all.map((e) => e.id);
        order.splice(idx, 1);
        const t = cmd.to;
        let at;
        if (t === 'front') at = order.length;
        else if (t === 'back') at = 0;
        else if (t === 'forward') at = Math.min(order.length, idx + 1);
        else if (t === 'backward') at = Math.max(0, idx - 1);
        else at = Math.max(0, Math.min(order.length, Math.round(num(t, idx))));
        order.splice(at, 0, cmd.elemId);
        const zOf = new Map(order.map((id, i) => [id, i + 1]));
        let changed = false;
        for (const key of ['props', 'chars', 'effects']) {
          s[key] = s[key].map((e) => {
            const z = zOf.get(e.id);
            if (z === e.z) return e;
            changed = true;
            return { ...e, z };
          });
        }
        return changed ? s : false;
      });
    case 'addBubble':
      return withScene(movie, cmd.sceneId, (s) => {
        const b = createBubble({ start: 0, end: s.duration, ...cleanPatch(cmd.bubble) });
        if (cmd.x != null) b.x = cmd.x;
        if (cmd.y != null) b.y = cmd.y;
        if (cmd.text != null) b.text = cmd.text;
        if (cmd.targetId) b.targetId = cmd.targetId;
        s.bubbles.push(b);
        ctx.select = { sceneId: s.id, elemId: b.id, kind: 'bubble' };
        ctx.created = b.id;
        return s;
      });
    case 'updateBubble':
      return withScene(movie, cmd.sceneId, (s) => {
        const i = s.bubbles.findIndex((b) => b.id === (cmd.bubbleId ?? cmd.elemId));
        if (i < 0) return false;
        s.bubbles[i] = { ...s.bubbles[i], ...cleanPatch(cmd.patch) };
        return s;
      });
    case 'removeBubble':
      return withScene(movie, cmd.sceneId, (s) => {
        const id = cmd.bubbleId ?? cmd.elemId;
        if (!s.bubbles.some((b) => b.id === id)) return false;
        s.bubbles = s.bubbles.filter((b) => b.id !== id);
        if (ctx.state.selection.elemId === id) ctx.select = { sceneId: s.id, elemId: null, kind: 'scene' };
        return s;
      });
    case 'addSound': {
      const sound = createSound({ ...cleanPatch(cmd.sound) });
      if (movie.sounds.some((x) => x.id === sound.id)) sound.id = nextId('s');
      if (sound.end <= sound.start) sound.end = sound.start + 1000;
      ctx.created = sound.id;
      ctx.select = { sceneId: ctx.state.selection.sceneId, elemId: sound.id, kind: 'sound' };
      return { ...movie, sounds: [...movie.sounds, sound] };
    }
    case 'updateSound': {
      const id = cmd.soundId ?? cmd.elemId;
      const i = movie.sounds.findIndex((x) => x.id === id);
      if (i < 0) return movie;
      const patch = cleanPatch(cmd.patch);
      if ('volume' in patch) patch.volume = Math.max(0, Math.min(1, patch.volume));
      const sounds = [...movie.sounds];
      sounds[i] = { ...sounds[i], ...patch };
      return { ...movie, sounds };
    }
    case 'removeSound': {
      const id = cmd.soundId ?? cmd.elemId;
      if (!movie.sounds.some((x) => x.id === id)) return movie;
      if (ctx.state.selection.elemId === id) ctx.select = { sceneId: ctx.state.selection.sceneId, elemId: null, kind: 'scene' };
      return { ...movie, sounds: movie.sounds.filter((x) => x.id !== id) };
    }
    case 'setTitle': {
      const title = String(cmd.title ?? '');
      return title === movie.title ? movie : { ...movie, title };
    }
    case 'setTheme':
      return cmd.themeId && cmd.themeId !== movie.themeId ? { ...movie, themeId: String(cmd.themeId) } : movie;
    default:
      return movie;
  }
}

const MOVIE_COMMANDS = new Set([
  'addScene', 'removeScene', 'duplicateScene', 'moveScene', 'setSceneProps', 'setBackground', 'addElem',
  'updateElem', 'removeElem', 'reorderElem', 'addBubble', 'updateBubble', 'removeBubble', 'addSound',
  'updateSound', 'removeSound', 'setTitle', 'setTheme',
]);

function initialSelection(movie) {
  return { sceneId: movie.scenes[0]?.id ?? null, elemId: null, kind: movie.scenes.length ? 'scene' : null };
}

/** Make sure a selection still points at something that exists. */
function fixSelection(movie, sel) {
  let { sceneId, elemId, kind } = sel;
  let scene = findScene(movie, sceneId);
  if (!scene) {
    scene = movie.scenes[0] ?? null;
    return { sceneId: scene?.id ?? null, elemId: null, kind: scene ? 'scene' : null };
  }
  if (elemId) {
    const ok = kind === 'sound' ? movie.sounds.some((s) => s.id === elemId)
      : kind === 'bubble' ? scene.bubbles.some((b) => b.id === elemId)
        : !!findElem(scene, elemId);
    if (!ok) return { sceneId, elemId: null, kind: 'scene' };
  }
  return sel;
}

/**
 * @param {Movie} [initialMovie]
 * @returns {{get():StudioState, subscribe(fn:Function):()=>void, dispatch(cmd:object):boolean, undo():boolean,
 *   redo():boolean, canUndo():boolean, canRedo():boolean, markSaved():void, isDirty():boolean}}
 */
export function createStore(initialMovie) {
  const first = initialMovie ?? createMovie();
  /** @type {StudioState} */
  let state = { movie: first, selection: initialSelection(first), playhead: 0, playing: false, zoom: 80 };
  let savedMovie = first;
  /** @type {{movie:Movie, selection:object}[]} */
  let past = [];
  /** @type {{movie:Movie, selection:object}[]} */
  let future = [];
  let lastCoalesce = null;
  const subs = new Set();

  function emit(next, cmd) {
    const prev = state;
    state = next;
    for (const fn of [...subs]) {
      try { fn(state, cmd, prev); } catch (e) { console.error('[studio store] subscriber failed', e); }
    }
  }

  function pushHistory(entry, coalesce) {
    if (coalesce && coalesce === lastCoalesce && past.length) {
      // same drag: keep the oldest snapshot as the undo target
    } else {
      past.push(entry);
      if (past.length > HISTORY_LIMIT) past.shift();
    }
    lastCoalesce = coalesce || null;
    future = [];
  }

  function applyUi(cmd) {
    const s = state;
    switch (cmd.type) {
      case 'select': {
        const sceneId = cmd.sceneId === undefined ? s.selection.sceneId : cmd.sceneId;
        const sel = fixSelection(s.movie, {
          sceneId, elemId: cmd.elemId ?? null, kind: cmd.kind ?? (cmd.elemId ? s.selection.kind : sceneId ? 'scene' : null),
        });
        let playhead = s.playhead;
        if (sel.sceneId !== s.selection.sceneId && !cmd.keepPlayhead && !s.playing) {
          const st = sceneStart(s.movie, sel.sceneId);
          if (st >= 0) playhead = st;
        }
        if (sel.sceneId === s.selection.sceneId && sel.elemId === s.selection.elemId && sel.kind === s.selection.kind && playhead === s.playhead) return s;
        return { ...s, selection: sel, playhead };
      }
      case 'setPlayhead': {
        const ms = Math.max(0, Math.min(movieDuration(s.movie), num(cmd.ms, s.playhead)));
        const at = sceneAt(s.movie, ms);
        let selection = s.selection;
        if (at && at.scene.id !== selection.sceneId) {
          // a selected sound clip is movie-wide: it stays selected when the playhead crosses scenes
          selection = selection.kind === 'sound' ? { ...selection, sceneId: at.scene.id } : { sceneId: at.scene.id, elemId: null, kind: 'scene' };
        }
        if (ms === s.playhead && selection === s.selection) return s;
        return { ...s, playhead: ms, selection };
      }
      case 'setPlaying':
        return !!cmd.playing === s.playing ? s : { ...s, playing: !!cmd.playing };
      case 'setZoom': {
        const zoom = Math.max(10, Math.min(600, num(cmd.zoom, s.zoom)));
        return zoom === s.zoom ? s : { ...s, zoom };
      }
      default:
        return s;
    }
  }

  function runMovieCommand(cmd, ctx) {
    if (cmd.type === 'batch') {
      let m = state.movie;
      for (const c of cmd.cmds ?? []) {
        if (c.type === 'batch' || !MOVIE_COMMANDS.has(c.type)) continue;
        m = reduceMovie(m, c, ctx);
        ctx.state = { ...ctx.state, movie: m, selection: ctx.select ? fixSelection(m, ctx.select) : ctx.state.selection };
      }
      return m;
    }
    return reduceMovie(state.movie, cmd, ctx);
  }

  const api = {
    get: () => state,

    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },

    /** @returns {boolean} whether state changed */
    dispatch(cmd) {
      if (!cmd || typeof cmd.type !== 'string') return false;
      if (UI_COMMANDS.has(cmd.type)) {
        const next = applyUi(cmd);
        if (next === state) return false;
        emit(next, cmd);
        return true;
      }
      if (cmd.type === 'loadMovie') {
        const movie = cmd.movie?.scenes?.length ? cmd.movie : { ...(cmd.movie ?? createMovie()), scenes: [createScene()] };
        past = []; future = []; lastCoalesce = null;
        savedMovie = movie;
        emit({ ...state, movie, selection: initialSelection(movie), playhead: 0, playing: false }, cmd);
        return true;
      }
      if (cmd.type !== 'batch' && !MOVIE_COMMANDS.has(cmd.type)) return false;
      const ctx = { state, select: null, created: null };
      const before = state.movie;
      const movie = runMovieCommand(cmd, ctx);
      if (movie === before) return false;
      pushHistory({ movie: before, selection: state.selection }, cmd.coalesce);
      let selection = ctx.select ?? state.selection;
      selection = fixSelection(movie, selection);
      const total = movieDuration(movie);
      const playhead = Math.min(state.playhead, total);
      emit({ ...state, movie, selection, playhead }, cmd);
      return true;
    },

    undo() {
      const e = past.pop();
      if (!e) return false;
      future.push({ movie: state.movie, selection: state.selection });
      lastCoalesce = null;
      emit({ ...state, movie: e.movie, selection: fixSelection(e.movie, e.selection), playhead: Math.min(state.playhead, movieDuration(e.movie)) }, { type: 'undo' });
      return true;
    },

    redo() {
      const e = future.pop();
      if (!e) return false;
      past.push({ movie: state.movie, selection: state.selection });
      lastCoalesce = null;
      emit({ ...state, movie: e.movie, selection: fixSelection(e.movie, e.selection), playhead: Math.min(state.playhead, movieDuration(e.movie)) }, { type: 'redo' });
      return true;
    },

    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
    markSaved() { savedMovie = state.movie; emit({ ...state }, { type: 'markSaved' }); },
    isDirty: () => state.movie !== savedMovie,

    /** Id created by the most recent add* command is available via selection; helper for callers. */
    selectedElem() {
      const { movie, selection } = state;
      return findElem(findScene(movie, selection.sceneId), selection.elemId);
    },
  };
  return api;
}
