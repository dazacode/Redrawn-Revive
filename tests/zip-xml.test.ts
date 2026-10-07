import { describe, expect, test } from "bun:test";
import { strFromU8 } from "fflate";
import { attr, escapeXml, kid, kids, parseXml, text } from "../src/xml.ts";
import { makeZip, readZip, readZipText, withStatusByte } from "../src/zip.ts";

describe("zip", () => {
  test("round trip text and binary entries", () => {
    const bin = Uint8Array.from({ length: 5000 }, (_, i) => i % 251);
    const z = makeZip({ "theme.xml": "<theme>é €</theme>", "a/b.bin": bin });
    expect(z[0]).toBe(0x50); // "PK"
    expect(z[1]).toBe(0x4b);
    const out = readZip(z);
    expect(strFromU8(out["theme.xml"]!)).toBe("<theme>é €</theme>");
    expect(out["a/b.bin"]).toEqual(bin);
    expect(readZipText(z, "theme.xml")).toBe("<theme>é €</theme>");
    expect(readZipText(z, "nope")).toBeNull();
  });
  test("status byte prefix keeps zip intact", () => {
    const z = makeZip({ "x.xml": "<x/>" });
    const p = withStatusByte(z);
    expect(p[0]).toBe(0);
    expect(p.length).toBe(z.length + 1);
    expect(readZipText(p.subarray(1), "x.xml")).toBe("<x/>");
  });
  test("malformed zip throws", () => {
    expect(() => readZip(new Uint8Array([1, 2, 3, 4]))).toThrow();
  });
});

describe("xml", () => {
  const doc = parseXml(`<?xml version="1.0"?>
    <film duration="12.5"><meta><title><![CDATA[A & B]]></title></meta>
      <scene id="s1"><bg><file>common.x.swf</file></bg><prop><file>a.b.swf</file></prop><prop><file>c.d.png</file></prop></scene>
      <asset id="u.mp3">QUJD</asset><empty/></film>`);
  const film = doc.film[0];
  test("attributes, text, repeated children", () => {
    expect(attr(film, "duration")).toBe("12.5");
    expect(text(kid(kid(film, "meta"), "title"))).toBe("A & B");
    const scene = kid(film, "scene");
    expect(kids(scene, "prop").map((p) => text(kid(p, "file")))).toEqual(["a.b.swf", "c.d.png"]);
    expect(attr(kid(film, "asset"), "id")).toBe("u.mp3");
    expect(text(kid(film, "asset"))).toBe("QUJD");
    expect(text(kid(film, "empty"))).toBe("");
  });
  test("escapeXml round trips through the parser", () => {
    const s = `He said "5 < 6 & 7 > 3"`;
    const d = parseXml(`<a t="${escapeXml(s)}">${escapeXml(s)}</a>`);
    expect(attr(d.a[0], "t")).toBe(s);
    expect(text(d.a[0])).toBe(s);
  });
  test("empty input throws", () => {
    expect(() => parseXml("  ")).toThrow();
  });
});
