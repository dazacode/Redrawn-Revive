import { beforeEach, describe, expect, test } from "bun:test";
import { studio } from "./studio-helpers.ts";

const { createStore } = await studio("store");
const M = await studio("model");
const { seedIds } = await studio("ids");

beforeEach(() => seedIds(0));

function fresh() {
  const store = createStore(M.createMovie());
  return { store, sid: () => store.get().movie.scenes[0].id as string };
}

describe("store basics", () => {
  test("initial state", () => {
    const { store } = fresh();
    const s = store.get();
    expect(s.movie.scenes.length).toBe(1);
    expect(s.selection.sceneId).toBe(s.movie.scenes[0].id);
    expect(s.playhead).toBe(0);
    expect(store.canUndo()).toBe(false);
    expect(store.isDirty()).toBe(false);
  });

  test("subscribe/unsubscribe and notification payload", () => {
    const { store } = fresh();
    const seen: string[] = [];
    const un = store.subscribe((_s: unknown, cmd: { type: string }) => seen.push(cmd.type));
    store.dispatch({ type: "setTitle", title: "A" });
    un();
    store.dispatch({ type: "setTitle", title: "B" });
    expect(seen).toEqual(["setTitle"]);
  });

  test("no-op commands do not notify or create history", () => {
    const { store } = fresh();
    let n = 0;
    store.subscribe(() => n++);
    expect(store.dispatch({ type: "setTitle", title: store.get().movie.title })).toBe(false);
    expect(store.dispatch({ type: "nope" })).toBe(false);
    expect(store.dispatch({ type: "updateElem", sceneId: "x", elemId: "y", patch: {} })).toBe(false);
    expect(n).toBe(0);
    expect(store.canUndo()).toBe(false);
  });

  test("a subscriber that throws does not break others", () => {
    const { store } = fresh();
    let ok = false;
    const orig = console.error;
    console.error = () => {};
    store.subscribe(() => { throw new Error("boom"); });
    store.subscribe(() => { ok = true; });
    store.dispatch({ type: "setTitle", title: "Z" });
    console.error = orig;
    expect(ok).toBe(true);
  });
});

describe("scenes", () => {
  test("add, move, duplicate, remove", () => {
    const { store, sid } = fresh();
    const first = sid();
    store.dispatch({ type: "addScene" });
    store.dispatch({ type: "addScene", index: 0 });
    const ids = store.get().movie.scenes.map((s: { id: string }) => s.id);
    expect(ids.length).toBe(3);
    expect(ids[1]).toBe(first);
    store.dispatch({ type: "moveScene", sceneId: first, toIndex: 2 });
    expect(store.get().movie.scenes[2].id).toBe(first);
    store.dispatch({ type: "setBackground", sceneId: first, assetId: "common.a_bg.swf" });
    store.dispatch({ type: "addElem", sceneId: first, kind: "char", assetId: "common.c.stand.swf" });
    const ch = store.get().movie.scenes[2].chars[0];
    store.dispatch({ type: "addBubble", sceneId: first, bubble: { text: "hi", targetId: ch.id } });
    store.dispatch({ type: "duplicateScene", sceneId: first });
    const s = store.get().movie.scenes;
    expect(s.length).toBe(4);
    const copy = s[3];
    expect(copy.id).not.toBe(first);
    expect(copy.bg.id).not.toBe(s[2].bg.id);
    expect(copy.bubbles[0].targetId).toBe(copy.chars[0].id);
    expect(store.get().selection.sceneId).toBe(copy.id);
    store.dispatch({ type: "removeScene", sceneId: copy.id });
    expect(store.get().movie.scenes.length).toBe(3);
  });

  test("removing the last scene leaves an empty one", () => {
    const { store, sid } = fresh();
    store.dispatch({ type: "removeScene", sceneId: sid() });
    expect(store.get().movie.scenes.length).toBe(1);
    expect(store.get().selection.sceneId).toBe(store.get().movie.scenes[0].id);
  });

  test("setSceneProps clamps duration and ignores structural keys", () => {
    const { store, sid } = fresh();
    store.dispatch({ type: "setSceneProps", sceneId: sid(), patch: { duration: 10, chars: ["bad"], transitionOut: "t.swf" } });
    const s = store.get().movie.scenes[0];
    expect(s.duration).toBe(M.MIN_SCENE_MS);
    expect(s.chars).toEqual([]);
    expect(s.transitionOut).toBe("t.swf");
  });
});

