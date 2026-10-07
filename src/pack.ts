import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dirs, XML_HEADER } from "./config.ts";
import * as cache from "./cache.ts";
import { getTheme, loadChar, saveSnapshot } from "./characters.ts";
import { fontFileName } from "./fonts.ts";
import { isSafeAssetId, isSafeName, isSafeSegment, parseCharId } from "./ids.ts";
import { mp3Duration } from "./mp3.ts";
import { attr, childNames, escapeXml, kid, kids, parseXml, text, type XNode } from "./xml.ts";
import { makeZip, readZip, type ZipEntries } from "./zip.ts";
import { voiceDesc } from "./tts/voices.ts";

/**
 * Movie XML <-> SWF zip packaging. Port of the legacy data/parse.js.
 *
 *  packMovie    stored movie XML  -> zip served to the SWF (adds theme/asset/char files)
 *  unpackMovie  zip from the SWF  -> movie XML stored on disk (embeds ugc assets + characters)
 */

function readFileOrNull(path: string): Uint8Array | null {
  try {
    return existsSync(path) ? readFileSync(path) : null;
  } catch {
    return null;
  }
}

/** Read a file from the store (store/<id>/a/b/c). Each part must be a single safe segment. */
function readStore(parts: string[]): Uint8Array | null {
  if (!parts.every(isSafeSegment)) return null;
  return readFileOrNull(join(dirs.store, ...parts));
}

function readFont(file: string): Uint8Array | null {
  if (!isSafeSegment(file)) return null;
  return readFileOrNull(join(dirs.client, "go", "font", file));
}

function readThemeXml(theme: string): Uint8Array | null {
  if (!isSafeName(theme)) return null;
  return readFileOrNull(join(dirs.themes, `${theme}.xml`));
}

/** Everything except xml assets is stored base64 inside <asset>. */
function useBase64(aId: string): boolean {
  return !aId.endsWith(".xml");
}

type AssetType = { subtype: string; name: string };

function warn(msg: string): void {
  console.warn(`[pack] ${msg}`);
}

