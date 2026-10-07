import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dirs, FILE_WIDTH, FILE_NUM_WIDTH, XML_NUM_WIDTH } from "./config.ts";
import { pad, parseCharId } from "./ids.ts";
import { listIds, savedPath, snapshotCharPath, writeNew } from "./storage.ts";
import { readZipText } from "./zip.ts";
import { writeFileSync } from "node:fs";
import { ensureDirs } from "./storage.ts";

/** Extracts theme_id="..." from character XML (legacy addTheme, without the byte-offset hack). */
export function themeOf(xml: string): string | null {
  const m = /theme_id="([^"]*)"/.exec(xml);
  return m ? m[1]! : null;
}

// ---- stock characters (server/characters/<fileId>.txt, or the matching .zip) ----

const stockFiles = new Map<string, Map<string, string>>();
const STOCK_CACHE_MAX = 16;

function loadStockFile(fileId: string): Map<string, string> | null {
  const hit = stockFiles.get(fileId);
  if (hit) {
    stockFiles.delete(fileId); // refresh LRU position
    stockFiles.set(fileId, hit);
    return hit;
  }
  let text: string | null = null;
  const txt = join(dirs.characters, `${fileId}.txt`);
  const zip = join(dirs.characters, `${fileId}.zip`);
  if (existsSync(txt)) text = readFileSync(txt, "utf8");
  else if (existsSync(zip)) {
    try {
      text = readZipText(readFileSync(zip), `${fileId}.txt`);
    } catch {
      text = null;
    }
  }
  if (text === null) return null;
  const lines = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (line.length > XML_NUM_WIDTH) lines.set(line.slice(0, XML_NUM_WIDTH), line.slice(XML_NUM_WIDTH));
  }
  stockFiles.set(fileId, lines);
  if (stockFiles.size > STOCK_CACHE_MAX) stockFiles.delete(stockFiles.keys().next().value!);
  return lines;
}

export function loadStock(n: number): string | null {
  const sub = n % FILE_WIDTH;
  const fileId = pad(n - sub, FILE_NUM_WIDTH);
  return loadStockFile(fileId)?.get(pad(sub, XML_NUM_WIDTH)) ?? null;
}

// ---- user characters ----

const themes = new Map<string, string>();

/** Load character XML by id (c-N, C-A-B, a-N, N). Returns null if missing or id is invalid. */
export function loadChar(id: string): string | null {
  const p = parseCharId(id);
  if (!p) return null;
  switch (p.kind) {
    case "user": {
      const f = savedPath("char", p.n, "xml");
      return existsSync(f) ? readFileSync(f, "utf8") : null;
    }
    case "snapshot": {
      const f = snapshotCharPath(p.name);
      return existsSync(f) ? readFileSync(f, "utf8") : null;
    }
    case "stock":
      return loadStock(p.n);
  }
}

export function getTheme(id: string): string | null {
  const hit = themes.get(id);
  if (hit) return hit;
  const xml = loadChar(id);
  const t = xml ? themeOf(xml) : null;
  if (t) themes.set(id, t);
  return t;
}

/** Save a new user character; returns its numeric id (use as `c-${n}`). */
export function saveNewChar(xml: string): number {
  const n = writeNew("char", "xml", xml);
  const t = themeOf(xml);
  if (t) themes.set(`c-${n}`, t);
  return n;
}

/** Save an embedded movie character under its snapshot id (C-A-B). Idempotent. */
export function saveSnapshot(id: string, xml: string): string | null {
  const p = parseCharId(id);
  if (!p || p.kind !== "snapshot") return null;
  ensureDirs();
  writeFileSync(snapshotCharPath(p.name), xml);
  const t = themeOf(xml);
  if (t) themes.set(id, t);
  return id;
}

export function listUserCharIds(): number[] {
  return listIds("char", "xml");
}

/** Used by asset listing: legacy theme remapping so related CC themes share characters. */
export function normalizeListTheme(theme: string): string {
  switch (theme) {
    case "custom":
      return "family";
    case "action":
    case "animal":
    case "space":
    case "vietnam":
      return "cc2";
    default:
      return theme;
  }
}

export function userCharsForTheme(theme: string): { id: string; theme: string }[] {
  const want = normalizeListTheme(theme);
  const out: { id: string; theme: string }[] = [];
  for (const n of listUserCharIds()) {
    const id = `c-${n}`;
    if (getTheme(id) === want) out.unshift({ id, theme: want });
  }
  return out;
}
