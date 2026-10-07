import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";

export type ZipEntries = Record<string, Uint8Array | string>;

/** Build a zip (deflate). Entries may be strings (utf-8) or bytes. */
export function makeZip(entries: ZipEntries): Uint8Array {
  const z: Zippable = {};
  for (const [name, data] of Object.entries(entries)) {
    z[name] = typeof data === "string" ? strToU8(data) : data;
  }
  return zipSync(z, { level: 6 });
}

/** Read every entry of a zip into memory. Throws on malformed input. */
export function readZip(data: Uint8Array): Record<string, Uint8Array> {
  return unzipSync(data);
}

/** Read one named entry (text) from a zip without inflating the others. */
export function readZipText(data: Uint8Array, name: string): string | null {
  const out = unzipSync(data, { filter: (f) => f.name === name });
  const e = out[name];
  return e ? strFromU8(e) : null;
}

/** The legacy API prefixes zip bodies with a single 0x00 status byte. */
export function withStatusByte(zip: Uint8Array): Uint8Array {
  const out = new Uint8Array(zip.length + 1);
  out.set(zip, 1);
  return out;
}
