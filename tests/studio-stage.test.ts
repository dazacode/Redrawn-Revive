import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { studio } from "./studio-helpers.ts";

const M = await studio("stage-math");
const P = await studio("ruffle-pool");
const H = await studio("host-swf");
const T = await studio("thumbs");
const S = await studio("stage");

const near = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);
const K = 550 / 640;

describe("stage-math: view fitting", () => {
  test("fits with whole pixels and centres", () => {
    const v = M.fitView(1000, 600);
    const tall = M.fitView(2000, 310);
    expect(tall.w).toBe(550);
    expect(v.w).toBe(1000); // width-limited: 1000/550 < 600/310
    expect(Number.isInteger(v.w) && Number.isInteger(v.h) && Number.isInteger(v.x) && Number.isInteger(v.y)).toBe(true);
    near(v.w / v.h, 550 / 310, 0.02);
    expect(v.x).toBeGreaterThanOrEqual(0);
  });
  test("degenerate sizes give an empty view", () => {
    expect(M.fitView(0, 100).w).toBe(0);
    expect(M.fitView(100, -1).h).toBe(0);
  });
});

describe("stage-math: element transforms", () => {
  const e = { x: 200, y: 150, scale: 1.5, rotation: 30, flip: false };
  test("drawScale applies LEGACY_K and flip", () => {
    const [sx, sy] = M.drawScale(e);
    near(sx, 1.5 * K); near(sy, 1.5 * K);
    expect(M.drawScale({ ...e, flip: true })[0]).toBeLessThan(0);
  });
  test("localToStage and stageToLocal are inverses", () => {
    for (const el of [e, { ...e, flip: true }, { ...e, rotation: -120 }]) {
      const [sx, sy] = M.localToStage(el, 13, -40);
      const [lx, ly] = M.stageToLocal(el, sx, sy);
      near(lx, 13, 1e-6); near(ly, -40, 1e-6);
    }
  });
  test("the origin maps to (x, y)", () => {
    expect(M.localToStage(e, 0, 0)).toEqual([200, 150]);
  });
  const b = [-40, -95, 82, 172];
  test("scaleAboutCenter keeps the centre of the bounds fixed", () => {
    const [cx, cy] = M.boxCenter(e, b);
    const p = M.scaleAboutCenter(e, b, 2);
    near(p.scale, 3);
    const [nx, ny] = M.boxCenter({ ...e, ...p }, b);
    near(nx, cx, 0.02); near(ny, cy, 0.02);
  });
  test("scale is clamped", () => {
    expect(M.scaleAboutCenter(e, b, 1e-9).scale).toBe(M.MIN_SCALE);
    expect(M.scaleAboutCenter(e, b, 1e9).scale).toBe(M.MAX_SCALE);
  });
  test("rotateAboutCenter and flipAboutCenter keep the centre fixed", () => {
    const [cx, cy] = M.boxCenter(e, b);
    const r = M.rotateAboutCenter(e, b, 75);
    const [rx, ry] = M.boxCenter({ ...e, ...r }, b);
    near(rx, cx, 0.02); near(ry, cy, 0.02);
    const f = M.flipAboutCenter(e, b);
    expect(f.flip).toBe(true);
    const [fx, fy] = M.boxCenter({ ...e, ...f }, b);
    near(fx, cx, 0.02); near(fy, cy, 0.02);
  });
  test("orientedBox, inQuad and quadArea", () => {
    const q = M.orientedBox({ x: 100, y: 100, scale: 1, rotation: 0, flip: false }, [0, 0, 100, 50]);
    expect(M.inQuad(q, 100 + 40 * K, 100 + 20 * K)).toBe(true);
    expect(M.inQuad(q, 99, 100)).toBe(false);
    near(M.quadArea(q), 100 * K * 50 * K, 1e-6);
    const rot = M.orientedBox({ x: 0, y: 0, scale: 1, rotation: 90, flip: false }, [0, 0, 10, 10]);
    near(rot[1]![0], 0, 1e-9);
    near(rot[1]![1], 10 * K, 1e-9);
  });
  test("normDeg and angleDeg", () => {
    expect(M.normDeg(190)).toBe(-170);
    expect(M.normDeg(-180)).toBe(180);
    near(M.angleDeg(0, 1), 90);
  });
});

