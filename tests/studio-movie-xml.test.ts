import { describe, expect, test } from "bun:test";
import { LEGACY_FILM, studio } from "./studio-helpers.ts";
import { packMovie } from "../src/pack.ts";

const X = await studio("movie-xml");
const M = await studio("model");
const { parseMovieXml, serializeMovie, parseXmlTree, nodeToXml } = X;

/** Strip opaque bookkeeping so two parses can be compared semantically. */
const sem = (m: unknown) => JSON.parse(JSON.stringify(m, (k, v) => (k === "meta" ? undefined : v)));

describe("xml tree", () => {
  test("parses attributes, entities, cdata, self-closing and ignores comments", () => {
    const t = parseXmlTree(`<?xml version="1.0"?><!-- c --><a x='1' y="a&amp;b"><b/><c><![CDATA[<raw>]]></c>t&lt;</a>`);
    expect(t.n).toBe("a");
    expect(t.a).toEqual([["x", "1"], ["y", "a&b"]]);
    expect(nodeToXml(t)).toBe(`<a x="1" y="a&amp;b"><b/><c><![CDATA[<raw>]]></c>t&lt;</a>`);
  });
  test("tolerates unclosed tags and BOM", () => {
    const t = parseXmlTree("﻿<film><scene><bg>");
    expect(nodeToXml(t)).toBe("<film><scene><bg/></scene></film>");
  });
  test("no root throws", () => {
    expect(() => parseXmlTree("  ")).toThrow();
  });
});

describe("parseMovieXml", () => {
  const m = parseMovieXml(LEGACY_FILM);
  test("film basics", () => {
    expect(m.title).toBe("Legacy & Co <test>");
    expect(m.scenes.length).toBe(2);
    expect(m.scenes[0].duration).toBe(3000);
    expect(m.scenes[1].duration).toBe(6000);
    expect(M.movieDuration(m)).toBe(9000);
    expect(m.themeId).toBe("common");
    expect(m.width).toBe(550);
  });
  test("elements are converted to model space", () => {
    const s = m.scenes[0];
    expect(s.bg.assetId).toBe("common.Diner_bg.swf");
    const c = s.chars[0];
    expect(c.assetId).toBe("common.matchBoyNew.stand.swf");
    expect(c.action).toBe("stand.swf");
    expect(c.x).toBeCloseTo(320.5 * M.LEGACY_K, 6);
    expect(c.scale).toBeCloseTo(1.1, 6);
    expect(c.z).toBe(3);
    const p = s.props[0];
    expect(p.flip).toBe(true);
    expect(p.rotation).toBe(15);
    expect(s.effects[0].assetId).toBe("common.spray.swf");
  });
  test("bubble, transition and unknown children", () => {
    const s = m.scenes[0];
    expect(s.bubbles[0].text).toBe("Hi & bye");
    expect(s.bubbles[0].style).toBe("ellipse");
    expect(s.bubbles[0].end).toBe(3000);
    expect(s.transitionOut).toBe("common.fade.swf");
    expect(s.meta.raw.some((r: string) => r.startsWith("<weird"))).toBe(true);
  });
  test("sounds use frames at 24fps and tts data", () => {
    expect(m.sounds[0]).toMatchObject({ kind: "tts", assetId: "ugc.abc.mp3", start: 0, end: 4000, text: "hello there", voice: "kate" });
    expect(m.sounds[1].start).toBe(1000);
    expect(m.sounds[1].kind).toBe("sfx");
  });
  test("unknown film children land in meta.raw", () => {
    expect(m.meta.raw.length).toBe(3);
    expect(m.meta.raw.join("")).toContain("<cc_char");
    expect(m.meta.raw.join("")).toContain("<thumb>QUJD</thumb>");
  });
  test("rejects non-film documents", () => {
    expect(() => parseMovieXml("<theme/>")).toThrow();
  });
  test("film duration is spread over scenes without adelay", () => {
    const mm = parseMovieXml(`<film duration="10"><scene><bg><file>common.a.swf</file></bg></scene><scene/></film>`);
    expect(mm.scenes.map((s: { duration: number }) => s.duration)).toEqual([5000, 5000]);
  });
});

