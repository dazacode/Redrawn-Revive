import { statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { config } from "./config.ts";
import { isSafeSegment } from "./ids.ts";

const TYPES: Record<string, string> = {
  ".swf": "application/x-shockwave-flash",
  ".swz": "application/octet-stream",
  ".xml": "text/xml; charset=UTF-8",
  ".html": "text/html; charset=UTF-8",
  ".js": "text/javascript; charset=UTF-8",
  ".mjs": "text/javascript; charset=UTF-8",
  ".css": "text/css; charset=UTF-8",
  ".json": "application/json; charset=UTF-8",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".mp3": "audio/mpeg",
};

/**
 * Resolve a URL pathname to a file inside `root`, or null. Rejects traversal, encoded separators,
 * dotfiles, NUL bytes and Windows drive/stream syntax.
 */
export function resolveInside(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const segs = decoded.split("/").filter(Boolean);
  if (!segs.every((s) => isSafeSegment(s) && !s.startsWith("."))) return null;
  const full = resolve(join(root, ...segs));
  const base = resolve(root);
  if (full !== base && !full.startsWith(base + sep)) return null;
  return full;
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function fileResponse(path: string, cacheControl: string): Response {
  const type = TYPES[extname(path).toLowerCase()];
  const headers: Record<string, string> = {
    "Cache-Control": cacheControl,
    "Access-Control-Allow-Origin": "*",
  };
  if (type) headers["Content-Type"] = type;
  return new Response(Bun.file(path), { headers });
}

/** Top-level folders of server/ that are public. Everything else there (certs, readme) is not served. */
const ASSET_ROOTS = new Set(["animation", "store", "static", "thumbnails"]);
const ASSET_FILES = new Set(["favicon.ico", "logo.png", "logo.svg"]);

/** Serve the frontend (public/) first, then the legacy asset tree (server/). */
export function serveStatic(pathname: string): Response | null {
  // frontend
  const pub = resolveInside(config.publicDir, pathname);
  if (pub) {
    if (isFile(pub)) return fileResponse(pub, "no-cache");
    const index = join(pub, "index.html");
    if (isFile(index)) return fileResponse(index, "no-cache");
  }
  // game assets
  const first = pathname.split("/").filter(Boolean)[0] ?? "";
  if (ASSET_ROOTS.has(first) || ASSET_FILES.has(first)) {
    const p = resolveInside(config.assetsDir, pathname);
    if (p && isFile(p)) {
      return fileResponse(p, ASSET_ROOTS.has(first) && first !== "thumbnails" ? "public, max-age=3600" : "no-cache");
    }
  }
  // Flex runtime libraries (RSLs): Ruffle falls back to <swf dir>/<name>.swz when its CDN fetch fails.
  if (pathname.endsWith(".swz")) {
    const name = pathname.split("/").pop() ?? "";
    const p = resolveInside(join(config.publicDir, "vendor", "swz"), name);
    if (p && isFile(p)) return fileResponse(p, "public, max-age=86400");
  }
  return null;
}
