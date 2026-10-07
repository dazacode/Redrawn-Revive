import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as cache from "../cache.ts";
import { getTheme, listUserCharIds, loadChar, saveNewChar, userCharsForTheme } from "../characters.ts";
import { CROSSDOMAIN, dirs, FAILURE_XML, FALLBACK_CHAR, XML_HEADER } from "../config.ts";
import {
  decodeB64, html, json, notFound, readFields, readParams, readUpload, redirect, text, xml, zip,
  type Ctx,
} from "../http.ts";
import { isSafeMovieKey, isSafeName } from "../ids.ts";
import {
  importMovieXml, listMovies, listStarters, loadMovieXml, loadMovieZip, movieMeta, movieThumb, saveMovie,
  saveStarter,
} from "../movies.ts";
import { Router } from "../router.ts";
import { getSession, removeSession, setSession } from "../sessions.ts";
import { enabledVoices, synthesize } from "../tts/index.ts";
import { languages, voiceDesc } from "../tts/voices.ts";
import { escapeXml } from "../xml.ts";
import { makeZip, withStatusByte } from "../zip.ts";

/** The routes the Flash SWFs (and the old wrapper pages) call. Formats match the legacy wrapper. */
export function registerLegacy(r: Router): void {
  // ---- constants / stubs ----
  r.get("/crossdomain.xml", () => html(CROSSDOMAIN));
  r.get("/goapi/getAssetTags", () => text("111", "application/json"));
  r.post("/goapi/getUserWatermarks", () =>
    html('<?xml encoding="UTF-8"?><watermarks><current/><preview/></watermarks>'));
  r.post("/goapi/getMovieInfo", () =>
    html('<?xml encoding="UTF-8"?><watermarks><watermark style="visualplugin"/></watermarks>'));
  r.get("/char_default.png", () => text('{"message":"REQUEST_HAS_EXPIRED"}'));
  r.post("/goapi/heartbeat/v1", () => text('{"health":"0","locked":"0"}', "application/json"));
  r.add("*", "/events/close", (c) => (removeSession(c.session), text("")));

  // ---- themes ----
  r.post("/goapi/getThemeList", () => {
    const f = join(dirs.themes, "themelist.xml");
    return existsSync(f) ? zip(makeZip({ "themelist.xml": readFileSync(f) })) : notFound();
  });
  r.post("/goapi/getTheme", async (c) => {
    const { themeId } = await readFields(c.req);
    const theme = themeId === "family" ? "custom" : themeId;
    const f = isSafeName(theme) ? join(dirs.themes, `${theme}.xml`) : null;
    return f && existsSync(f) ? zip(makeZip({ "theme.xml": readFileSync(f) })) : notFound();
  });
  r.post("/goapi/getCCPreMadeCharacters", async (c) => {
    const { themeId } = await readFields(c.req);
    const f = isSafeName(themeId) ? join(dirs.premade, `${themeId}.xml`) : null;
    return f && existsSync(f) ? html(readFileSync(f, "utf8")) : notFound();
  });

  // ---- characters ----
  r.get("/characters/:file", (c) => {
    const file = c.params.file!;
    if (/\.(png|txt|zip)$/i.test(file)) return null; // thumbnails: none; raw stock files are not served
    const xmlText = loadChar(file.replace(/\.xml$/, ""));
    return xmlText === null ? xml(FAILURE_XML, 404) : xml(xmlText);
  });
  r.post("/goapi/getCcCharCompositionXml", async (c) => {
    const d = await readFields(c.req);
    const id = d.assetId || d.original_asset_id || "";
    console.log(`Loading character: ${id}`);
    let xmlText = loadChar(id);
    if (xmlText === null) {
      xmlText = loadChar(FALLBACK_CHAR);
      if (xmlText !== null) console.log("Couldn't find that character, loaded the fallback instead.");
    }
    return xmlText === null ? html(`1${FAILURE_XML}`, 404) : html(`0${xmlText}`);
  });
  r.post("/goapi/saveCCCharacter", async (c) => {
    const d = await readFields(c.req);
    if (!d.body || !/^\s*(<\?xml[^>]*\?>\s*)?<cc_char\b/.test(d.body)) return html(`1${FAILURE_XML}`, 400);
    return html(`0${saveNewChar(d.body)}`);
  });
  r.post("/upload_character", async (c) => {
    const f = await readUpload(c.req);
    if (!f) return text("missing file field 'import'", "text/plain", 400);
    const body = await f.text();
    if (!/<cc_char\b/.test(body)) return text("not a character file", "text/plain", 400);
    const n = saveNewChar(body);
    return redirect(`/cc?themeId=family&original_asset_id=c-${n}`);
  });
  r.get(/^\/go\/character_creator\/(\w+)(\/\w+)?(\/.+)?$/, (c) => {
    const theme = c.params["1"]!, mode = c.params["2"], id = c.params["3"];
    if (mode === "/copy" && id) {
      return redirect(`/cc?themeId=${encodeURIComponent(theme)}&original_asset_id=${encodeURIComponent(id.slice(1))}`);
    }
    const defaults: Record<string, string> = { family: "adam", anime: "guy" };
    const type = c.url.searchParams.get("type") || defaults[theme] || "";
    return redirect(`/cc?themeId=${encodeURIComponent(theme)}&bs=${encodeURIComponent(type)}`);
  });

  // ---- asset lists ----
  const assetList = (zipped: boolean) => async (c: Ctx) => {
    const q = await readParams(c);
    const body = listAssetsXml(q.type, q.themeId);
    return zipped ? zip(withStatusByte(makeZip({ "desc.xml": body }))) : xml(body);
  };
  r.add(["GET", "POST"], "/goapi/getUserAssets", assetList(true));
  r.add(["GET", "POST"], "/api_v2/assets/team", assetList(true));
  r.add(["GET", "POST"], "/api_v2/assets/shared", assetList(true));
  r.add(["GET", "POST"], "/goapi/getUserAssetsXml", assetList(false));

  // ---- cached (uploaded / tts) assets ----
  const assetBytes = (mId: string | undefined, aId: string | undefined) =>
    mId && aId && isSafeMovieKey(mId) ? cache.load(mId, aId) : null;
  r.get("/assets/:mId/:aId", (c) => {
    const b = assetBytes(c.params.mId, c.params.aId!.replace(/\.xml$/, ""));
    return b ? text(b, "audio/mp3") : notFound();
  });
  const getAsset = async (c: Ctx) => {
    const d = await readFields(c.req);
    const mId = d.movieId || d.presaveId || getSession(c.session)?.movieId;
    const aId = d.assetId || d.enc_asset_id;
    const b = assetBytes(mId, aId);
    if (mId) setSession(c.session, { movieId: mId });
    return b ? text(b, "audio/mp3") : notFound();
  };
  r.post("/goapi/getAsset", getAsset);
  r.post("/goapi/getAssetEx", getAsset);
  r.post("/upload_asset", async (c) => {
    const mId = getSession(c.session)?.movieId;
    if (!mId || !isSafeMovieKey(mId)) return text("no movie is open in this session", "text/plain", 400);
    const f = await readUpload(c.req);
    if (!f) return text("missing file field 'import'", "text/plain", 400);
    const suffix = /(\.[A-Za-z0-9]{1,8})$/.exec(f.name)?.[1] ?? "";
    const id = cache.saveNew(new Uint8Array(await f.arrayBuffer()), mId, suffix);
    return id ? text(id) : text("could not store asset", "text/plain", 500);
  });

  // ---- movies ----
  r.post("/goapi/saveMovie", async (c) => {
    const d = await readFields(c.req);
    // legacy: any non-empty value counts as "triggered by autosave"
    if (d.is_triggered_by_autosave && (!d.movieId || d.noAutosave)) return text("0");
    const body = decodeB64(d.body_zip);
    if (!body) return html(`1${FAILURE_XML}`, 400);
    const thumb = decodeB64(d.thumbnail_large);
    try {
      const id = saveMovie(body, thumb, d.movieId || d.presaveId || "", d.presaveId || d.movieId || "");
      return text(`0${id}`);
    } catch (e) {
      console.warn("[saveMovie]", e instanceof Error ? e.message : e);
      return html(`1${FAILURE_XML}`, 400);
    }
  });
  r.post("/goapi/getMovie", async (c) => {
    const id = c.url.searchParams.get("movieId") || (await readFields(c.req)).movieId || "";
    try {
      return zip(withStatusByte(await loadMovieZip(id)));
    } catch {
      return text("1", "application/zip");
    }
  });
  r.get("/movies/:file", async (c) => {
    const m = /^(.+?)(?:\.(zip|xml))?$/.exec(c.params.file!)!;
    const id = m[1]!;
    if (m[2] === "zip") {
      try {
        return zip(await loadMovieZip(id));
      } catch {
        return notFound();
      }
    }
    const x = loadMovieXml(id);
    return x === null ? notFound() : xml(x);
  });
  r.get("/movieList", () => json(listMovies().map((id) => movieMeta(id)).filter(Boolean)));
  r.get("/meta/:id", (c) => {
    const m = movieMeta(c.params.id!);
    return m ? json(m) : notFound();
  });
  r.get("/movie_thumbs/:file", (c) => thumbResponse(movieThumb(c.params.file!.replace(/\.png$/, ""))));
  r.get("/starter_thumbs/:file", (c) => thumbResponse(movieThumb(c.params.file!.replace(/\.png$/, ""))));
  r.post("/upload_movie", async (c) => {
    const f = await readUpload(c.req);
    if (!f) return text("missing file field 'import'", "text/plain", 400);
    const body = await f.text();
    if (!/<film\b/.test(body)) return text("not a movie file", "text/plain", 400);
    return redirect(`/go_full?movieId=${importMovieXml(body)}`);
  });
  r.post("/goapi/saveTemplate", async (c) => {
    const d = await readFields(c.req);
    const body = decodeB64(d.body_zip);
    if (!body) return html(`1${FAILURE_XML}`, 400);
    try {
      return text(`0${saveStarter(body, decodeB64(d.thumbnail_large))}`);
    } catch (e) {
      console.warn("[saveTemplate]", e instanceof Error ? e.message : e);
      return html(`1${FAILURE_XML}`, 400);
    }
  });

  // ---- text to speech ----
  r.post("/goapi/getTextToSpeechVoices", () => html(voicesXml()));
  r.post("/goapi/convertTextToSoundAsset", async (c) => {
    const d = await readFields(c.req);
    try {
      const { mp3, seconds } = await synthesize(d.voice ?? "", d.text ?? "");
      const mId = d.presaveId;
      const id = mId && isSafeMovieKey(mId) ? cache.saveNew(mp3, mId, "-tts.mp3") : null;
      if (!id) throw new Error("no movie id to attach the audio to");
      const title = escapeXml(`[${voiceDesc(d.voice!)}] ${d.text}`);
      return html(
        `0<response><asset><id>${id}</id><enc_asset_id>${id}</enc_asset_id><type>sound</type><subtype>tts</subtype><title>${title}</title><published>0</published><tags></tags><duration>${Math.round(1000 * seconds)}</duration><downloadtype>progressive</downloadtype><file>${id}</file></asset></response>`,
      );
    } catch (e) {
      console.warn("[tts]", e instanceof Error ? e.message : e);
      return html(`1${FAILURE_XML}`);
    }
  });

  // ---- stock thumbnails (formerly fetched from the static server) ----
  r.get("/stock_thumbs/:file", async (c) => {
    const name = c.params.file!;
    if (!/^[\w.-]+$/.test(name) || name.includes("..")) return notFound();
    const f = join(dirs.thumbnails, name);
    return existsSync(f) ? new Response(Bun.file(f), { headers: { "Content-Type": "image/png" } }) : notFound();
  });
}

