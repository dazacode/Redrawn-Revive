import { describe, expect, test } from "bun:test";
import { strFromU8 } from "fflate";
import { handle } from "../src/app.ts";
import { ensureDirs } from "../src/storage.ts";
import { readZip } from "../src/zip.ts";

ensureDirs();
const B = "http://localhost:4343";
const call = (path: string, init?: RequestInit) => handle(new Request(B + path, init), "127.0.0.1");
const post = (path: string, body: unknown) =>
  call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64").toString("base64");
const FILM = `<film duration="3"><meta><title><![CDATA[Studio test]]></title></meta><scene id="s1"><bg id="b"><file>common.Diner_bg.swf</file></bg></scene></film>`;

describe("studio save API", () => {
  test("/studio serves the page when present", async () => {
    const r = await call("/studio");
    expect([200, 404]).toContain(r.status);
  });

  test("rejects bad input", async () => {
    expect((await post("/api/movies/save", { xml: "nope" })).status).toBe(400);
    const r = await call("/api/movies/save", { method: "POST", body: "{" });
    expect(r.status).toBe(400);
  });

  test("save -> list, xml, legacy getMovie zip", async () => {
    const { movieId } = (await (await call("/ajax/movie/presave")).json()) as { movieId: string };
    const res = await post("/api/movies/save", { xml: FILM, presaveId: movieId, thumbnail: PNG });
    expect(res.status).toBe(200);
    const saved = ((await res.json()) as { movieId: string }).movieId;
    expect(saved).toBe(movieId);

    const list = (await (await call("/ajax/movie/list")).json()) as { id: string; title: string }[];
    expect(list.find((m) => m.id === saved)?.title).toBe("Studio test");

    const stored = await (await call(`/movies/${saved}.xml`)).text();
    expect(stored).toContain("<thumb>");
    expect(stored.match(/<thumb>/g)!.length).toBe(1);

    // saving again with the stored XML (which already holds <thumb>) must not duplicate it
    const again = await post("/api/movies/save", { xml: stored, movieId: saved });
    expect(again.status).toBe(200);
    expect((await (await call(`/movies/${saved}.xml`)).text()).match(/<thumb>/g)!.length).toBe(1);

    const gm = new Uint8Array(await (await call(`/goapi/getMovie?movieId=${saved}`, { method: "POST" })).arrayBuffer());
    expect(gm[0]).toBe(0);
    const files = readZip(gm.subarray(1));
    expect(strFromU8(files["movie.xml"]!)).toContain("Studio test");
    expect(files["themelist.xml"]).toBeDefined();
  });
});
