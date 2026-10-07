import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { strToU8 } from "fflate";
import { studio } from "./studio-helpers.ts";
import { makeZip, withStatusByte } from "../src/zip.ts";

const T = await studio("themes");
const M = await studio("model");
const I = await studio("ids");

const themeXml = (id: string) => readFileSync(join(import.meta.dir, "..", "data", "themes", `${id}.xml`), "utf8");

beforeEach(() => {
  T.resetThemes();
  T.setStoreBase("http://localhost:8080/store/3a981f5cb2739137");
});

describe("assetUrl", () => {
  test("strips the origin from the store url", () => {
    expect(T.storeBase()).toBe("/store/3a981f5cb2739137");
  });
  test("maps by explicit kind", () => {
    expect(T.assetUrl("common.Diner_bg.swf", undefined, { kind: "bg" })).toBe("/store/3a981f5cb2739137/common/bg/Diner_bg.swf");
    expect(T.assetUrl("common.02bat.swf", "common", { kind: "prop" })).toBe("/store/3a981f5cb2739137/common/prop/02bat.swf");
    expect(T.assetUrl("common.spray.swf", undefined, { kind: "effect" })).toBe("/store/3a981f5cb2739137/common/effect/spray.swf");
    expect(T.assetUrl("common.roadSide.swf", undefined, { kind: "sound" })).toBe("/store/3a981f5cb2739137/common/sound/roadSide.swf");
  });
  test("char action ids map to char/<char>/<action>", () => {
    expect(T.assetUrl("common.matchBoyNew.stand.swf")).toBe("/store/3a981f5cb2739137/common/char/matchBoyNew/stand.swf");
  });
  test("file names with spaces and quotes are encoded", () => {
    expect(T.assetUrl("common.classroom_book shell.swf", "common", { kind: "prop" })).toBe("/store/3a981f5cb2739137/common/prop/classroom_book%20shell.swf");
    expect(T.assetUrl("common.boss' office_bg.swf", undefined, { kind: "bg" })).toContain("boss'%20office_bg.swf");
  });
  test("kind is guessed when unknown", () => {
    expect(T.assetUrl("common.song.mp3")).toBe("/store/3a981f5cb2739137/common/sound/song.mp3");
    expect(T.assetUrl("common.Diner_bg.swf")).toBe("/store/3a981f5cb2739137/common/bg/Diner_bg.swf");
  });
  test("ugc assets need a movie id", () => {
    expect(T.assetUrl("ugc.s-0-1.mp3")).toBe("");
    expect(T.assetUrl("ugc.s-0-1.mp3", undefined, { movieId: "m-3" })).toBe("/assets/m-3/s-0-1.mp3");
  });
  test("theme aliases and empty input", () => {
    expect(T.assetUrl("family.x.swf", undefined, { kind: "bg" })).toBe("/store/3a981f5cb2739137/custom/bg/x.swf");
    expect(T.assetUrl("")).toBe("");
  });
});

describe("parseThemeXml (real themes)", () => {
  test("common theme", () => {
    const t = T.parseThemeXml(themeXml("common"));
    expect(t.id).toBe("common");
    expect(t.name).toBe("Common");
    expect(t.characters.length).toBe(2);
    expect(t.sounds.length).toBeGreaterThan(100);
    expect(t.props.length).toBeGreaterThan(100);
    expect(t.effects.length).toBe(78);
    expect(t.bubbles.length).toBe(30);
    const boy = t.characters.find((c: { id: string }) => c.id === "matchBoyNew");
    expect(boy.assetId).toBe("common.matchBoyNew.stand.swf");
    expect(boy.actions.emotion.length).toBeGreaterThan(5);
    expect(boy.actions.emotion[0].assetId).toBe("common.matchBoyNew.angry.swf");
    expect(boy.actions.motion[0].id).toBe("walk.swf");
    expect(boy.actions.action.some((a: { id: string }) => a.id === "talk.swf")).toBe(true);
  });
  test("backgrounds merge plain and composite entries without duplicates", () => {
    const t = T.parseThemeXml(themeXml("common"));
    const ids = t.backgrounds.map((b: { assetId: string }) => b.assetId);
    expect(new Set(ids).size).toBe(ids.length);
    const court = t.backgrounds.find((b: { id: string }) => b.id === "court");
    expect(court.assetId).toBe("common.court_bg_v1.swf");
    expect(court.composite.props.length).toBeGreaterThan(0);
    expect(court.composite.props[0].x).toBeCloseTo(565.6 * M.LEGACY_K, 4);
    expect(court.thumbUrl).toBe("/store/3a981f5cb2739137/common/bg/court.jpg");
    expect(t.backgrounds.some((b: { assetId: string }) => b.assetId === "common.Diner_bg.swf")).toBe(true);
  });
  test("sounds carry kind and duration", () => {
    const t = T.parseThemeXml(themeXml("common"));
    const music = t.sounds.find((s: { id: string }) => s.id === "roadSide.swf");
    expect(music).toMatchObject({ assetId: "common.roadSide.swf", kind: "bgmusic", duration: 39800 });
    expect(t.sounds.some((s: { kind: string }) => s.kind === "sfx")).toBe(true);
  });
  test("every bundled theme parses", () => {
    for (const id of ["action", "anime", "stick", "chibi", "retro", "spacecitizen", "whiteboard", "custom"]) {
      const t = T.parseThemeXml(themeXml(id), id);
      expect(t.id).toBe(id);
      for (const a of [...t.backgrounds, ...t.props, ...t.characters]) expect(a.assetId.startsWith(`${id}.`) || a.assetId.includes(".")).toBe(true);
    }
  });
});

