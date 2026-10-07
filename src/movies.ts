import { existsSync, readFileSync, readSync, openSync, closeSync, statSync, writeFileSync } from "node:fs";
import * as cache from "./cache.ts";
import { ensureDirs, listIds, nextId, removeIfExists, savedPath, writeNew } from "./storage.ts";
import { isSafeAssetId, isSafeMovieKey, parseMovieId } from "./ids.ts";
import { extractThumb, packMovie, unpackMovie } from "./pack.ts";
import { saveSnapshot } from "./characters.ts";
import { makeZip } from "./zip.ts";

/** Presave ids handed to editors but not yet saved; keeps concurrent "new movie" tabs distinct. */
const reserved = new Set<number>();

/** Allocate the id a new, unsaved movie will be saved under. Creates no file. */
export function presaveMovieId(): string {
  const n = nextId("movie", "xml", Math.max(-1, ...reserved));
  reserved.add(n);
  return `m-${n}`;
}

/**
 * Save a movie zip from the editor. `oldId` is the id the movie had (movieId or presaveId),
 * `newId` the id to save under. Returns the saved id.
 */
export function saveMovie(zip: Uint8Array, thumb: Uint8Array | null, oldId: string, newId: string = oldId): string {
  const target = parseMovieId(newId);
  if (!target || target.kind !== "movie") throw new Error(`cannot save to id ${JSON.stringify(newId)}`);
  const canonical = `m-${target.n}`;
  if (isSafeMovieKey(oldId)) cache.transfer(oldId, canonical);
  const xml = unpackMovie(zip, thumb, canonical);
  ensureDirs();
  if (thumb) writeFileSync(savedPath("thumb", target.n, "png"), thumb);
  writeFileSync(savedPath("movie", target.n, "xml"), xml);
  reserved.delete(target.n);
  return canonical;
}

/**
 * Save a movie from plain XML (the new Studio editor), producing exactly what the SWF save path
 * stores. Content the stored form embeds (<asset>, <cc_char>, <thumb>) is moved back into the
 * asset cache / character store first, then unpackMovie re-embeds it, so nothing is duplicated.
 */
export function saveMovieXml(xml: string, thumb: Uint8Array | null, oldId: string, newId: string = oldId): string {
  if (!/<film\b/.test(xml) || !/<\/film>\s*$/.test(xml)) throw new Error("not a complete <film> document");
  const key = isSafeMovieKey(oldId) ? oldId : null;
  let body = xml;
  const keptThumb = extractThumb(body);
  body = body.replace(/<thumb>[\s\S]*?<\/thumb>/g, "");
  body = body.replace(/<asset\s+id="([^"]*)"\s*>([\s\S]*?)<\/asset>/g, (_m, id: string, data: string) => {
    if (key && isSafeAssetId(id) && !cache.load(key, id)) {
      const bytes = id.endsWith(".xml")
        ? new TextEncoder().encode(data.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&"))
        : new Uint8Array(Buffer.from(data, "base64"));
      cache.save(key, id, bytes);
    }
    return "";
  });
  body = body.replace(/<cc_char\b[\s\S]*?<\/cc_char>/g, (m) => {
    const name = /file_name=(?:'([^']*)'|"([^"]*)")/.exec(m);
    const file = name?.[1] ?? name?.[2] ?? "";
    const dot = file.indexOf(".", 9);
    saveSnapshot(file.slice(9, dot < 0 ? undefined : dot), m);
    return "";
  });
  const zip = makeZip({ "movie.xml": body });
  return saveMovie(zip, thumb ?? keptThumb, oldId, newId);
}

function pathFor(id: string): string | null {
  const p = parseMovieId(id);
  if (!p) return null;
  return p.kind === "movie" ? savedPath("movie", p.n, "xml") : savedPath("starter", p.n, "xml");
}

/** Zip served to the SWF (without the leading status byte). */
export async function loadMovieZip(id: string): Promise<Uint8Array> {
  const f = pathFor(id);
  if (!f || !existsSync(f)) throw new Error("movie not found");
  return packMovie(readFileSync(f, "utf8"), id);
}

export function loadMovieXml(id: string): string | null {
  const p = parseMovieId(id);
  if (!p || p.kind !== "movie") return null;
  const f = savedPath("movie", p.n, "xml");
  return existsSync(f) ? readFileSync(f, "utf8") : null;
}

export function movieThumb(id: string): Uint8Array | null {
  const p = parseMovieId(id);
  if (!p) return null;
  const f = p.kind === "movie" ? savedPath("thumb", p.n, "png") : savedPath("starter", p.n, "png");
  return existsSync(f) ? readFileSync(f) : null;
}

/** Newest first; only movies that have both XML and a thumbnail (as legacy). */
export function listMovies(): string[] {
  const thumbs = new Set(listIds("thumb", "png"));
  return listIds("movie", "xml")
    .filter((n) => thumbs.has(n))
    .reverse()
    .map((n) => `m-${n}`);
}

export type MovieMeta = { date: Date; durationString: string; duration: number; title: string; id: string };

export function movieMeta(id: string): MovieMeta | null {
  const p = parseMovieId(id);
  if (!p || p.kind !== "movie") return null;
  const fn = savedPath("movie", p.n, "xml");
  if (!existsSync(fn)) return null;
  const fd = openSync(fn, "r");
  let head: string;
  try {
    const buf = Buffer.alloc(4096);
    const len = readSync(fd, buf, 0, buf.length, 0);
    head = buf.subarray(0, len).toString("utf8");
  } finally {
    closeSync(fd);
  }
  const t = /<title>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))\s*<\/title>/.exec(head);
  const title = (t?.[1] ?? t?.[2] ?? "").trim().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const d = /<film\b[^>]*?\bduration="([\d.]+)"/.exec(head);
  const duration = d ? Number.parseFloat(d[1]!) : 0;
  const min = String(Math.floor(duration / 60)).padStart(2, "0");
  const sec = String(Math.floor(duration % 60)).padStart(2, "0");
  return { date: statSync(fn).mtime, durationString: `${min}:${sec}`, duration, title, id };
}

export function deleteMovie(id: string): boolean {
  const p = parseMovieId(id);
  if (!p || p.kind !== "movie") return false;
  const f = savedPath("movie", p.n, "xml");
  if (!existsSync(f)) return false;
  removeIfExists(f);
  removeIfExists(savedPath("thumb", p.n, "png"));
  cache.clear(`m-${p.n}`);
  return true;
}

/** POST /upload_movie: store an exported movie XML as a new movie. */
export function importMovieXml(xml: string): string {
  const n = writeNew("movie", "xml", xml);
  const thumb = extractThumb(xml);
  if (thumb) writeFileSync(savedPath("thumb", n, "png"), thumb);
  return `m-${n}`;
}

// ---- starter templates (saveTemplate) ----

export function saveStarter(zip: Uint8Array, thumb: Uint8Array | null): string {
  const xml = unpackMovie(zip, thumb, null);
  const n = writeNew("starter", "xml", xml);
  if (thumb) writeFileSync(savedPath("starter", n, "png"), thumb);
  return `0-${n}`;
}

export function listStarters(): { id: string; name: string }[] {
  return listIds("starter", "xml")
    .reverse()
    .map((n) => ({ id: `0-${n}`, name: `Starter ${n}` }));
}
