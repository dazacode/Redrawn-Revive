import { describe, expect, test } from "bun:test";
import { isSafeAssetId, isSafeMovieKey, isSafeName, isSafeSegment, pad, parseCharId, parseMovieId } from "../src/ids.ts";

describe("parseMovieId", () => {
  test("accepts movies and starters", () => {
    expect(parseMovieId("m-12")).toEqual({ kind: "movie", n: 12 });
    expect(parseMovieId("0-3")).toEqual({ kind: "starter", n: 3 });
  });
  test.each(["m-", "m-1.2", "m-../../x", "m--1", "m-1/2", "m-1" + String.fromCharCode(92) + "2", "e-1", "../m-1", "m-1 ", "m-1234567890123", "", "m-%2e%2e"])(
    "rejects %p", (id) => expect(parseMovieId(id)).toBeNull());
  test("rejects non strings", () => {
    expect(parseMovieId(undefined)).toBeNull();
    expect(parseMovieId(5)).toBeNull();
    expect(parseMovieId({ toString: () => "m-1" })).toBeNull();
  });
});

describe("parseCharId", () => {
  test("user, snapshot, stock", () => {
    expect(parseCharId("c-5")).toEqual({ kind: "user", n: 5 });
    expect(parseCharId("C-3-1700000000000")).toEqual({ kind: "snapshot", name: "3-1700000000000" });
    expect(parseCharId("a-327068826")).toEqual({ kind: "stock", n: 327068826 });
    expect(parseCharId("327068826")).toEqual({ kind: "stock", n: 327068826 });
  });
  test.each(["c-../../etc/passwd", "C-1-2-3", "C-../1", "c-1.xml", "a-", "a-1/2", "x-1", "c-", "C-1", "..", "c-1\0"])(
    "rejects %p", (id) => expect(parseCharId(id)).toBeNull());
});

describe("name and asset id safety", () => {
  test("theme names", () => {
    expect(isSafeName("business")).toBe(true);
    expect(isSafeName("cc_store")).toBe(true);
    for (const bad of ["", "../x", "a/b", "a.b", "a b", "x".repeat(65), undefined]) expect(isSafeName(bad)).toBe(false);
  });
  test("movie keys", () => {
    expect(isSafeMovieKey("m-5")).toBe(true);
    expect(isSafeMovieKey("m-5.x")).toBe(false);
  });
  test("asset ids", () => {
    expect(isSafeAssetId("0123456-tts.mp3")).toBe(true);
    for (const bad of ["..", "a..b", "../x", "a/b", "a\b", ".hidden", "id", "time", "", "a:b"]) expect(isSafeAssetId(bad)).toBe(false);
  });
  test("segments", () => {
    expect(isSafeSegment("file.swf")).toBe(true);
    for (const bad of ["", ".", "..", "a/b", "a" + String.fromCharCode(92) + "b", "c:", "a\0b", "f.txt:stream"]) expect(isSafeSegment(bad)).toBe(false);
  });
  test("pad", () => {
    expect(pad(5)).toBe("0000005");
    expect(pad(12345678)).toBe("12345678");
  });
});