describe("registry and search", () => {
  test("addTheme registers asset kinds for assetUrl", () => {
    T.addTheme(T.parseThemeXml(themeXml("common")));
    expect(T.assetKind("common.Diner_bg.swf")).toBe("bg");
    expect(T.assetKind("common.02bat.swf")).toBe("prop");
    expect(T.assetKind("common.matchBoyNew.talk.swf")).toBe("char");
    expect(T.assetKind("common.roadSide.swf")).toBe("sound");
    expect(T.assetUrl("common.02bat.swf")).toBe("/store/3a981f5cb2739137/common/prop/02bat.swf");
    expect(T.getTheme("common").id).toBe("common");
    expect(T.findAsset("common.roadSide.swf").name).toBe("Rock at the road side");
  });
  test("composite props are known as props", () => {
    T.addTheme(T.parseThemeXml(themeXml("common")));
    expect(T.assetKind("common.court_judge.swf")).toBe("prop");
  });
  test("matchAsset requires all words", () => {
    const a = { assetId: "common.Diner_bg.swf", name: "Diner", tags: ["restaurant", "food"] };
    expect(T.matchAsset(a, "")).toBe(true);
    expect(T.matchAsset(a, "diner food")).toBe(true);
    expect(T.matchAsset(a, "diner hospital")).toBe(false);
    expect(T.matchAsset(a, "REST")).toBe(true);
  });
  test("charActionAssetId", () => {
    expect(T.charActionAssetId({ assetId: "common.matchBoyNew.stand.swf" }, "talk.swf")).toBe("common.matchBoyNew.talk.swf");
  });
});

describe("theme list", () => {
  test("parseThemeList", () => {
    const l = T.parseThemeList(themeXml("themelist"));
    expect(l.find((t: { id: string }) => t.id === "common").name).toBe("Common");
    expect(l.length).toBeGreaterThan(10);
  });
  test("unzipText reads a server zip, with and without the status byte", async () => {
    const zip = makeZip({ "themelist.xml": themeXml("themelist"), "other.txt": strToU8("x") });
    const a = await T.unzipText(zip, "themelist.xml");
    const b = await T.unzipText(withStatusByte(zip), "themelist.xml");
    expect(a).toBe(themeXml("themelist"));
    expect(b).toBe(a);
    expect(await T.unzipText(zip, "other.txt")).toBe("x");
    await expect(T.unzipText(zip, "nope")).rejects.toThrow();
  });
});

describe("ids", () => {
  test("parseAssetId", () => {
    expect(I.parseAssetId("common.Diner_bg.swf")).toMatchObject({ theme: "common", ext: "swf", ugc: false, file: "Diner_bg.swf" });
    expect(I.parseAssetId("common.matchBoyNew.stand.swf").parts).toEqual(["matchBoyNew", "stand.swf"]);
    expect(I.parseAssetId("ugc.s-1.mp3").ugc).toBe(true);
    expect(I.parseAssetId("plain").theme).toBe("");
    expect(I.themeOf("cc2.xml")).toBe("cc2");
  });
  test("deterministic ids", () => {
    I.seedIds(10);
    expect(I.nextId("e")).toBe("e-11");
    expect(I.nextId("sc")).toBe("sc-12");
    I.seedIds(null);
    expect(I.nextId("e")).not.toBe(I.nextId("e"));
  });
});
