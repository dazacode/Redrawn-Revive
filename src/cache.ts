import { existsSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dirs } from "./config.ts";
import { ensureDirs } from "./storage.ts";
import { isSafeAssetId, isSafeMovieKey } from "./ids.ts";

/**
 * Per-movie asset cache (uploaded sounds, TTS) kept on disk as data/cache/<movieKey>.<assetId>.
 * Both parts are validated, so neither can contain a path separator.
 */

function file(mId: string, aId: string): string | null {
  if (!isSafeMovieKey(mId) || !isSafeAssetId(aId)) return null;
  return join(dirs.cache, `${mId}.${aId}`);
}

export function save(mId: string, aId: string, data: Uint8Array): boolean {
  const p = file(mId, aId);
  if (!p) return false;
  ensureDirs();
  writeFileSync(p, data);
  return true;
}

export function load(mId: string, aId: string): Uint8Array | null {
  const p = file(mId, aId);
  if (!p || !existsSync(p)) return null;
  return readFileSync(p);
}

export function list(mId: string): string[] {
  if (!isSafeMovieKey(mId) || !existsSync(dirs.cache)) return [];
  const prefix = `${mId}.`;
  return readdirSync(dirs.cache)
    .filter((f) => f.startsWith(prefix))
    .map((f) => f.slice(prefix.length))
    .filter(isSafeAssetId);
}

export function table(mId: string): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  for (const aId of list(mId)) {
    const b = load(mId, aId);
    if (b) out[aId] = b;
  }
  return out;
}

/** Normalises an upload suffix such as ".mp3" or "-tts.mp3"; anything odd collapses to "". */
export function cleanSuffix(suf: string): string {
  return /^[A-Za-z0-9._-]{0,24}$/.test(suf) && !suf.includes("..") ? suf : "";
}

/** Save under a fresh random id and return it. */
export function saveNew(data: Uint8Array, mId: string, suffix: string): string | null {
  const suf = cleanSuffix(suffix);
  for (let i = 0; i < 10; i++) {
    const aId = `${String(Math.random()).replace(".", "")}${suf}`;
    const p = file(mId, aId);
    if (!p) return null;
    if (existsSync(p)) continue;
    save(mId, aId, data);
    return aId;
  }
  return null;
}

/** Move a movie's cached assets to a new key (presave id -> final id). */
export function transfer(oldId: string, newId: string): void {
  if (oldId === newId || !isSafeMovieKey(oldId) || !isSafeMovieKey(newId)) return;
  for (const aId of list(oldId)) {
    const from = file(oldId, aId)!, to = file(newId, aId)!;
    renameSync(from, to);
  }
}

/** Remove every cached asset for a movie. */
export function clear(mId: string): void {
  for (const aId of list(mId)) {
    const p = file(mId, aId);
    if (p) unlinkSync(p);
  }
}
