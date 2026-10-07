/**
 * Id-safety logic. Every id that reaches the filesystem goes through here.
 * Legacy code concatenated client-supplied ids into paths and RegExps; these
 * parsers only accept the exact shapes the SWFs produce.
 */

const MAX_NUM = 999_999_999_999;

function parseNum(s: string): number | null {
  if (!/^\d{1,12}$/.test(s)) return null;
  const n = Number(s);
  return n <= MAX_NUM ? n : null;
}

export type MovieId = { kind: "movie"; n: number } | { kind: "starter"; n: number };

/** "m-12" -> user movie, "0-3" -> starter template. */
export function parseMovieId(id: unknown): MovieId | null {
  if (typeof id !== "string") return null;
  const m = /^(m|0)-(\d{1,12})$/.exec(id);
  if (!m) return null;
  const n = parseNum(m[2]!);
  if (n === null) return null;
  return m[1] === "m" ? { kind: "movie", n } : { kind: "starter", n };
}

export function isMovieId(id: unknown): id is string {
  return parseMovieId(id)?.kind === "movie";
}

export type CharId =
  /** c-N : user character saved on this server (char-000000N.xml) */
  | { kind: "user"; n: number }
  /** C-A-B : character snapshot embedded in a movie (char-A-B.xml) */
  | { kind: "snapshot"; name: string }
  /** a-N or N : stock character from server/characters */
  | { kind: "stock"; n: number };

export function parseCharId(id: unknown): CharId | null {
  if (typeof id !== "string") return null;
  let m = /^c-(\d{1,12})$/.exec(id);
  if (m) {
    const n = parseNum(m[1]!);
    return n === null ? null : { kind: "user", n };
  }
  m = /^C-(\d{1,15}-\d{1,15})$/.exec(id);
  if (m) return { kind: "snapshot", name: m[1]! };
  m = /^(?:a-)?(\d{1,12})$/.exec(id); // blank prefix kept for compatibility
  if (m) {
    const n = parseNum(m[1]!);
    return n === null ? null : { kind: "stock", n };
  }
  return null;
}

/** Theme / folder names: letters, digits, underscore, dash. */
export function isSafeName(s: unknown): s is string {
  return typeof s === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(s);
}

/** Movie key used to group cached assets (session/presave ids like "m-5"). */
export function isSafeMovieKey(s: unknown): s is string {
  return isSafeName(s);
}

/** Cached asset id such as "0123456-tts.mp3". Never a path. */
export function isSafeAssetId(s: unknown): s is string {
  return (
    typeof s === "string" &&
    /^[A-Za-z0-9_.-]{1,128}$/.test(s) &&
    !s.includes("..") &&
    s !== "id" &&
    s !== "time" &&
    !s.startsWith(".")
  );
}

/** Zero pad like the legacy padZero. */
export function pad(n: number, width = 7): string {
  return String(n).padStart(width, "0");
}

/** True only if the string is a single path segment that cannot escape its directory. */
export function isSafeSegment(s: string): boolean {
  return s.length > 0 && s !== "." && s !== ".." && !/[\\/:\0]/.test(s);
}
