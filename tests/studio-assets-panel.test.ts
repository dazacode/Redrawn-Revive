import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { studio } from "./studio-helpers.ts";

const P = await studio("assets-panel");
const T = await studio("themes");
const { normItem, searchFilter, soundKind, actionsOf, tagsOf, prettify, fmtDur } = P._internals;

const theme = (id: string) => T.parseThemeXml(readFileSync(join(import.meta.dir, "..", "data", "themes", `${id}.xml`), "utf8"), id);

describe("assets panel helpers", () => {
  test("prettify and duration formatting", () => {
    expect(prettify("msp_cake01_full.swf")).toBe("cake01 full");
    expect(fmtDur(185000)).toBe("3:05");
    expect(fmtDur(0)).toBe("0:00");
  });

  test("soundKind reads theme kind/subtype", () => {
    expect(soundKind({ kind: "bgmusic", subtype: "bgmusic" })).toBe("bgmusic");
    expect(soundKind({ kind: "sfx", subtype: "soundeffect" })).toBe("sfx");
    expect(soundKind({ kind: "sfx", subtype: "tribeofnoise" })).toBe("bgmusic");
    expect(soundKind({ kind: "voice" })).toBe("voice");
  });

  test("tagsOf merges tags and category and drops cat: prefixes", () => {
    expect(tagsOf({ tags: ["a", "_cat:Stock", ""], category: "b" })).toEqual(["a", "Stock", "b"]);
    expect(tagsOf({ tags: "x, y" })).toEqual(["x", "y"]);
  });

  test("actionsOf accepts grouped and flat shapes", () => {
    const grouped = actionsOf({ actions: { emotion: [{ id: "happy.swf", assetId: "t.c.happy.swf", name: "Happy" }], action: [{ id: "dance.swf", assetId: "t.c.dance.swf" }] } });
    expect(grouped.map((a: { category: string }) => a.category)).toEqual(["emotion", "action"]);
    expect(grouped[1].name).toBe("dance");
    expect(actionsOf({ actions: [{ assetId: "t.c.a.swf", category: "motion" }] })[0].category).toBe("motion");
    expect(actionsOf({})).toEqual([]);
  });

  test("normItem on real theme data", () => {
    const common = theme("common");
    const boy = normItem(common.characters[0], "char", "common");
    expect(boy.key).toBe(`char:${common.characters[0].assetId}`);
    expect(boy.actions.length).toBeGreaterThan(20);
    expect(boy.actions.some((a: { category: string }) => a.category === "emotion")).toBe(true);
    expect(boy.defaultAction).toBe("stand.swf");
    const snd = normItem(common.sounds[0], "sound", "common");
    expect(["bgmusic", "sfx"]).toContain(snd.sk);
    expect(snd.duration).toBeGreaterThan(0);
  });

  test("searchFilter: all tokens must match, name prefix ranks first, empty query is identity", () => {
    const items = ["Boss Office", "Office Boss Desk", "Airport Outside", "Classroom"].map((name, i) =>
      normItem({ assetId: `common.x${i}.swf`, name, tags: [] }, "bg", "common"));
    expect(searchFilter(items, "")).toBe(items);
    expect(searchFilter(items, "office").map((i: { name: string }) => i.name)).toEqual(["Office Boss Desk", "Boss Office"]);
    expect(searchFilter(items, "boss desk").map((i: { name: string }) => i.name)).toEqual(["Office Boss Desk"]);
    expect(searchFilter(items, "zzz")).toEqual([]);
  });
});