describe("elements", () => {
  test("addElem assigns increasing z, selects and sanitizes patches", () => {
    const { store, sid } = fresh();
    const id = sid();
    store.dispatch({ type: "addElem", sceneId: id, kind: "prop", assetId: "common.p.swf", x: 10, y: 20 });
    store.dispatch({ type: "addElem", sceneId: id, kind: "char", assetId: "common.c.stand.swf" });
    const sc = store.get().movie.scenes[0];
    expect(sc.props[0]).toMatchObject({ x: 10, y: 20 });
    expect(sc.chars[0].z).toBeGreaterThan(sc.props[0].z);
    expect(store.get().selection).toMatchObject({ elemId: sc.chars[0].id, kind: "char" });
    store.dispatch({ type: "updateElem", sceneId: id, elemId: sc.chars[0].id, patch: { x: NaN, id: "hax", y: 5 } });
    const c = store.get().movie.scenes[0].chars[0];
    expect(c.id).toBe(sc.chars[0].id);
    expect(c.x).toBe(sc.chars[0].x);
    expect(c.y).toBe(5);
  });

  test("unknown kinds are rejected", () => {
    const { store, sid } = fresh();
    expect(store.dispatch({ type: "addElem", sceneId: sid(), kind: "bubble", assetId: "x" })).toBe(false);
  });

  test("setBackground replaces and clears", () => {
    const { store, sid } = fresh();
    store.dispatch({ type: "setBackground", sceneId: sid(), assetId: "common.a.swf" });
    const bgId = store.get().movie.scenes[0].bg.id;
    store.dispatch({ type: "setBackground", sceneId: sid(), assetId: "common.b.swf" });
    expect(store.get().movie.scenes[0].bg).toMatchObject({ id: bgId, assetId: "common.b.swf" });
    store.dispatch({ type: "setBackground", sceneId: sid(), assetId: null });
    expect(store.get().movie.scenes[0].bg).toBeNull();
    expect(store.dispatch({ type: "setBackground", sceneId: sid(), assetId: null })).toBe(false);
  });

  test("removeElem clears selection and bubble targets", () => {
    const { store, sid } = fresh();
    store.dispatch({ type: "addElem", sceneId: sid(), kind: "char", assetId: "common.c.stand.swf" });
    const c = store.get().movie.scenes[0].chars[0];
    store.dispatch({ type: "addBubble", sceneId: sid(), bubble: { targetId: c.id } });
    store.dispatch({ type: "select", elemId: c.id, kind: "char" });
    store.dispatch({ type: "removeElem", sceneId: sid(), elemId: c.id });
    expect(store.get().selection.elemId).toBeNull();
    expect(store.get().movie.scenes[0].bubbles[0].targetId).toBeUndefined();
  });

  test("reorderElem front/back/forward/backward", () => {
    const { store, sid } = fresh();
    for (const a of ["a", "b", "c"]) store.dispatch({ type: "addElem", sceneId: sid(), kind: "prop", assetId: `common.${a}.swf` });
    const ids = () => [...store.get().movie.scenes[0].props].sort((p: { z: number }, q: { z: number }) => p.z - q.z).map((p: { assetId: string }) => p.assetId.split(".")[1]);
    const a = store.get().movie.scenes[0].props[0].id;
    expect(ids()).toEqual(["a", "b", "c"]);
    store.dispatch({ type: "reorderElem", sceneId: sid(), elemId: a, to: "front" });
    expect(ids()).toEqual(["b", "c", "a"]);
    store.dispatch({ type: "reorderElem", sceneId: sid(), elemId: a, to: "backward" });
    expect(ids()).toEqual(["b", "a", "c"]);
    store.dispatch({ type: "reorderElem", sceneId: sid(), elemId: a, to: "back" });
    expect(ids()).toEqual(["a", "b", "c"]);
    store.dispatch({ type: "reorderElem", sceneId: sid(), elemId: a, to: "forward" });
    expect(ids()).toEqual(["b", "a", "c"]);
  });

  test("bubbles and sounds", () => {
    const { store, sid } = fresh();
    store.dispatch({ type: "addBubble", sceneId: sid(), text: "yo", x: 50, y: 60 });
    const b = store.get().movie.scenes[0].bubbles[0];
    expect(b).toMatchObject({ text: "yo", x: 50, y: 60, end: 3000 });
    store.dispatch({ type: "updateBubble", sceneId: sid(), bubbleId: b.id, patch: { text: "new" } });
    expect(store.get().movie.scenes[0].bubbles[0].text).toBe("new");
    store.dispatch({ type: "removeBubble", sceneId: sid(), bubbleId: b.id });
    expect(store.get().movie.scenes[0].bubbles.length).toBe(0);
    store.dispatch({ type: "addSound", sound: { kind: "voice", assetId: "ugc.a.mp3", start: 100, end: 100 } });
    const s = store.get().movie.sounds[0];
    expect(s.end).toBeGreaterThan(s.start);
    store.dispatch({ type: "updateSound", soundId: s.id, patch: { volume: 5 } });
    expect(store.get().movie.sounds[0].volume).toBe(1);
    store.dispatch({ type: "removeSound", soundId: s.id });
    expect(store.get().movie.sounds.length).toBe(0);
  });

  test("setTheme/setTitle", () => {
    const { store } = fresh();
    store.dispatch({ type: "setTheme", themeId: "anime" });
    store.dispatch({ type: "setTitle", title: "T" });
    expect(store.get().movie).toMatchObject({ themeId: "anime", title: "T" });
  });
});

