import { describe, expect, test } from "bun:test";
import { studio } from "./studio-helpers.ts";

const T = await studio("timeline-logic");
const A = await studio("audio");
const { clampZoom, dropMarkerMs, fitZoom, fmtDur, fmtTime, moveClip, packLanes, parseConvertResponse, parseVoicesXml, prettyAssetName, reorderIndex, snap, splitClip, tickLabel, tickStep, trackOf, trimLeft, trimRight } = T;
const { computePeaks, isDecodable, sceneOffsets } = A;

describe("timeline formatting", () => {
  test("fmtTime", () => {
    expect(fmtTime(0)).toBe("0:00.0");
    expect(fmtTime(3250)).toBe("0:03.3");
    expect(fmtTime(65_000)).toBe("1:05.0");
    expect(fmtTime(3_661_000)).toBe("1:01:01.0");
  });
  test("fmtDur", () => {
    expect(fmtDur(3000)).toBe("3s");
    expect(fmtDur(4500)).toBe("4.5s");
    expect(fmtDur(75_000)).toBe("1:15");
  });
  test("ruler ticks scale with zoom", () => {
    expect(tickStep(80)).toBe(1);
    expect(tickStep(10)).toBe(10);
    expect(tickStep(600)).toBe(0.2);
    expect(tickLabel(65, 5)).toBe("1:05");
    expect(tickLabel(1.5, 0.5)).toBe("0:01.5");
  });
  test("zoom helpers clamp", () => {
    expect(clampZoom(1)).toBe(10);
    expect(clampZoom(9999)).toBe(600);
    expect(clampZoom(NaN)).toBe(80);
    expect(fitZoom(10_000, 800)).toBe(80);
    expect(fitZoom(0, 800)).toBe(80);
  });
});

describe("tracks and lanes", () => {
  test("trackOf", () => {
    expect(trackOf("tts")).toBe("voice");
    expect(trackOf("voice")).toBe("voice");
    expect(trackOf("bgmusic")).toBe("music");
    expect(trackOf("sfx")).toBe("sfx");
    expect(trackOf("weird")).toBe("sfx");
  });
  test("packLanes stacks overlaps only", () => {
    const c = (id: string, start: number, end: number) => ({ id, kind: "sfx", assetId: "", start, end, volume: 1 });
    const { lanes, count } = packLanes([c("a", 0, 1000), c("b", 500, 1500), c("c", 1000, 2000), c("d", 1600, 2500)]);
    expect(count).toBe(2);
    expect(lanes.get("a")).toBe(0);
    expect(lanes.get("b")).toBe(1);
    expect(lanes.get("c")).toBe(0); // starts exactly when a ends
    expect(lanes.get("d")).toBe(1);
    expect(packLanes([]).count).toBe(1);
  });
});

describe("snapping and editing math", () => {
  test("snap picks the nearest target within the threshold", () => {
    expect(snap(990, [0, 1000, 2000], 20)).toEqual({ ms: 1000, target: 1000 });
    expect(snap(900, [0, 1000], 20)).toEqual({ ms: 900, target: null });
  });
  test("moveClip clamps to the movie and snaps either edge", () => {
    const o = { start: 1000, end: 2000 };
    expect(moveClip(o, -5000, { total: 10_000 })).toEqual({ start: 0, end: 1000, guide: null });
    expect(moveClip(o, 9000, { total: 5000 })).toEqual({ start: 4000, end: 5000, guide: null });
    const r = moveClip(o, 2990, { total: 10_000, targets: [5000], threshold: 30 });
    expect(r.end).toBe(5000);
    expect(r.start).toBe(4000);
    expect(r.guide).toBe(5000);
  });
  test("trimLeft advances the source offset and never passes the source start", () => {
    const o = { start: 2000, end: 4000 };
    expect(trimLeft(o, 0, 500)).toEqual({ start: 2500, offset: 500, guide: null });
    expect(trimLeft(o, 300, -1000)).toEqual({ start: 1700, offset: 0, guide: null });
    expect(trimLeft(o, 0, 99_999).start).toBe(3900); // keeps the minimum length
  });
  test("trimRight respects min length and source length", () => {
    const o = { start: 1000, end: 3000 };
    expect(trimRight(o, -5000).end).toBe(1100);
    expect(trimRight(o, 5000, { maxLen: 2500 }).end).toBe(3500);
  });
  test("splitClip carries the source offset", () => {
    const c = { id: "x", kind: "voice", assetId: "a", start: 1000, end: 5000, volume: 1, offset: 200 };
    const [l, r] = splitClip(c, 3000)!;
    expect(l).toEqual({ end: 3000 });
    expect(r).toEqual({ start: 3000, end: 5000, offset: 2200 });
    expect(splitClip(c, 1050)).toBeNull();
  });
  test("scene reorder math", () => {
    const b = [{ start: 0, end: 3000 }, { start: 3000, end: 6000 }, { start: 6000, end: 9000 }];
    expect(reorderIndex(b, 0, 1500)).toBe(0);
    expect(reorderIndex(b, 0, 7000)).toBe(1); // past scene 2's midpoint only... center at 7000 > 4500, < 7500
    expect(reorderIndex(b, 0, 8000)).toBe(2);
    expect(reorderIndex(b, 2, 100)).toBe(0);
    expect(dropMarkerMs(b, 0, 0)).toBe(3000);
    expect(dropMarkerMs(b, 0, 2)).toBe(9000);
  });
});

