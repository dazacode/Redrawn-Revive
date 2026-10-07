/** Minimal MP3 duration reader (Xing/Info header, else frame walk). Returns seconds, or 0 if not mp3. */

const BITRATES: Record<string, number[]> = {
  "1-1": [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  "1-2": [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  "1-3": [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  "2-1": [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  "2-2": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  "2-3": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const SAMPLE_RATES: Record<number, number[]> = {
  1: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  2.5: [11025, 12000, 8000],
};

export function mp3Duration(buf: Uint8Array): number {
  let pos = 0;
  if (buf.length > 10 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    pos = 10 + ((buf[6]! << 21) | (buf[7]! << 14) | (buf[8]! << 7) | buf[9]!);
  }
  let total = 0;
  let first = true;
  while (pos + 4 <= buf.length) {
    if (buf[pos] !== 0xff || (buf[pos + 1]! & 0xe0) !== 0xe0) {
      pos++;
      continue;
    }
    const b1 = buf[pos + 1]!, b2 = buf[pos + 2]!;
    const vBits = (b1 >> 3) & 3, layerBits = (b1 >> 1) & 3;
    const brIdx = (b2 >> 4) & 15, srIdx = (b2 >> 2) & 3, padding = (b2 >> 1) & 1;
    if (vBits === 1 || layerBits === 0 || brIdx === 0 || brIdx === 15 || srIdx === 3) {
      pos++;
      continue;
    }
    const version = vBits === 3 ? 1 : vBits === 2 ? 2 : 2.5;
    const layer = 4 - layerBits;
    const bitrate = BITRATES[`${version === 1 ? 1 : 2}-${layer}`]?.[brIdx];
    const sampleRate = SAMPLE_RATES[version]?.[srIdx];
    if (!bitrate || !sampleRate) {
      pos++;
      continue;
    }
    const samples = layer === 1 ? 384 : layer === 3 && version !== 1 ? 576 : 1152;
    const frameLen =
      layer === 1
        ? (Math.floor((12 * bitrate * 1000) / sampleRate) + padding) * 4
        : Math.floor(((layer === 3 && version !== 1 ? 72 : 144) * bitrate * 1000) / sampleRate) + padding;
    if (first) {
      first = false;
      const mono = ((buf[pos + 3]! >> 6) & 3) === 3;
      const side = version === 1 ? (mono ? 17 : 32) : mono ? 9 : 17;
      const x = pos + 4 + side;
      const tag = String.fromCharCode(buf[x] ?? 0, buf[x + 1] ?? 0, buf[x + 2] ?? 0, buf[x + 3] ?? 0);
      if (tag === "Xing" || tag === "Info") {
        const flags = buf[x + 7]!;
        if (flags & 1) {
          const frames = ((buf[x + 8]! << 24) | (buf[x + 9]! << 16) | (buf[x + 10]! << 8) | buf[x + 11]!) >>> 0;
          return (frames * samples) / sampleRate;
        }
      }
    }
    total += samples / sampleRate;
    pos += Math.max(frameLen, 1);
  }
  return total;
}