describe("history", () => {
  test("undo/redo restore movie and clear redo on new edits", () => {
    const { store } = fresh();
    store.dispatch({ type: "setTitle", title: "1" });
    store.dispatch({ type: "setTitle", title: "2" });
    expect(store.undo()).toBe(true);
    expect(store.get().movie.title).toBe("1");
    expect(store.canRedo()).toBe(true);
    store.redo();
    expect(store.get().movie.title).toBe("2");
    store.undo();
    store.dispatch({ type: "setTitle", title: "3" });
    expect(store.canRedo()).toBe(false);
    expect(store.undo()).toBe(true);
    expect(store.undo()).toBe(true);
    expect(store.undo()).toBe(false);
    expect(store.get().movie.title).toBe("Untitled");
  });

  test("coalesce: a drag is one undo step", () => {
    const { store, sid } = fresh();
    store.dispatch({ type: "addElem", sceneId: sid(), kind: "prop", assetId: "common.p.swf", x: 0, y: 0 });
    const e = store.get().movie.scenes[0].props[0];
    for (let i = 1; i <= 20; i++) store.dispatch({ type: "updateElem", sceneId: sid(), elemId: e.id, patch: { x: i }, coalesce: `drag-${e.id}` });
    expect(store.get().movie.scenes[0].props[0].x).toBe(20);
    store.undo();
    expect(store.get().movie.scenes[0].props[0].x).toBe(0);
    store.undo();
    expect(store.get().movie.scenes[0].props.length).toBe(0);
  });

  test("a different coalesce key or interleaved command starts a new step", () => {
    const { store, sid } = fresh();
    store.dispatch({ type: "addElem", sceneId: sid(), kind: "prop", assetId: "common.p.swf", x: 0, y: 0 });
    const e = store.get().movie.scenes[0].props[0];
    store.dispatch({ type: "updateElem", sceneId: sid(), elemId: e.id, patch: { x: 1 }, coalesce: "drag-a" });
    store.dispatch({ type: "updateElem", sceneId: sid(), elemId: e.id, patch: { x: 2 }, coalesce: "drag-b" });
    store.dispatch({ type: "setTitle", title: "mid" });
    store.dispatch({ type: "updateElem", sceneId: sid(), elemId: e.id, patch: { x: 3 }, coalesce: "drag-b" });
    store.undo();
    expect(store.get().movie.scenes[0].props[0].x).toBe(2);
    store.undo(); store.undo();
    expect(store.get().movie.scenes[0].props[0].x).toBe(1);
  });

  test("undo keeps selection valid", () => {
    const { store, sid } = fresh();
    store.dispatch({ type: "addScene" });
    const added = store.get().selection.sceneId;
    expect(added).not.toBe(sid());
    store.undo();
    expect(store.get().selection.sceneId).toBe(sid());
  });

  test("isDirty tracks the saved snapshot, even through undo", () => {
    const { store } = fresh();
    store.dispatch({ type: "setTitle", title: "x" });
    expect(store.isDirty()).toBe(true);
    store.markSaved();
    expect(store.isDirty()).toBe(false);
    store.dispatch({ type: "setTitle", title: "y" });
    expect(store.isDirty()).toBe(true);
    store.undo();
    expect(store.isDirty()).toBe(false);
  });

  test("history is capped", () => {
    const { store } = fresh();
    for (let i = 0; i < 300; i++) store.dispatch({ type: "setTitle", title: `t${i}` });
    let n = 0;
    while (store.undo()) n++;
    expect(n).toBe(200);
  });

  test("batch is one undo step", () => {
    const { store, sid } = fresh();
    store.dispatch({
      type: "batch",
      cmds: [
        { type: "setBackground", sceneId: sid(), assetId: "common.bg.swf" },
        { type: "addElem", sceneId: sid(), kind: "prop", assetId: "common.p.swf" },
        { type: "addElem", sceneId: sid(), kind: "prop", assetId: "common.q.swf" },
      ],
    });
    expect(store.get().movie.scenes[0].props.length).toBe(2);
    store.undo();
    expect(store.get().movie.scenes[0].props.length).toBe(0);
    expect(store.get().movie.scenes[0].bg).toBeNull();
  });

  test("loadMovie resets history and selection", () => {
    const { store } = fresh();
    store.dispatch({ type: "setTitle", title: "x" });
    const m = M.createMovie({ title: "Loaded" });
    store.dispatch({ type: "loadMovie", movie: m });
    expect(store.canUndo()).toBe(false);
    expect(store.isDirty()).toBe(false);
    expect(store.get().movie.title).toBe("Loaded");
    expect(store.get().selection.sceneId).toBe(m.scenes[0].id);
  });

  test("loadMovie with no scenes gets one", () => {
    const { store } = fresh();
    store.dispatch({ type: "loadMovie", movie: { ...M.createMovie(), scenes: [] } });
    expect(store.get().movie.scenes.length).toBe(1);
  });
});