describe("naming", () => {
  test("prettyAssetName", () => {
    expect(prettyAssetName("common.rockMain.swf")).toBe("rockMain");
    expect(prettyAssetName("ugc.12345678901-tts.mp3")).toBe("Uploaded audio");
    expect(prettyAssetName("tension_builds_up.swf")).toBe("tension builds up");
  });
});

describe("server response shapes (src/routes/legacy.ts)", () => {
  test("parseVoicesXml", () => {
    const xml = `<?xml version="1.0"?><voices><language id="en" desc="English"><voice id="kate" desc="Kate &amp; Co" sex="F" demo-url="" country="US" plus="N"/><voice id="paul" desc="Paul" sex="M" demo-url="" country="US" plus="N"/></language><language id="es" desc="Spanish"><voice id="lola" desc="Lola" sex="F" demo-url="" country="ES" plus="N"/></language></voices>`;
    const l = parseVoicesXml(xml);
    expect(l.map((x: { id: string }) => x.id)).toEqual(["en", "es"]);
    expect(l[0]!.voices[0]).toEqual({ id: "kate", desc: "Kate & Co", sex: "F", country: "US" });
    expect(parseVoicesXml("<voices></voices>")).toEqual([]);
  });
  test("parseConvertResponse", () => {
    const ok = parseConvertResponse(`0<response><asset><id>123-tts.mp3</id><enc_asset_id>123-tts.mp3</enc_asset_id><type>sound</type><subtype>tts</subtype><title>[Kate] a &amp; b</title><published>0</published><tags></tags><duration>2500</duration><downloadtype>progressive</downloadtype><file>123-tts.mp3</file></asset></response>`);
    expect(ok).toEqual({ ok: true, id: "123-tts.mp3", duration: 2500, title: "[Kate] a & b" });
    const bad = parseConvertResponse("1<error><code>ERR</code></error>");
    expect(bad.ok).toBe(false);
  });
});

describe("audio engine pure helpers", () => {
  test("isDecodable accepts Flash store sounds (unpacked by swf-audio)", () => {
    expect(isDecodable("common.laugh_4.swf")).toBe(true);
    expect(isDecodable("ugc.123-tts.mp3")).toBe(true);
    expect(isDecodable("")).toBe(false);
  });
  test("sceneOffsets", () => {
    const m = { scenes: [{ id: "a", duration: 3000 }, { id: "b", duration: 2000 }] };
    expect(sceneOffsets(m)).toEqual([{ id: "a", start: 0, end: 3000 }, { id: "b", start: 3000, end: 5000 }]);
  });
  test("computePeaks normalises to 1 and buckets at 100/s", () => {
    const ch = new Float32Array(2000);
    ch[15] = -0.25;
    ch[1500] = 0.5;
    const p = computePeaks([ch], 1000);
    expect(p.length).toBe(200);
    expect(Math.max(...p)).toBe(1);
    expect(p[1]).toBeCloseTo(0.5);
    expect(p[0]).toBe(0);
  });
});