function thumbResponse(b: Uint8Array | null): Response {
  return b ? text(b, "image/png") : notFound();
}

export function voicesXml(): string {
  const byLang: Record<string, string[]> = {};
  for (const [id, v] of Object.entries(enabledVoices())) {
    (byLang[v.language] ??= []).push(
      `<voice id="${escapeXml(id)}" desc="${escapeXml(v.desc)}" sex="${escapeXml(v.gender)}" demo-url="" country="${escapeXml(v.country)}" plus="N"/>`,
    );
  }
  const langs = Object.keys(byLang).sort().map((l) =>
    `<language id="${escapeXml(l)}" desc="${escapeXml(languages[l] ?? l)}">${byLang[l]!.join("")}</language>`);
  return `${XML_HEADER}<voices>${langs.join("")}</voices>`;
}

export function listAssetsXml(type: string | undefined, themeId: string | undefined): string {
  const head = `${XML_HEADER}<ugc more="0">`;
  switch (type) {
    case "char": {
      const chars = themeId
        ? userCharsForTheme(themeId)
        : listUserCharIds().reverse().map((n) => ({ id: `c-${n}`, theme: getTheme(`c-${n}`) ?? "family" }));
      return `${head}${chars
        .map((v) => `<char id="${v.id}" name="Untitled" cc_theme_id="${escapeXml(v.theme)}" thumbnail_url="char_default.png" copyable="Y"><tags/></char>`)
        .join("")}</ugc>`;
    }
    case "movie":
      return `${head}${listStarters()
        .map((v) => `<movie id="${v.id}" path="/_SAVED/${v.id}" numScene="1" title="${escapeXml(v.name)}" thumbnail_url="/starter_thumbs/${v.id}.png"><tags></tags></movie>`)
        .join("")}</ugc>`;
    default:
      // bg / prop / sound uploads were never actually listed by the legacy server
      return `${head}</ugc>`;
  }
}
