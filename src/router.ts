import type { Ctx, Handler } from "./http.ts";

type Route = { methods: Set<string>; segments: string[] | null; regex: RegExp | null; handler: Handler };

/**
 * Minimal router. Patterns are exact paths with optional ":param" segments ("/movies/:file"),
 * or a RegExp (capture groups land in params["1"], params["2"], ...). Trailing slashes in the
 * request are ignored, so "/goapi/getTheme/" and "/goapi/getTheme" both match "/goapi/getTheme".
 */
export class Router {
  private routes: Route[] = [];

  add(methods: string | string[], pattern: string | RegExp, handler: Handler): this {
    const set = new Set((Array.isArray(methods) ? methods : [methods]).map((m) => m.toUpperCase()));
    if (typeof pattern === "string") {
      const segs = pattern.split("/").filter((s, i) => i === 0 || s !== "");
      this.routes.push({ methods: set, segments: segs, regex: null, handler });
    } else {
      this.routes.push({ methods: set, segments: null, regex: pattern, handler });
    }
    return this;
  }

  get = (p: string | RegExp, h: Handler) => this.add("GET", p, h);
  post = (p: string | RegExp, h: Handler) => this.add("POST", p, h);

  /** Run matching routes in order until one returns a Response. */
  async dispatch(ctx: Ctx): Promise<Response | null> {
    const method = ctx.req.method === "HEAD" ? "GET" : ctx.req.method;
    const parts = ctx.path.split("/");
    for (const r of this.routes) {
      if (!r.methods.has(method) && !r.methods.has("*")) continue;
      const params = this.match(r, ctx.path, parts);
      if (!params) continue;
      ctx.params = params;
      const res = await r.handler(ctx);
      if (res) return res;
    }
    return null;
  }

  private match(r: Route, path: string, parts: string[]): Record<string, string> | null {
    if (r.regex) {
      const m = r.regex.exec(path);
      if (!m) return null;
      const out: Record<string, string> = {};
      for (let i = 1; i < m.length; i++) if (m[i] !== undefined) out[String(i)] = m[i]!;
      return out;
    }
    const segs = r.segments!;
    if (segs.length !== parts.length) return null;
    const out: Record<string, string> = {};
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i]!, p = parts[i]!;
      if (s.startsWith(":")) {
        if (!p) return null;
        try {
          out[s.slice(1)] = decodeURIComponent(p);
        } catch {
          return null;
        }
      } else if (s !== p) return null;
    }
    return out;
  }
}