export async function packMovie(xml: string, mId: string | null): Promise<Uint8Array> {
  if (!xml.length) throw new Error("empty movie");
  const zip: ZipEntries = {};
  const themes = new Set<string>(["common"]);
  const assetTypes: Record<string, AssetType> = {};
  const ugcChars = new Map<string, string>(); // char id -> theme
  let ugcSounds = "";

  if (mId) cache.clear(mId); // legacy: table reset; assets are re-cached from the XML below
  zip["movie.xml"] = xml;

  const film: XNode = parseXml(xml).film?.[0];
  if (!film) throw new Error("not a film document");

  // 1. film-level <sound> elements (must precede <asset> so names/subtypes are known)
  for (const s of kids(film, "sound")) {
    const sfile = text(kid(s, "sfile"));
    const file = sfile.slice(sfile.indexOf(".") + 1);
    const ttsData = kid(s, "ttsdata");
    if (sfile.endsWith(".swf")) {
      const [theme, name] = sfile.split(".");
      const data = theme && name ? readStore([theme, "sound", `${name}.swf`]) : null;
      if (data) zip[`${theme}.sound.${name}.swf`] = data;
      else warn(`missing store sound ${sfile}`);
    } else if (sfile.startsWith("ugc.")) {
      if (ttsData) {
        const t = text(kid(ttsData, "text"));
        const voice = text(kid(ttsData, "voice"));
        assetTypes[file] = { subtype: "tts", name: `[${voiceDesc(voice)}] ${t}` };
      } else {
        assetTypes[file] = { subtype: "sound", name: file };
      }
    }
  }

  // 2. embedded characters (<cc_char file_name='ugc.char.C-a-b.xml'>), saved as snapshots
  for (const m of xml.matchAll(/<cc_char\b[\s\S]*?<\/cc_char>/g)) {
    const sub = m[0];
    const name = /file_name=(?:'([^']*)'|"([^"]*)")/.exec(sub);
    const fileName = name?.[1] ?? name?.[2];
    if (!fileName) continue;
    const dot = fileName.indexOf(".", 9);
    const id = fileName.slice(9, dot < 0 ? undefined : dot);
    // Only snapshot ids may be written; never let a movie overwrite a user's c-N character.
    const saved = saveSnapshot(id, sub);
    if (!saved) {
      warn(`ignoring embedded character with id ${JSON.stringify(id)}`);
      continue;
    }
    const theme = getTheme(saved) ?? "family";
    themes.add(theme);
    zip[fileName] = sub;
    ugcChars.set(id, theme);
  }

  // 3. scenes
  for (const scene of kids(film, "scene")) {
    for (const key of childNames(scene)) {
      const tag = key === "effectAsset" ? "effect" : key;
      for (const piece of kids(scene, key)) {
        switch (tag) {
          case "bg":
          case "effect":
          case "prop": {
            const val = text(kid(piece, "file"));
            if (!val) break;
            const pieces = val.split(".");
            if (pieces[0] === "ugc") break; // TODO(legacy): custom props
            const ext = pieces.pop()!;
            pieces.splice(1, 0, tag);
            pieces[pieces.length - 1] += `.${ext}`;
            const fileName = pieces.join(".");
            if (!(fileName in zip)) {
              const data = readStore(pieces);
              if (data) {
                zip[fileName] = data;
                themes.add(pieces[0]!);
              } else warn(`missing store file ${pieces.join("/")}`);
            }
            break;
          }
          case "char": {
            const val = text(kid(piece, "action"));
            const pieces = val.split(".");
            let theme = "", fileName = "";
            let buffer: Uint8Array | string | null = null;
            switch (pieces[pieces.length - 1]) {
              case "xml": {
                theme = pieces[0]!;
                const id = pieces[1]!;
                const xmlChar = loadChar(id);
                if (xmlChar === null) {
                  warn(`missing character ${id}`);
                  break;
                }
                buffer = xmlChar;
                fileName = `${theme}.char.${id}.xml`;
                if (theme === "ugc") {
                  ugcChars.set(id, getTheme(id) ?? "family");
                }
                break;
              }
              case "swf": {
                theme = pieces[0]!;
                const ch = pieces[1]!, model = pieces[2]!;
                buffer = readStore([theme, "char", ch, `${model}.swf`]);
                fileName = `${theme}.char.${ch}.${model}.swf`;
                if (!buffer) warn(`missing character swf ${fileName}`);
                break;
              }
            }

            for (const partName of ["head", "prop"] as const) {
              for (const part of kids(piece, partName)) {
                const file = text(kid(part, "file"));
                if (!file) continue;
                const slices = file.split(".");
                slices.pop();
                slices.splice(1, 0, partName === "head" ? "char" : "prop");
                const src = readStore([...slices.slice(0, -1), `${slices[slices.length - 1] ?? ""}.swf`]);
                slices.splice(1, 1, "prop");
                if (src) zip[`${slices.join(".")}.swf`] = src;
                else warn(`missing part ${file}`);
              }
            }

            if (buffer) {
              themes.add(theme);
              zip[fileName] = buffer;
            }
            break;
          }
          case "bubbleAsset": {
            const bubble = kid(piece, "bubble");
            const t = bubble && kid(bubble, "text");
            const fontName = fontFileName(t && attr(t, "font"));
            if (!fontName) break;
            const data = readFont(`${fontName}.swf`);
            if (data) zip[`${fontName}.swf`] = data;
            else warn(`missing font ${fontName}`);
            break;
          }
        }
      }
    }
  }

  // 4. embedded assets -> cache + ugc.xml listing
  for (const a of kids(film, "asset")) {
    if (!mId) break;
    const aId = attr(a, "id");
    if (!aId || !isSafeAssetId(aId)) continue;
    const raw = text(a);
    const data = useBase64(aId) ? Uint8Array.from(Buffer.from(raw, "base64")) : new TextEncoder().encode(raw);
    const duration = Math.floor(1000 * mp3Duration(data));
    const t = assetTypes[aId] ?? { subtype: "sound", name: aId };
    ugcSounds += `<sound subtype="${escapeXml(t.subtype)}" id="${escapeXml(aId)}" enc_asset_id="${escapeXml(aId)}" name="${escapeXml(t.name)}" downloadtype="progressive" duration="${duration}"/>`;
    cache.save(mId, aId, data);
  }

  if (themes.has("family")) {
    themes.delete("family");
    themes.add("custom");
  }
  if (themes.has("cc2")) {
    themes.delete("cc2");
    themes.add("action");
  }

  const themeNames = [...themes];
  for (const t of themeNames) {
    if (t === "ugc") continue;
    const file = readThemeXml(t);
    if (file) zip[`${t}.xml`] = file;
    else warn(`missing theme ${t}`);
  }
  zip["themelist.xml"] = `${XML_HEADER}<themes>${themeNames.map((t) => `<theme>${escapeXml(t)}</theme>`).join("")}</themes>`;
  const ugcCharXml = [...ugcChars].map(([id, t]) => `<char id="${escapeXml(id)}" cc_theme_id="${escapeXml(t)}"><tags/></char>`).join("");
  zip["ugc.xml"] = `${XML_HEADER}<theme id="ugc" name="ugc">${ugcCharXml}${ugcSounds}</theme>`;
  return makeZip(zip);
}

