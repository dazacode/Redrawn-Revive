/**
 * Extract playable audio from Flash (.swf) store sounds, so the Web Audio engine can decode them.
 *
 *   const a = await loadSwfAudio('/store/<id>/<theme>/sound/x.swf');  // cached, de-duplicated
 *   a -> { bytes: Uint8Array, mime: 'audio/mpeg'|'audio/wav', format, sampleRate, channels, samples, source }
 *
 * Store sounds are RC4-encrypted SWFs (key shared with ruffle-pool.js). The audio lives in
 *  - DefineSound (tag 14): MP3 / raw PCM / ADPCM-less (ADPCM is reported unsupported), or
 *  - SoundStreamHead/2 + SoundStreamBlock (tags 18/45 + 19): MP3 or PCM frames spread over the timeline,
 * at the root or nested in DefineSprite (tag 39). The longest sound in the file wins.
 *
 * Pure functions (`parseSwf`, `extractSwfAudio`, `pcmToWav`) are exported for tests; they work on Uint8Array
 * and need no DOM. CWS (zlib) needs DecompressionStream (browsers, Bun); LZMA (ZWS) is not supported.
 */
import { decryptSwf } from './ruffle-pool.js';

const RATES = [5512, 11025, 22050, 44100];

/** Inflate the body of a CWS file. */
async function inflate(bytes) {
  const ds = new DecompressionStream('deflate');
  const w = ds.writable.getWriter();
  w.write(bytes).catch(() => {});
  w.close().catch(() => {});
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}

const unsupported = (msg) => Object.assign(new Error(msg), { unsupported: true });

/** Return the uncompressed SWF (header + body) or throw. */
export async function unpackSwf(bytes) {
  const sig = String.fromCharCode(bytes[0], bytes[1], bytes[2]);
  if (sig === 'FWS') return bytes;
  if (sig === 'CWS') {
    const body = await inflate(bytes.subarray(8));
    const out = new Uint8Array(8 + body.length);
    out.set(bytes.subarray(0, 8)); out.set(body, 8);
    return out;
  }
  if (sig === 'ZWS') throw unsupported('LZMA-compressed SWF is not supported');
  // Some store themes (bunny, domo, sf, startrek, underdog) use a different, unknown key.
  throw unsupported('Sound file is encrypted with an unknown key');
}

/**
 * Walk the tags of an uncompressed SWF.
 * @param {Uint8Array} swf
 * @returns {{sounds: Array, streams: Array}} raw findings (see extractSwfAudio for the friendly form)
 */
export function parseSwf(swf) {
  const dv = new DataView(swf.buffer, swf.byteOffset, swf.byteLength);
  const nbits = swf[8] >> 3;
  let p = 8 + Math.ceil((5 + nbits * 4) / 8) + 4; // rect, frame rate (u16), frame count (u16)
  const sounds = [];
  /** streams are keyed by the container (root or sprite id) */
  const streams = new Map();
  const getStream = (key) => { let s = streams.get(key); if (!s) { s = { head: null, blocks: [] }; streams.set(key, s); } return s; };

  function walk(from, to, key) {
    let q = from;
    while (q + 2 <= to) {
      const hdr = dv.getUint16(q, true); q += 2;
      const code = hdr >> 6;
      let len = hdr & 63;
      if (len === 63) { if (q + 4 > to) break; len = dv.getUint32(q, true); q += 4; }
      const end = Math.min(to, q + len);
      if (code === 0) break;
      if (code === 14 && end - q >= 7) { // DefineSound
        const flags = swf[q + 2];
        sounds.push({
          id: dv.getUint16(q, true), format: flags >> 4, rate: RATES[(flags >> 2) & 3],
          bits16: !!(flags & 2), stereo: !!(flags & 1), samples: dv.getUint32(q + 3, true), data: swf.subarray(q + 7, end),
        });
      } else if ((code === 18 || code === 45) && end - q >= 4) { // SoundStreamHead(2)
        const f = swf[q + 1];
        const head = {
          format: f >> 4, rate: RATES[(f >> 2) & 3], bits16: !!(f & 2), stereo: !!(f & 1),
          samples: dv.getUint16(q + 2, true),
        };
        getStream(key).head ??= head;
      } else if (code === 19) { // SoundStreamBlock
        getStream(key).blocks.push(swf.subarray(q, end));
      } else if (code === 39 && end - q >= 4) { // DefineSprite: id, frameCount, then tags
        walk(q + 4, end, `s${dv.getUint16(q, true)}`);
      }
      q = end;
    }
  }
  walk(p, swf.length, 'root');
  return { sounds, streams: [...streams.values()].filter((s) => s.head && s.blocks.length) };
}

