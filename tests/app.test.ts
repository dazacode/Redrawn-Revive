import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strFromU8, strToU8, zipSync } from "fflate";
import { handle } from "../src/app.ts";
import { config, dirs } from "../src/config.ts";
import { embedCharacter } from "../src/pack.ts";
import { resolveInside } from "../src/static.ts";
import { ensureDirs, listIds, migrateFolder, nextId, writeNew } from "../src/storage.ts";
import { readZip } from "../src/zip.ts";

ensureDirs();
const B = "http://localhost:4343";
const form = (o: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(o).toString(),
});
const call = (path: string, init?: RequestInit) => handle(new Request(B + path, init), "127.0.0.1");
const CHAR = `<?xml version="1.0" encoding="utf-8"?>\n<cc_char xscale='1' theme_id="family"><x/></cc_char>`;

describe("storage", () => {
  test("numbered ids", () => {
    expect(nextId("movie", "xml")).toBe(0);
    expect(writeNew("movie", "xml", "<film/>")).toBe(0);
    expect(writeNew("movie", "xml", "<film/>")).toBe(1);
    expect(listIds("movie", "xml")).toEqual([0, 1]);
    expect(nextId("movie", "xml", 10)).toBe(11);
  });
  test("migrateFolder copies without overwriting and skips markers", () => {
    const src = mkdtempSync(join(tmpdir(), "legacy-"));
    const dst = mkdtempSync(join(tmpdir(), "new-"));
    writeFileSync(join(src, "movie-0000000.xml"), "old");
    writeFileSync(join(src, "_NO_REMOVE"), "");
    writeFileSync(join(dst, "movie-0000000.xml"), "keep");
    writeFileSync(join(src, "char-0000000.xml"), "c");
    expect(migrateFolder(src, dst)).toBe(1);
    expect(readdirSync(dst).sort()).toEqual(["char-0000000.xml", "movie-0000000.xml"]);
    expect(migrateFolder(join(src, "missing"), dst)).toBe(0);
  });
});

describe("static path safety", () => {
  const root = config.assetsDir;
  test("inside root", () => expect(resolveInside(root, "/store/x/y.swf")).toBe(join(root, "store", "x", "y.swf")));
  test.each(["/../x", "/a/%2e%2e/b", "/a%2f..%2fb", "/a%5c..%5cb", "/.git/config", "/a%00b", "/%E0%A4%A", "/c:/windows"])(
    "rejects %p",
    (p) => expect(resolveInside(root, p)).toBeNull(),
  );
});

describe("characters", () => {
  test("save then load, id traversal rejected", async () => {
    const r = await call("/goapi/saveCCCharacter/", form({ body: CHAR }));
    expect(r.status).toBe(200);
    const id = (await r.text()).slice(1);
    expect(await (await call(`/characters/c-${id}.xml`)).text()).toBe(CHAR);
    expect((await call("/characters/c-..%2f..%2fpackage")).status).toBe(404);
    expect((await call("/characters/..%2f..%2fpackage.json")).status).toBe(404);
    const comp = await call("/goapi/getCcCharCompositionXml/", form({ assetId: `c-${id}` }));
    expect((await comp.text()).startsWith("0<?xml")).toBe(true);
    expect((await call("/goapi/saveCCCharacter/", form({ body: "garbage" }))).status).toBe(400);
  });
  test("stock characters come from server/characters", async () => {
    if (!existsSync(dirs.characters)) return;
    const r = await call("/goapi/getCcCharCompositionXml/", form({ assetId: "a-327068826" }));
    expect((await r.text()).startsWith("0<cc_char")).toBe(true);
  });
  test("embedCharacter injects file_name once", () => {
    const e = embedCharacter("C-0-1", CHAR);
    expect(e.startsWith("<cc_char file_name='ugc.char.C-0-1.xml' xscale='1'")).toBe(true);
    expect(embedCharacter("C-0-2", e).startsWith("<cc_char file_name='ugc.char.C-0-2.xml' xscale='1'")).toBe(true);
    expect(embedCharacter("C-0-3", "<cc_char><a/></cc_char>")).toBe("<cc_char file_name='ugc.char.C-0-3.xml'><a/></cc_char>");
  });
});

describe("themes", () => {
  test("list and get", async () => {
    const l = await call("/goapi/getThemeList/", { method: "POST" });
    expect(strFromU8(readZip(new Uint8Array(await l.arrayBuffer()))["themelist.xml"]!)).toContain("<list");
    const t = await call("/goapi/getTheme/", form({ themeId: "family" }));
    expect(Object.keys(readZip(new Uint8Array(await t.arrayBuffer())))).toEqual(["theme.xml"]);
    expect((await call("/goapi/getTheme/", form({ themeId: "../package" }))).status).toBe(404);
  });
});