describe("structural sharing", () => {
  test("untouched scenes keep identity across edits", () => {
    const { store, sid } = fresh();
    store.dispatch({ type: "addScene" });
    const before = store.get().movie.scenes;
    store.dispatch({ type: "addElem", sceneId: sid(), kind: "prop", assetId: "common.p.swf" });
    const after = store.get().movie.scenes;
    expect(after[1]).toBe(before[1]);
    expect(after[0]).not.toBe(before[0]);
  });
});

describe("ui commands", () => {
  function three() {
    const { store } = fresh();
    store.dispatch({ type: "addScene" });
    store.dispatch({ type: "addScene" });
    store.dispatch({ type: "setPlayhead", ms: 0 });
    return store;
  }

  test("ui commands are not undoable and do not dirty", () => {
    const store = three();
    store.markSaved();
    store.dispatch({ type: "setPlayhead", ms: 4000 });
    store.dispatch({ type: "setPlaying", playing: true });
    store.dispatch({ type: "setZoom", zoom: 1e9 });
    expect(store.isDirty()).toBe(false);
    expect(store.get().zoom).toBe(600);
    store.dispatch({ type: "setPlaying", playing: false });
    const n = [store.canUndo()];
    store.undo(); store.undo(); store.undo();
    expect(n[0]).toBe(true);
    expect(store.get().movie.scenes.length).toBe(1);
  });

  test("setPlayhead clamps and moves the selected scene", () => {
    const store = three();
    store.dispatch({ type: "setPlayhead", ms: 4000 });
    expect(store.get().selection.sceneId).toBe(store.get().movie.scenes[1].id);
    store.dispatch({ type: "setPlayhead", ms: 1e9 });
    expect(store.get().playhead).toBe(9000);
    store.dispatch({ type: "setPlayhead", ms: -5 });
    expect(store.get().playhead).toBe(0);
    expect(store.get().selection.sceneId).toBe(store.get().movie.scenes[0].id);
  });

  test("select moves playhead to the scene start unless told not to", () => {
    const store = three();
    const [, s2, s3] = store.get().movie.scenes;
    store.dispatch({ type: "select", sceneId: s2.id });
    expect(store.get().playhead).toBe(3000);
    store.dispatch({ type: "select", sceneId: s3.id, keepPlayhead: true });
    expect(store.get().playhead).toBe(3000);
    expect(store.get().selection.sceneId).toBe(s3.id);
  });

  test("select ignores ids that do not exist", () => {
    const store = three();
    store.dispatch({ type: "select", sceneId: "nope" });
    expect(store.get().selection.sceneId).toBe(store.get().movie.scenes[0].id);
    store.dispatch({ type: "select", elemId: "nope", kind: "char" });
    expect(store.get().selection.elemId).toBeNull();
  });

  test("playhead is clamped when the movie shrinks", () => {
    const store = three();
    store.dispatch({ type: "setPlayhead", ms: 8000 });
    const last = store.get().movie.scenes[2];
    store.dispatch({ type: "removeScene", sceneId: last.id });
    expect(store.get().playhead).toBe(6000);
  });
});

