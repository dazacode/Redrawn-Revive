import { FAILURE_XML } from "./config.ts";
import { makeCtx } from "./http.ts";
import { registerApp } from "./routes/app.ts";
import { registerLegacy } from "./routes/legacy.ts";
import { Router } from "./router.ts";
import { serveStatic } from "./static.ts";

export const router = new Router();
registerLegacy(router);
registerApp(router);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

/** Whole request pipeline: API routes first, then static files. Never throws. */
export async function handle(req: Request, ip: string | null): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const ctx = makeCtx(req, ip);
  try {
    const res = (await router.dispatch(ctx)) ?? ((req.method === "GET" || req.method === "HEAD") ? serveStatic(ctx.path) : null);
    if (res) {
      for (const [k, v] of Object.entries(CORS)) if (!res.headers.has(k)) res.headers.set(k, v);
      return res;
    }
    return new Response("Not found", { status: 404, headers: CORS });
  } catch (e) {
    console.error(`[error] ${req.method} ${ctx.path}`, e);
    return new Response(`1${FAILURE_XML}`, { status: 500, headers: { "Content-Type": "text/html; charset=UTF-8", ...CORS } });
  }
}
