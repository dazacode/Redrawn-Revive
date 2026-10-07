import { existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.ts";
import { decodeB64, json, notFound, redirect, text, type Ctx } from "../http.ts";
import { deleteMovie, listMovies, movieMeta, presaveMovieId, saveMovieXml } from "../movies.ts";
import { Router } from "../router.ts";
import { getSession, setSession } from "../sessions.ts";
import { probeAll } from "../tts/check.ts";
import { enabledProviders, enabledVoices } from "../tts/index.ts";

/** Endpoints for the new frontend (public/js/api.js), plus health. */
export function registerApp(r: Router): void {
  r.get("/api/health", () => json({ ok: true, version: config.version }));

  /** Absolute asset base URLs derived from the Host the client used (no hardcoded host or https). */
  r.get("/ajax/config", (c) => json(clientConfig(c)));

  r.get("/ajax/movie/list", () => json(listMovies().map((id) => movieMeta(id)).filter(Boolean)));

  /**
   * Id for a new movie. Nothing is written until the editor actually saves.
   * (Legacy created an empty movie-N.xml on every editor open.)
   */
  r.get("/ajax/movie/presave", (c) => {
    const movieId = presaveMovieId();
    setSession(c.session, { movieId });
    return json({ movieId });
  });

  // The editor page calls this when an existing movie is opened so uploads land in its asset cache.
  r.get("/ajax/movie/open", (c) => {
    const movieId = c.url.searchParams.get("movieId") ?? "";
    if (!movieMeta(movieId)) return notFound();
    setSession(c.session, { movieId });
    return json({ movieId });
  });

  /**
   * Studio save. JSON { xml, movieId?, presaveId?, thumbnail? (base64 png) } -> { movieId }.
   * Stores the same XML the SWF save path does, so /player and /go_full open the result.
   */
  r.post("/api/movies/save", async (c) => {
    let d: Record<string, unknown>;
    try {
      d = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return json({ error: "invalid JSON" }, 400);
    }
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    const xmlText = str(d.xml);
    const thumb = decodeB64(str(d.thumbnail).replace(/^data:image\/png;base64,/, ""));
    const oldId = str(d.movieId) || str(d.presaveId) || getSession(c.session)?.movieId || "";
    const newId = str(d.movieId) || str(d.presaveId) || oldId;
    try {
      const movieId = saveMovieXml(xmlText, thumb, oldId, newId);
      setSession(c.session, { movieId });
      return json({ movieId });
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : "save failed" }, 400);
    }
  });

  r.get("/studio", () => {
    const file = join(config.publicDir, "studio.html");
    return existsSync(file) ? new Response(Bun.file(file), { headers: { "Content-Type": "text/html; charset=UTF-8", "Cache-Control": "no-cache" } }) : notFound();
  });

  const del = (c: Ctx) => (deleteMovie(c.params.id!) ? text("OK") : notFound());
  r.get("/deleteMovie/:id", del);
  r.add("DELETE", "/api/movies/:id", del);

  r.get("/api/tts/providers", async (c) => {
    const probe = c.url.searchParams.has("probe");
    return json({
      enabled: [...enabledProviders()],
      voices: Object.keys(enabledVoices()).length,
      ...(probe ? { probe: await probeAll() } : {}),
    });
  });

  // Legacy page URLs (character creator redirects, upload redirects, old bookmarks) go to the
  // frontend's editor page when one exists.
  for (const type of ["cc", "cc_browser", "go_full", "player"]) {
    r.get(`/${type}`, (c) => {
      const editor = config.editorPage;
      const file = join(config.publicDir, editor.split("?")[0]!.replace(/^\//, ""));
      if (!existsSync(file)) {
        return text(`The editor page ${editor} is not present in public/.`, "text/plain", 404);
      }
      const q = new URLSearchParams({ type });
      for (const [k, v] of c.url.searchParams) if (k !== "type") q.set(k, v);
      return redirect(`${editor}?${q}`);
    });
  }
}

export function clientConfig(c: Pick<Ctx, "origin">) {
  return {
    SWF_URL: `${c.origin}/${config.swfPath}`,
    STORE_URL: `${c.origin}/${config.storePath}`,
    CLIENT_URL: `${c.origin}/${config.clientPath}`,
  };
}
