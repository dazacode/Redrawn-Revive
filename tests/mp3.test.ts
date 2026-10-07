import { expect, test } from "bun:test";
import { mp3Duration } from "../src/mp3.ts";

/** N frames of MPEG1 Layer III, 128 kbps, 44.1 kHz, no padding: 417 bytes and 1152 samples each. */
function frames(n: number, withId3 = false): Uint8Array {
  const parts: number[] = [];
  if (withId3) parts.push(0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 10, ...new Array(10).fill(0));
  for (let i = 0; i < n; i++) {
    parts.push(0xff, 0xfb, 0x90, 0x00);
    parts.push(...new Array(413).fill(0));
  }
  return Uint8Array.from(parts);
}

test("frame walk", () => {
  expect(mp3Duration(frames(100))).toBeCloseTo((100 * 1152) / 44100, 5);
});
test("skips ID3v2", () => {
  expect(mp3Duration(frames(50, true))).toBeCloseTo((50 * 1152) / 44100, 5);
});
test("non-mp3 data is 0", () => {
  expect(mp3Duration(new TextEncoder().encode("<?xml version='1.0'?><error/>"))).toBe(0);
  expect(mp3Duration(new Uint8Array())).toBe(0);
});