describe("sound ripple rule", () => {
  function three() {
    const store = createStore(M.createMovie({ scenes: [M.createScene({ duration: 2000 }), M.createScene({ duration: 3000 }), M.createScene({ duration: 4000 })] }));
    const ids = store.get().movie.scenes.map((s: any) => s.id as string);
    return { store, ids };
  }
  const add = (store: any, start: number, end: number) => {
    store.dispatch({ type: "addSound", sound: { start, end, assetId: "x.mp3" } });
    return store.get().movie.sounds.at(-1).id as string;
  };
  const clip = (store: any, id: string) => store.get().movie.sounds.find((c: any) => c.id === id);

  test("resize shifts clips anchored in later scenes only", () => {
    const { store, ids } = three();
    const a = add(store, 500, 1500), b = add(store, 2500, 3500), c = add(store, 5500, 6000);
    store.dispatch({ type: "setSceneProps", sceneId: ids[0], patch: { duration: 3000 } });
    expect([clip(store, a).start, clip(store, b).start, clip(store, b).end, clip(store, c).start]).toEqual([500, 3500, 4500, 6500]);
    store.undo();
    expect(clip(store, b).start).toBe(2500);
  });
  test("move reorders clips with their scene", () => {
    const { store, ids } = three();
    const a = add(store, 100, 900), b = add(store, 2100, 2900);
    store.dispatch({ type: "moveScene", sceneId: ids[1], toIndex: 0 });
    expect(clip(store, b).start).toBe(100);
    expect(clip(store, a).start).toBe(3100);
  });
  test("remove deletes contained clips, trims spanning ones, ripples later ones", () => {
    const { store, ids } = three();
    const inside = add(store, 2100, 2900), span = add(store, 2500, 6000), later = add(store, 6000, 7000);
    store.dispatch({ type: "removeScene", sceneId: ids[1] });
    expect(clip(store, inside)).toBeUndefined();
    expect(clip(store, span)).toMatchObject({ start: 2000, end: 3000, offset: 2500 });
    expect(clip(store, later).start).toBe(3000);
  });
  test("duplicate copies contained clips and ripples later ones", () => {
    const { store, ids } = three();
    add(store, 2100, 2900); const later = add(store, 6000, 7000);
    store.dispatch({ type: "duplicateScene", sceneId: ids[1] });
    const sounds = store.get().movie.sounds;
    expect(sounds.length).toBe(3);
    expect(sounds.some((c: any) => c.start === 5100 && c.end === 5900)).toBe(true);
    expect(clip(store, later).start).toBe(9000);
  });
  test("selected sound stays selected across scenes on setPlayhead", () => {
    const { store, ids } = three();
    const a = add(store, 100, 900);
    store.dispatch({ type: "setPlayhead", ms: 2500 });
    expect(store.get().selection).toMatchObject({ kind: "sound", elemId: a, sceneId: ids[1] });
  });
});
