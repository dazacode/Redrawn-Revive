import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { studio } from "./studio-helpers.ts";

const S = await studio("swf-audio");
const { rc4 } = await studio("ruffle-pool");

/** Build a minimal uncompressed SWF from tags: [code, bytes]. */
function tag(code: number, body: number[]) {
  return body.length < 63 ? [(code << 6) | body.length, code >> 2, ...body].slice(0, 0).concat([((code << 6) | body.length) & 255, ((code << 6) | body.length) >> 8, ...body])
    : [((code << 6) | 63) & 255, ((code << 6) | 63) >> 8, body.length & 255, (body.length >> 8) & 255, 0, 0, ...body];
}
function swf(tags: number[][], compress = false) {
  const body = [0x00, 0x18, 0x00, 0x01, ...tags.flat(), ...tag(0, [])]; // empty rect, rate, frames
  const rect = [0x00]; // nbits=0 -> 1 byte
  const inner = [...rect, 0, 0x18, 1, 0, ...tags.flat(), 0, 0];
  const len = 8 + inner.length;
  const hdr = [compress ? 0x43 : 0x46, 0x57, 0x53, 9, len & 255, (len >> 8) & 255, 0, 0];
  void body;
  return new Uint8Array(compress ? [...hdr, ...deflateSync(Buffer.from(inner))] : [...hdr, ...inner]);
}
const mp3Frame = [0xff, 0xfb, 0x90, 0x00, 1, 2, 3, 4];

describe("swf-audio parser (synthetic)", () => {
  test("DefineSound mp3 skips the seek samples", async () => {
    const t = tag(14, [1, 0, (2 << 4) | (3 << 2) | 2 | 1, 100, 0, 0, 0, 0, 0, ...mp3Frame]);
    const a = S.extractSwfAudio(swf([t]));
    expect(a).toMatchObject({ mime: "audio/mpeg", sampleRate: 44100, channels: 2, source: "DefineSound" });
    expect([...a.bytes]).toEqual(mp3Frame);
  });
  test("compressed (CWS) files are unpacked", async () => {
    const t = tag(14, [1, 0, (2 << 4) | (3 << 2) | 2, 10, 0, 0, 0, 0, 0, ...mp3Frame]);
    const a = S.extractSwfAudio(await S.unpackSwf(swf([t], true)));
    expect([...a.bytes]).toEqual(mp3Frame);
  });
  test("streamed mp3 blocks (also inside a sprite) are concatenated", () => {
    const head = tag(18, [0, (2 << 4) | (3 << 2) | 2 | 1, 0x00, 0x04, 0, 0]);
    const blk = (x: number) => tag(19, [0, 4, 0, 0, 0xff, 0xfb, x, 0]);
    const sprite = tag(39, [5, 0, 2, 0, ...head, ...blk(1), ...blk(2), 0, 0]);
    const a = S.extractSwfAudio(swf([sprite]));
    expect(a.source).toBe("SoundStream");
    expect([...a.bytes]).toEqual([0xff, 0xfb, 1, 0, 0xff, 0xfb, 2, 0]);
  });
  test("raw PCM becomes a WAV", () => {
    const t = tag(14, [1, 0, (3 << 4) | (1 << 2) | 2, 2, 0, 0, 0, 1, 2, 3, 4]);
    const a = S.extractSwfAudio(swf([t]));
    expect(a.mime).toBe("audio/wav");
    expect(String.fromCharCode(...a.bytes.slice(0, 4))).toBe("RIFF");
    expect(a.bytes.length).toBe(44 + 4);
  });
  test("unknown codec gives null; garbage throws unsupported", async () => {
    const t = tag(14, [1, 0, (1 << 4), 1, 0, 0, 0, 9, 9]);
    expect(S.extractSwfAudio(swf([t]))).toBeNull();
    await expect(S.unpackSwf(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]))).rejects.toMatchObject({ unsupported: true });
  });
});

const root = join(import.meta.dir, "..", "server", "store");
const storeDir = existsSync(root) ? readdirSync(root).map((d) => join(root, d)).find((d) => existsSync(join(d, "common", "sound"))) : undefined;

describe("swf-audio on real store sounds", () => {
  test.skipIf(!storeDir)("extracts an MP3 from encrypted common sounds", async () => {
    const dir = join(storeDir!, "common", "sound");
    const files = readdirSync(dir).filter((f) => f.endsWith(".swf")).slice(0, 12);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const raw = new Uint8Array(await Bun.file(join(dir, f)).arrayBuffer());
      const a = await S.extractFromStoreBytes(raw);
      expect(a).not.toBeNull();
      expect(a.mime).toBe("audio/mpeg");
      expect(a.bytes.length).toBeGreaterThan(1000);
      expect(a.bytes[0]).toBe(0xff); // MPEG frame sync
      expect(a.bytes[1] & 0xe0).toBe(0xe0);
    }
  });
  test.skipIf(!storeDir)("a non-RC4 theme file is reported unsupported, not a crash", async () => {
    const dir = join(storeDir!, "underdog", "sound");
    if (!existsSync(dir)) return;
    const f = readdirSync(dir).find((x) => x.endsWith(".swf"));
    if (!f) return;
    const raw = new Uint8Array(await Bun.file(join(dir, f)).arrayBuffer());
    if (rc4(new TextEncoder().encode("sorrypleasetryagainlater"), raw.subarray(0, 3))[1] === 0x57) return; // key works here
    await expect(S.extractFromStoreBytes(raw)).rejects.toMatchObject({ unsupported: true });
  });
});
