import { config } from "./config.ts";
import { sessionKey } from "./sessions.ts";

export type Ctx = {
  req: Request;
  url: URL;
  /** Path with any trailing slash removed (except "/"). */
  path: string;
  params: Record<string, string>;
  ip: string | null;
  /** http(s)://host[:port] as the client addressed us. Never hardcoded. */
  origin: string;
  session: string;
};

/** Handler returns a Response, or null/undefined to let later routes (static files) try. */
export type Handler = (ctx: Ctx) => Response | Promise<Response | null | undefined> | null | undefined;

const HOST_RE = /^[A-Za-z0-9.\-_]+(?::\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](?::\d{1,5})?$/;

/** Origin from the Host header (or x-forwarded-*), validated so it is safe to embed in pages. */
export function originOf(req: Request): string {
  const fwdHost = req.headers.get("x-forwarded-host");
  const host = (fwdHost ?? req.headers.get("host") ?? "").split(",")[0]!.trim();
  const proto = (req.headers.get("x-forwarded-proto") ?? "http").split(",")[0]!.trim();
  if (HOST_RE.test(host) && (proto === "http" || proto === "https")) return `${proto}://${host}`;
  return `http://localhost:${config.port}`;
}

export function makeCtx(req: Request, ip: string | null): Ctx {
  const url = new URL(req.url);
  let path = url.pathname;
  if (path.length > 1 && path.endsWith("/")) path = path.replace(/\/+$/, "") || "/";
  return { req, url, path, params: {}, ip, origin: originOf(req), session: sessionKey(req, ip) };
}

/** Form fields of a urlencoded or multipart POST body (file parts are skipped). */
export async function readFields(req: Request): Promise<Record<string, string>> {
  const type = req.headers.get("content-type") ?? "";
  const out: Record<string, string> = {};
  if (type.startsWith("multipart/form-data")) {
    const fd = await req.formData();
    for (const [k, v] of fd) if (typeof v === "string") out[k] = v;
    return out;
  }
  const body = await req.text();
  for (const [k, v] of new URLSearchParams(body)) out[k] = v;
  return out;
}

/** Query string merged with body fields (body wins), for endpoints that accept GET and POST. */
export async function readParams(ctx: Ctx): Promise<Record<string, string>> {
  const out: Record<string, string> = Object.fromEntries(ctx.url.searchParams);
  if (ctx.req.method === "POST") Object.assign(out, await readFields(ctx.req));
  return out;
}

/** First uploaded file of a multipart request, from the field `import` (as the legacy forms use). */
export async function readUpload(req: Request, field = "import"): Promise<File | null> {
  const fd = await req.formData();
  const f = fd.get(field);
  return f instanceof File ? f : null;
}

export const text = (body: string | Uint8Array, type = "text/plain; charset=UTF-8", status = 200, headers: Record<string, string> = {}) =>
  new Response(body as unknown as ConstructorParameters<typeof Response>[0], { status, headers: { "Content-Type": type, ...headers } });

export const xml = (body: string | Uint8Array, status = 200) => text(body, "text/xml; charset=UTF-8", status);
export const html = (body: string, status = 200) => text(body, "text/html; charset=UTF-8", status);
export const zip = (body: Uint8Array, status = 200) => text(body, "application/zip", status);
export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=UTF-8" } });
export const notFound = () => text("Not found", "text/plain; charset=UTF-8", 404);
export const redirect = (location: string, status = 302) => new Response(null, { status, headers: { Location: location } });

export function decodeB64(s: string | undefined): Uint8Array | null {
  if (!s) return null;
  const b = Buffer.from(s, "base64");
  return b.length ? new Uint8Array(b) : null;
}
