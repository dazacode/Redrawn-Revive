// Spike server: serves Ruffle + test page, static server/ tree, proxies everything else to legacy wrapper (4343)
import { join, normalize } from "path";
const ROOT = join(import.meta.dir, "..");
const SERVER_DIR = join(ROOT, "server");
const PORT = 4680;
const BACKEND = "http://localhost:4343";
const log: string[] = [];
const staticPrefixes: Record<string, string> = {
  "/animation/": SERVER_DIR, "/store/": SERVER_DIR, "/static/": SERVER_DIR,
  "/ruffle/": import.meta.dir, "/ruffle-nightly/": import.meta.dir, "/pub/": import.meta.dir,
};
const headers = { "Access-Control-Allow-Origin": "*" };
Bun.serve({
  port: PORT,
  idleTimeout: 120,
  async fetch(req) {
    const u = new URL(req.url);
    let p = decodeURIComponent(u.pathname);
    if (p === "/log") { return new Response(log.join("\n")); }
    if (p === "/clientlog") { log.push(await req.text()); return new Response("ok"); }
    if (p === "/test") return new Response(Bun.file(join(import.meta.dir, "pub/test.html")));
    if (p.endsWith("rpc_4.6.0.23201.swz")) return new Response(Bun.file(join(import.meta.dir, "pub/rpc_4.6.0.23201.swz")), { headers });
    for (const pre in staticPrefixes) {
      if (p.startsWith(pre)) {
        const f = normalize(join(staticPrefixes[pre], p));
        const file = Bun.file(f);
        const ok = await file.exists();
        console.log(ok ? "200" : "404", req.method, p);
        if (!ok) return new Response("nf", { status: 404, headers });
        return new Response(file, { headers });
      }
    }
    // proxy
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
    const h = new Headers(req.headers); h.delete("host");
    try {
      const r = await fetch(BACKEND + u.pathname + u.search, { method: req.method, headers: h, body, redirect: "manual" });
      console.log(r.status, "PROXY", req.method, u.pathname + u.search, body ? `(${body.byteLength}b)` : "");
      const rh = new Headers(r.headers); rh.delete("content-encoding"); rh.delete("content-length");
      return new Response(await r.arrayBuffer(), { status: r.status, headers: rh });
    } catch (e) { console.log("PROXY FAIL", p, String(e)); return new Response("proxy fail", { status: 502 }); }
  },
});
console.log("spike on http://localhost:" + PORT);