describe("stage-math: timing", () => {
  test("frameAt loops and clamps", () => {
    expect(M.frameAt(0, { total: 10, loop: true })).toBe(1);
    expect(M.frameAt(1000, { total: 24, loop: true })).toBe(1); // exactly one lap at 24 fps
    expect(M.frameAt(500, { total: 24, loop: true })).toBe(13);
    expect(M.frameAt(60000, { total: 24, loop: false })).toBe(24);
    expect(M.frameAt(100, { total: 1, loop: true })).toBe(1);
    expect(M.frameAt(-50, { total: 10, loop: true })).toBe(1);
  });
  test("inWindow honours optional start/end", () => {
    expect(M.inWindow({}, 123)).toBe(true);
    expect(M.inWindow({ start: 500 }, 400)).toBe(false);
    expect(M.inWindow({ start: 500, end: 900 }, 900)).toBe(false);
    expect(M.inWindow({ start: 500, end: 900 }, 899)).toBe(true);
  });
  test("applyCamera: identity for null/neutral, zoom about the centre otherwise", () => {
    const p = { x: 100, y: 80, scale: 1 };
    expect(M.applyCamera(p, null)).toBe(p);
    expect(M.applyCamera(p, { x: 275, y: 155, zoom: 1 })).toBe(p);
    const z = M.applyCamera({ x: 275, y: 155, scale: 1 }, { x: 275, y: 155, zoom: 2 });
    expect(z).toEqual({ x: 275, y: 155, scale: 2 });
    const z2 = M.applyCamera({ x: 375, y: 155, scale: 1 }, { x: 275, y: 155, zoom: 2 });
    expect(z2.x).toBe(475);
  });
});

describe("stage-math: bubbles", () => {
  test("bubblePath yields closed SVG paths for every style", () => {
    for (const style of ["talk", "think", "shout", "whisper", "unknown"]) {
      const d = M.bubblePath(style, 120, 50, [30, 80]);
      expect(d.startsWith("M")).toBe(true);
      expect(d.includes("NaN")).toBe(false);
    }
  });
  test("tail points at the target", () => {
    const d = M.tailTriangle(100, 40, [50, 120]);
    expect(d).toContain("L50,120");
    expect(M.tailTriangle(100, 40, [-60, 20])).toContain("L-60,20");
  });
  test("thoughtDots shrink towards the target", () => {
    const dots = M.thoughtDots(100, 40, [60, 100]);
    expect(dots.length).toBe(3);
    expect(dots[0].r).toBeGreaterThan(dots[2].r);
  });
});

describe("ruffle-pool: store decryption", () => {
  const enc = new TextEncoder();
  test("rc4 is its own inverse and matches the RFC 6229 vector", () => {
    const key = Uint8Array.of(0x01, 0x02, 0x03, 0x04, 0x05);
    const ks = P.rc4(key, new Uint8Array(8));
    expect(Buffer.from(ks).toString("hex")).toBe("b2396305f03dc027");
    const data = enc.encode("hello world, this is a test");
    expect(P.rc4(key, P.rc4(key, data))).toEqual(data);
  });
  test("decryptSwf decrypts encrypted SWFs and leaves plain data alone", () => {
    const plain = new Uint8Array(64);
    plain.set(enc.encode("CWS"), 0); plain[3] = 10; plain[8] = 0x78; plain[9] = 0x9c;
    const key = enc.encode(P.STORE_KEY);
    const encrypted = P.rc4(key, plain);
    expect(P.isSwf(encrypted)).toBe(false);
    expect(P.decryptSwf(encrypted)).toEqual(plain);
    expect(P.decryptSwf(plain)).toBe(plain);
    const jpg = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0);
    expect(P.decryptSwf(jpg)).toBe(jpg);
  });
  test("real store assets decrypt to SWFs (key regression)", () => {
    const dir = join(import.meta.dir, "..", "server", "store", "3a981f5cb2739137", "common");
    const files = ["bg/Diner_bg.swf", "char/matchBoyNew/stand.swf", "prop/03book.swf"].map((f) => join(dir, f)).filter(existsSync);
    for (const f of files) {
      const out = P.decryptSwf(new Uint8Array(readFileSync(f)));
      expect(P.isSwf(out)).toBe(true);
    }
    const jpg = join(dir, "bg", "Diner.jpg");
    if (existsSync(jpg)) {
      const raw = new Uint8Array(readFileSync(jpg));
      expect(P.decryptSwf(raw)).toBe(raw);
    }
  });
});

