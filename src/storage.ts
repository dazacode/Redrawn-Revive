import { copyFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync, constants } from "node:fs";
import { join } from "node:path";
import { dirs } from "./config.ts";
import { pad } from "./ids.ts";

/**
 * Numbered files in data/saved, same naming as the legacy _SAVED folder:
 *   movie-0000001.xml  thumb-0000001.png  char-0000001.xml  starter-0000001.xml/.png
 */
export type Prefix = "movie" | "thumb" | "char" | "starter";

export function ensureDirs(): void {
  for (const d of [dirs.saved, dirs.cache]) mkdirSync(d, { recursive: true });
}

export function savedPath(prefix: Prefix, n: number, ext: string): string {
  return join(dirs.saved, `${prefix}-${pad(n)}.${ext}`);
}

/** Path for non-numeric snapshot characters (char-A-B.xml). `name` must come from parseCharId. */
export function snapshotCharPath(name: string): string {
  return join(dirs.saved, `char-${name}.xml`);
}

/** Sorted ascending list of ids present for prefix/ext. Anchored on both ends. */
export function listIds(prefix: Prefix, ext: string): number[] {
  if (!existsSync(dirs.saved)) return [];
  const re = new RegExp(`^${prefix}-(\\d{7,12})\\.${ext}$`);
  const out: number[] = [];
  for (const f of readdirSync(dirs.saved)) {
    const m = re.exec(f);
    if (m) out.push(Number(m[1]));
  }
  return out.sort((a, b) => a - b);
}

/** Highest id in use + 1 (0 when none). */
export function nextId(prefix: Prefix, ext: string, floor = -1): number {
  const ids = listIds(prefix, ext);
  const last = ids.length ? ids[ids.length - 1]! : -1;
  return Math.max(last, floor) + 1;
}

/** Atomically claim the next id by writing the file (exclusive create). Only call with real data. */
export function writeNew(prefix: Prefix, ext: string, data: string | Uint8Array): number {
  ensureDirs();
  let n = nextId(prefix, ext);
  for (;;) {
    try {
      writeFileSync(savedPath(prefix, n, ext), data, { flag: "wx" });
      return n;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      n++;
    }
  }
}

export function removeIfExists(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* ignore */
  }
}

/**
 * Copy files from a legacy folder into dest without overwriting.
 * Marker files (_NO_...) are ignored. Returns number copied.
 */
export function migrateFolder(legacyDir: string, dest: string): number {
  if (!existsSync(legacyDir)) return 0;
  mkdirSync(dest, { recursive: true });
  let copied = 0;
  for (const name of readdirSync(legacyDir)) {
    if (name.startsWith("_NO_") || name.startsWith(".")) continue;
    try {
      copyFileSync(join(legacyDir, name), join(dest, name), constants.COPYFILE_EXCL);
      copied++;
    } catch {
      /* exists or not a file */
    }
  }
  return copied;
}