/** Build the <cc_char file_name='ugc.char.ID.xml' ...> element for a stored character document. */
export function embedCharacter(id: string, charXml: string): string {
  let body = charXml.replace(/^﻿?\s*<\?xml[^>]*\?>\s*/, "");
  const m = /^<cc_char\b/.exec(body);
  if (!m) return "";
  body = body.slice(m[0].length);
  // drop an existing file_name attribute (characters that were embedded before)
  body = body.replace(/^(\s+)file_name=(?:'[^']*'|"[^"]*")/, "$1").replace(/^\s+(?=[\s>/])/, "");
  return `<cc_char file_name='ugc.char.${id}.xml'${/^[\s>/]/.test(body) ? "" : " "}${body}`;
}

/**
 * Turn the SWF's save zip into the XML stored on disk: ugc references to characters are rewritten
 * to snapshot ids and the referenced characters, cached assets and thumbnail are embedded.
 */
export function unpackMovie(zipBytes: Uint8Array, thumb: Uint8Array | null, movieKey: string | null): string {
  const entries = readZip(zipBytes);
  const movie = entries["movie.xml"];
  if (!movie) throw new Error("zip has no movie.xml");
  const full = new TextDecoder().decode(movie);
  if (!/<\/film>\s*$/.test(full)) throw new Error("movie.xml is not a complete <film> document");
  const main = full.replace(/<\/film>\s*$/, "");

  const time = Date.now();
  const charMap = new Map<string, string>();
  const charXml = new Map<string, string>();
  const assetHash = new Set<string>();
  let out = "";
  let last = 0;

  for (const m of main.matchAll(/ugc\.([^<]*)/g)) {
    const assetId = m[1]!;
    const start = m.index! + 4;
    out += main.slice(last, start);
    last = start + assetId.length;

    const dash = assetId.indexOf("-");
    const prefix = dash < 0 ? "" : assetId.slice(0, dash);
    const dot = assetId.indexOf(".");
    if ((prefix === "c" || prefix === "C") && dot > 0) {
      const charId = assetId.slice(0, dot);
      const parsed = parseCharId(charId);
      let saveId = charMap.get(charId);
      if (!saveId) {
        // snapshots are immutable, so keep their id and avoid growing the saved folder on every save
        saveId = parsed?.kind === "snapshot" ? charId : `C-${charMap.size}-${time}`;
        charMap.set(charId, saveId);
        const x = loadChar(charId);
        if (x !== null) charXml.set(saveId, x);
      }
      out += saveId + assetId.slice(dot);
    } else {
      out += assetId;
      assetHash.add(assetId);
    }
  }
  out += main.slice(last);

  if (movieKey) {
    const table = cache.table(movieKey);
    for (const [aId, data] of Object.entries(table)) {
      if (!assetHash.has(aId)) continue;
      const body = useBase64(aId) ? Buffer.from(data).toString("base64") : escapeXml(new TextDecoder().decode(data));
      out += `<asset id="${aId}">${body}</asset>`;
    }
  }

  for (const [id, xml] of charXml) out += embedCharacter(id, xml);
  if (thumb) out += `<thumb>${Buffer.from(thumb).toString("base64")}</thumb>`;
  return `${out}</film>`;
}

/** Extract the base64 <thumb> payload of a stored movie XML, if any. */
export function extractThumb(xml: string): Uint8Array | null {
  const beg = xml.lastIndexOf("<thumb>");
  const end = xml.lastIndexOf("</thumb>");
  if (beg < 0 || end < 0 || end < beg) return null;
  const b = Buffer.from(xml.slice(beg + 7, end), "base64");
  return b.length ? new Uint8Array(b) : null;
}
