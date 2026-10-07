import { join, resolve } from "node:path";

/** Repository root (this file lives in <root>/src). */
export const ROOT = resolve(import.meta.dir, "..");

const env = process.env;

export const config = {
  port: Number(env.PORT) || 4343,
  /** Writable runtime data. Plain ASCII names (the legacy folders were _SAVED and _CACHE with an accent). */
  dataDir: resolve(env.DATA_DIR || join(ROOT, "data")),
  /** Static game assets (SWFs, store, client theme, stock characters, thumbnails). */
  assetsDir: resolve(env.ASSETS_DIR || join(ROOT, "server")),
  /** Frontend (owned by another agent). Served at the site root. */
  publicDir: resolve(env.PUBLIC_DIR || join(ROOT, "public")),
  /** Folder names the legacy SWF build expects in URLs. */
  swfPath: "animation/414827163ad4eb60",
  storePath: "store/3a981f5cb2739137",
  clientPath: "static/ad44370a650793d9",
  /** Where /go_full etc. redirect when the frontend provides an editor page. */
  editorPage: env.EDITOR_PAGE || "/editor.html",
  version: "0.1.0",
} as const;

export const dirs = {
  saved: join(config.dataDir, "saved"),
  cache: join(config.dataDir, "cache"),
  themes: join(ROOT, "data", "themes"),
  premade: join(ROOT, "data", "premade"),
  characters: join(config.assetsDir, "characters"),
  thumbnails: join(config.assetsDir, "thumbnails"),
  store: join(config.assetsDir, config.storePath),
  client: join(config.assetsDir, config.clientPath),
};

export const XML_HEADER = '<?xml version="1.0" encoding="utf-8"?>\n';
export const FAILURE_XML =
  "<error><code>ERR_ASSET_404</code><message>Something broke and got grounded.</message><text></text></error>";
export const CROSSDOMAIN = '<cross-domain-policy><allow-access-from domain="*"/></cross-domain-policy>';
/** Stock characters live in server/characters/<fileId>.txt, FILE_WIDTH characters per file. */
export const FILE_WIDTH = 1000;
export const FILE_NUM_WIDTH = 9;
export const XML_NUM_WIDTH = 3;
/** Fallback stock character when a requested character does not exist (legacy behaviour). */
export const FALLBACK_CHAR = "a-327068826";