describe("round trip", () => {
  test("serialize(parse(x)) is stable and semantically identical", () => {
    const m1 = parseMovieXml(LEGACY_FILM);
    const out1 = serializeMovie(m1);
    const m2 = parseMovieXml(out1);
    expect(sem(m2)).toEqual(sem(m1));
    expect(serializeMovie(m2)).toBe(out1);
  });
  test("preserves unknown tags, embedded assets and cc_char verbatim", () => {
    const out = serializeMovie(parseMovieXml(LEGACY_FILM));
    expect(out).toContain('<weird a="1"><k/></weird>');
    expect(out).toContain('<asset id="abc.mp3">AAAA</asset>');
    expect(out).toContain(`<cc_char file_name="ugc.char.C-0-1.xml" xscale="1"><color r="ccSkinColor">0xFFCE95</color></cc_char>`);
    expect(out).toContain("<thumb>QUJD</thumb>");
    expect(out).toContain("<head><file>common.head.swf</file></head>");
    expect(out).toContain('<fadein dur="1" vol="2"/>');
  });
  test("untouched numbers keep their original text (no float drift)", () => {
    const out = serializeMovie(parseMovieXml(LEGACY_FILM));
    expect(out).toContain("<x>320.5</x>");
    expect(out).toContain("<yscale>0.35</yscale>");
  });
  test("title with markup survives", () => {
    const out = serializeMovie(parseMovieXml(LEGACY_FILM));
    expect(parseMovieXml(out).title).toBe("Legacy & Co <test>");
  });
  test("film duration and scene adelay are recomputed from the model", () => {
    const m = parseMovieXml(LEGACY_FILM);
    m.scenes[0] = { ...m.scenes[0], duration: 5000 };
    const out = serializeMovie(m);
    expect(out).toContain('duration="11"');
    expect(out).toContain('adelay="120"');
    expect(parseMovieXml(out).scenes[0].duration).toBe(5000);
  });
  test("edits patch only what changed", () => {
    const m = parseMovieXml(LEGACY_FILM);
    const c = m.scenes[0].chars[0];
    m.scenes[0].chars[0] = { ...c, x: 100, action: "talk.swf" };
    const out = serializeMovie(m);
    expect(out).toContain("<action>common.matchBoyNew.talk.swf</action>");
    expect(out).toContain(`<x>${Math.round((100 / M.LEGACY_K) * 1e4) / 1e4}</x>`);
    expect(out).toContain("<y>300</y>");
  });
  test("removed and added elements, flip toggling", () => {
    const m = parseMovieXml(LEGACY_FILM);
    m.scenes[0].props = [];
    m.scenes[0].chars[0] = { ...m.scenes[0].chars[0], flip: true };
    m.scenes[0].props.push(M.createElem("common.new.swf", { z: 9 }));
    const out = serializeMovie(m);
    expect(out).not.toContain("02bat");
    expect(out).toContain("common.new.swf");
    const back = parseMovieXml(out);
    expect(back.scenes[0].chars[0].flip).toBe(true);
    expect(back.scenes[0].props[0].assetId).toBe("common.new.swf");
  });
  test("new movie serializes and parses back", () => {
    const m = M.createMovie({ title: 'New "movie" & more' });
    m.scenes[0].bg = M.createElem("common.Diner_bg.swf", { x: 0, y: 0 });
    m.scenes[0].chars.push(M.createElem("common.matchBoyNew.stand.swf", { z: 1, x: 200, y: 250 }));
    m.scenes[0].bubbles.push(M.createBubble({ text: "Hello <b>", targetId: m.scenes[0].chars[0].id, start: 500, end: 2500 }));
    m.sounds.push(M.createSound({ kind: "bgmusic", assetId: "common.roadSide.swf", start: 0, end: 2000, volume: 0.5 }));
    const out = serializeMovie(m);
    expect(out).toMatch(/^<\?xml/);
    expect(out).toMatch(/<film [^>]*duration="3"/);
    const b = parseMovieXml(out);
    expect(b.title).toBe(m.title);
    expect(b.scenes[0].chars[0].x).toBeCloseTo(200, 3);
    expect(b.scenes[0].bubbles[0].text).toBe("Hello <b>");
    expect(b.scenes[0].bubbles[0].targetId).toBe(b.scenes[0].chars[0].id);
    expect(b.scenes[0].bubbles[0].start).toBe(500);
    expect(b.scenes[0].bubbles[0].end).toBe(2500);
    expect(b.sounds[0]).toMatchObject({ kind: "bgmusic", volume: 0.5, end: 2000 });
    expect(serializeMovie(b)).toBe(out);
  });
  test("sound offset round-trips through trimStart, also when edited on a parsed clip", () => {
    const m = M.createMovie();
    m.sounds.push(M.createSound({ assetId: "ugc.a.mp3", start: 1000, end: 3000, offset: 1500 }));
    const out = serializeMovie(m);
    expect(out).toContain("<trimStart>36</trimStart>");
    const b = parseMovieXml(out);
    expect(b.sounds[0].offset).toBe(1500);
    expect(serializeMovie(b)).toBe(out);
    b.sounds[0].offset = 500;
    const c = parseMovieXml(serializeMovie(b));
    expect(c.sounds[0].offset).toBe(500);
    c.sounds[0].offset = 0;
    expect(parseMovieXml(serializeMovie(c)).sounds[0].offset).toBeUndefined();
  });
  test("ids are legacy-style and unique across scenes", () => {
    const m = M.createMovie();
    m.scenes.push(M.createScene());
    for (const s of m.scenes) s.chars.push(M.createElem("common.a.b.swf"));
    const out = serializeMovie(m);
    const ids = [...out.matchAll(/ id="([^"]+)"/g)].map((x) => x[1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((i) => /^[A-Z]+-\d+$/.test(i!))).toBe(true);
  });
  test("output is a film the legacy packer accepts", async () => {
    const zip = await packMovie(serializeMovie(parseMovieXml(LEGACY_FILM)), null);
    expect(zip.length).toBeGreaterThan(50);
  });
  test("duplicate xml ids do not collide in the model but are kept on save", () => {
    const m = parseMovieXml(`<film><scene adelay="24"><prop id="P"><file>a.b.swf</file></prop><prop id="P"><file>a.c.swf</file></prop></scene></film>`);
    const ids = m.scenes[0].props.map((p: { id: string }) => p.id);
    expect(new Set(ids).size).toBe(2);
    expect(parseMovieXml(serializeMovie(m)).scenes[0].props.length).toBe(2);
  });
});