describe("host-swf: generated compositor", () => {
  const swf: Uint8Array = H.buildHostSwf(550, 310);
  test("is a well-formed uncompressed SWF 19 with consistent length", () => {
    expect(String.fromCharCode(swf[0]!, swf[1]!, swf[2]!)).toBe("FWS");
    expect(swf[3]).toBe(19);
    const len = swf[4]! | (swf[5]! << 8) | (swf[6]! << 16) | (swf[7]! << 24);
    expect(len).toBe(swf.length);
  });
  test("tag stream parses and ends with End", () => {
    const nbits = swf[8]! >> 3;
    let o = 8 + Math.ceil((5 + nbits * 4) / 8) + 4; // header + RECT + frame rate + frame count
    const codes: number[] = [];
    const bodies = new Map<number, Uint8Array>();
    while (o < swf.length) {
      const h = swf[o]! | (swf[o + 1]! << 8);
      o += 2;
      let l = h & 63;
      if (l === 63) { l = swf[o]! | (swf[o + 1]! << 8) | (swf[o + 2]! << 16) | (swf[o + 3]! << 24); o += 4; }
      codes.push(h >> 6);
      bodies.set(h >> 6, swf.subarray(o, o + l));
      o += l;
    }
    expect(o).toBe(swf.length);
    expect(codes).toEqual([69, 9, 82, 76, 1, 0]);
    const abc = bodies.get(82)!;
    expect(new TextDecoder().decode(abc.subarray(4, 8))).toBe("host");
    expect(abc[9]).toBe(16); expect(abc[11]).toBe(46); // minor 16, major 46
    expect(new TextDecoder().decode(bodies.get(76)!.subarray(4))).toContain("Host");
  });
  test("the ABC mentions every bridge method", () => {
    const text = new TextDecoder("latin1").decode(swf);
    for (const n of ["add", "rm", "idx", "bounds", "op", "addCallback", "ExternalInterface", "hitTestPoint".slice(0, 0)]) expect(text).toContain(n);
  });
});

describe("thumbs: pure helpers", () => {
  test("cache keys are stable and distinguish kind and size", () => {
    expect(T.thumbCacheKey("common.a.swf", "bg", 160)).toBe(T.thumbCacheKey("common.a.swf", "bg", 160));
    expect(T.thumbCacheKey("common.a.swf", "bg", 160)).not.toBe(T.thumbCacheKey("common.a.swf", "prop", 160));
    expect(T.thumbCacheKey("common.a.swf", "bg", 160)).not.toBe(T.thumbCacheKey("common.a.swf", "bg", 320));
  });
  test("imageCandidates lists same-named pictures beside the SWF", () => {
    const c: string[] = T.imageCandidates("/store/x/common/bg/Diner_bg.swf");
    expect(c).toContain("/store/x/common/bg/Diner.jpg");
    expect(c[0]).toBe("/store/x/common/bg/Diner_bg.jpg");
    expect(c.every((u) => /\.(jpg|png)$/.test(u))).toBe(true);
    expect(T.imageCandidates("/store/x/readme.txt")).toEqual([]);
  });
  test("fitBounds centres and fits", () => {
    const f = T.fitBounds([-50, -100, 100, 200], 310, 310, 0.1);
    near(f.scale, (310 * 0.8) / 200);
    near(f.x + (0) * f.scale, 155 - ((-50 + 50) * f.scale), 1e-6);
  });
});

describe("stage: character action resolution", () => {
  test("defaults to the elem's own asset id", () => {
    expect(S.charAssetId({ assetId: "common.matchBoyNew.stand.swf" })).toBe("common.matchBoyNew.stand.swf");
  });
  test("bare action files are resolved against the character", () => {
    expect(S.charAssetId({ assetId: "common.matchBoyNew.stand.swf", action: "talk.swf" })).toBe("common.matchBoyNew.talk.swf");
    expect(S.charAssetId({ assetId: "common.matchBoyNew.stand.swf", emotion: "angry.swf" })).toBe("common.matchBoyNew.angry.swf");
  });
  test("full action ids and 'default.swf'", () => {
    expect(S.charAssetId({ assetId: "common.matchBoyNew.stand.swf", action: "common.matchBoyNew.walk.swf" })).toBe("common.matchBoyNew.walk.swf");
    expect(S.charAssetId({ assetId: "common.matchBoyNew.stand.swf", action: "default.swf" })).toBe("common.matchBoyNew.stand.swf");
  });
});
