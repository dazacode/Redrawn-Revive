import { handle } from "./app.ts";
import { config, dirs, ROOT } from "./config.ts";
import { ensureDirs, migrateFolder } from "./storage.ts";
import { join } from "node:path";

ensureDirs();

// Old data lived in wrapper/_SAVED and wrapper/_CACH<E acute>. Copy it over once (never overwrites).
const legacy = join(ROOT, "wrapper");
const moved =
  migrateFolder(join(legacy, "_SAVED"), dirs.saved) +
  migrateFolder(join(legacy, "_CACHÉ"), dirs.cache) +
  migrateFolder(join(legacy, "_CACHÉ"), dirs.cache);
if (moved) console.log(`Migrated ${moved} file(s) from the legacy wrapper folders into ${config.dataDir}`);

const QUIET = /^\/(animation|store|static|thumbnails|characters|css|js|img|fonts|vendor)\//;

const server = Bun.serve({
  port: config.port,
  hostname: process.env.HOST || "127.0.0.1",
  idleTimeout: 120,
  maxRequestBodySize: 512 * 1024 * 1024,
  async fetch(req, srv) {
    const started = performance.now();
    const res = await handle(req, srv.requestIP(req)?.address ?? null);
    const path = new URL(req.url).pathname;
    if (!QUIET.test(path)) console.log(`${req.method} ${path} ${res.status} ${Math.round(performance.now() - started)}ms`);
    return res;
  },
});

console.log(`Redrawn listening on http://${server.hostname}:${server.port}`);