describe("movies", () => {
  const movieXml = (ref: string) =>
    `<film duration="65"><meta><title><![CDATA[T]]></title></meta><scene id="s"><char id="c"><action>ugc.${ref}.xml</action></char></scene></film>`;

  test("presave allocates distinct ids without creating files", async () => {
    const before = readdirSync(dirs.saved).length;
    const a = (await (await call("/ajax/movie/presave")).json()) as { movieId: string };
    const b = (await (await call("/ajax/movie/presave")).json()) as { movieId: string };
    expect(a.movieId).not.toBe(b.movieId);
    expect(readdirSync(dirs.saved).length).toBe(before);
  });

  test("save, list, load zip; embedded character snapshot is stable across saves", async () => {
    const cr = await call("/goapi/saveCCCharacter/", form({ body: CHAR }));
    const cid = `c-${(await cr.text()).slice(1)}`;
    const { movieId } = (await (await call("/ajax/movie/presave")).json()) as { movieId: string };
    const save = (xml: string) =>
      call(
        "/goapi/saveMovie/",
        form({
          body_zip: Buffer.from(zipSync({ "movie.xml": strToU8(xml) })).toString("base64"),
          thumbnail_large: Buffer.from("PNGDATA").toString("base64"),
          presaveId: movieId,
        }),
      );
    expect(await (await save(movieXml(cid))).text()).toBe(`0${movieId}`);
    const list = (await (await call("/ajax/movie/list")).json()) as { id: string; durationString: string; title: string }[];
    expect(list.find((m) => m.id === movieId)).toMatchObject({ durationString: "01:05", title: "T" });

    const stored = await (await call(`/movies/${movieId}.xml`)).text();
    const snap = /ugc\.(C-\d+-\d+)\.xml/.exec(stored)![1]!;
    expect(stored).toContain(`<cc_char file_name='ugc.char.${snap}.xml'`);

    const files = readZip(new Uint8Array(await (await call(`/movies/${movieId}.zip`)).arrayBuffer()));
    expect(Object.keys(files)).toContain(`ugc.char.${snap}.xml`);
    expect(strFromU8(files["ugc.xml"]!)).toContain(`id="${snap}"`);

    const chars = () => readdirSync(dirs.saved).filter((f) => f.startsWith("char-")).length;
    const before = chars();
    await save(movieXml(snap));
    expect(chars()).toBe(before);

    const gm = new Uint8Array(await (await call(`/goapi/getMovie/?movieId=${movieId}`, { method: "POST" })).arrayBuffer());
    expect(gm[0]).toBe(0);
    expect(strFromU8(readZip(gm.subarray(1))["movie.xml"]!)).toContain("<film");
    expect((await call(`/deleteMovie/${movieId}`)).status).toBe(200);
  });

  test("bad ids never touch the filesystem", async () => {
    for (const id of ["m-../x", "../x", "e-1", "m-99999"]) {
      expect(await (await call(`/goapi/getMovie/?movieId=${encodeURIComponent(id)}`, { method: "POST" })).text()).toBe("1");
      expect((await call(`/movies/${encodeURIComponent(id)}.xml`)).status).toBe(404);
    }
    const zipped = Buffer.from(zipSync({ "movie.xml": strToU8("<film></film>") })).toString("base64");
    const r = await call("/goapi/saveMovie/", form({ body_zip: zipped, presaveId: "m-../../evil" }));
    expect((await r.text()).startsWith("1")).toBe(true);
  });

  test("tts failure is a clean error", async () => {
    const r = await call("/goapi/convertTextToSoundAsset/", form({ voice: "nonexistent", text: "hi", presaveId: "m-1" }));
    expect(r.status).toBe(200);
    expect((await r.text()).startsWith("1<error>")).toBe(true);
  });
});

describe("misc", () => {
  test("config urls follow the Host header and reject hostile hosts", async () => {
    const r = await handle(new Request("http://x/ajax/config", { headers: { host: "example.test:9000" } }), null);
    expect(((await r.json()) as { SWF_URL: string }).SWF_URL).toBe(`http://example.test:9000/${config.swfPath}`);
    const bad = await handle(new Request("http://x/ajax/config", { headers: { host: 'evil.com/"><script>' } }), null);
    expect(((await bad.json()) as { SWF_URL: string }).SWF_URL.startsWith("http://localhost:")).toBe(true);
  });
  test("secrets in server/ are not served", async () => {
    for (const p of ["/the.key", "/the.crt", "/README.md", "/characters/000832000.txt"]) {
      expect((await call(p)).status).toBe(404);
    }
  });
});