/** Wrap little-endian PCM in a WAV container. */
export function pcmToWav(pcm, rate, channels, bits16) {
  const bps = bits16 ? 16 : 8;
  const out = new Uint8Array(44 + pcm.length);
  const dv = new DataView(out.buffer);
  const tag = (o, s) => { for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i); };
  tag(0, 'RIFF'); dv.setUint32(4, 36 + pcm.length, true); tag(8, 'WAVE'); tag(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, channels, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * channels * (bps / 8), true);
  dv.setUint16(32, channels * (bps / 8), true); dv.setUint16(34, bps, true);
  tag(36, 'data'); dv.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

const concat = (parts) => {
  const out = new Uint8Array(parts.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of parts) { out.set(a, o); o += a.length; }
  return out;
};

/** Build a playable payload from one raw sound. Returns null when the codec is unsupported. */
function toPlayable(format, rate, bits16, stereo, samples, mp3OrPcm, source) {
  const channels = stereo ? 2 : 1;
  if (format === 2) {
    return { bytes: mp3OrPcm, mime: 'audio/mpeg', format: 'mp3', sampleRate: rate, channels, samples, source };
  }
  if (format === 0 || format === 3) {
    return { bytes: pcmToWav(mp3OrPcm, rate, channels, bits16), mime: 'audio/wav', format: 'pcm', sampleRate: rate, channels, samples, source };
  }
  return null;
}

/**
 * Pick the longest sound from an uncompressed SWF.
 * @param {Uint8Array} swf
 * @returns {{bytes:Uint8Array, mime:string, format:string, sampleRate:number, channels:number, samples:number, source:string}|null}
 *   null when the file has no supported audio
 */
export function extractSwfAudio(swf) {
  const { sounds, streams } = parseSwf(swf);
  const found = [];
  for (const s of sounds) {
    const raw = s.format === 2 ? s.data.subarray(2) : s.data; // MP3: skip SeekSamples
    const a = toPlayable(s.format, s.rate, s.bits16, s.stereo, s.samples, raw, 'DefineSound');
    if (a && a.bytes.length) found.push(a);
  }
  for (const st of streams) {
    const h = st.head;
    let data;
    let samples = 0;
    if (h.format === 2) { // each block: sampleCount u16, seekSamples s16, mp3 data
      data = concat(st.blocks.map((b) => b.subarray(4)));
      for (const b of st.blocks) if (b.length >= 2) samples += b[0] | (b[1] << 8);
    } else {
      data = concat(st.blocks);
      samples = Math.floor(data.length / ((h.bits16 ? 2 : 1) * (h.stereo ? 2 : 1)));
    }
    const a = toPlayable(h.format, h.rate, h.bits16, h.stereo, samples, data, 'SoundStream');
    if (a && a.bytes.length) found.push(a);
  }
  found.sort((x, y) => y.bytes.length - x.bytes.length);
  return found[0] ?? null;
}

/** Decode + extract from raw store bytes (encrypted or not). Throws on unreadable input; null if no audio. */
export async function extractFromStoreBytes(raw) {
  const swf = await unpackSwf(decryptSwf(raw));
  return extractSwfAudio(swf);
}

const cache = new Map(); // url -> Promise<result|null>

/** Fetch a store .swf sound and extract its audio. Cached and de-duplicated; failures are not cached. */
export function loadSwfAudio(url, doFetch = (...a) => globalThis.fetch(...a)) {
  let p = cache.get(url);
  if (p) return p;
  p = (async () => {
    const res = await doFetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const out = await extractFromStoreBytes(new Uint8Array(await res.arrayBuffer()));
    if (!out) throw unsupported('no playable audio in this SWF');
    return out;
  })();
  p.catch(() => cache.delete(url));
  cache.set(url, p);
  return p;
}
