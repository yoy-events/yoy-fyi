// Search and tag filter on My links: valid, invalid and empty input.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { reset, testDb } from "./helpers";
import { webApp } from "./web-helpers";

let sql: SQL;
let now: Date;
let web: ReturnType<typeof webApp>;
let cookie: string;

const get = (path: string, c = cookie) => web.get(path, c);
const post = (path: string, fields: Record<string, string>, c = cookie) => web.post(path, fields, c);
const signIn = async (sub: string, email: string) => (await web.signIn(sub, email)).cookie;

// The codes of the links listed on a page, in order.
const listed = async (path: string) => [...(await (await get(path)).text()).matchAll(/https:\/\/yoy\.fyi\/([A-Za-z0-9_-]+) · /g)].map((m) => m[1]);

beforeAll(async () => {
  sql = await testDb();
});

beforeEach(async () => {
  await reset(sql);
  now = new Date("2026-10-24T12:00:00Z");
  web = webApp(sql, () => now);
  cookie = await signIn("g-ann", "ann@example.com");
  await post("/links", { target_url: "https://lviv.example/concert", code: "lviv", title: "Lviv concert", tags: "music, lviv" });
  await post("/links", { target_url: "https://kyiv.example/talk", code: "kyiv", title: "Kyiv talk", tags: "talks" });
  await post("/links", { target_url: "https://example.com/100%_off", code: "sale" });
  const bob = await signIn("g-bob", "bob@example.com");
  await post("/links", { target_url: "https://lviv.example/bob", code: "boblviv", tags: "music" }, bob);
});

describe("My links search", () => {
  test("no filter lists all of the user's links, newest first, and offers their tags", async () => {
    expect(await listed("/")).toEqual(["sale", "kyiv", "lviv"]);
    const html = await (await get("/")).text();
    expect(html).toContain('href="/?tag=music"');
    expect(html).toContain('href="/?tag=talks"');
  });

  test.each([
    ["the title", "concert", ["lviv"]],
    ["the code, case-insensitively", "KYIV", ["kyiv"]],
    ["the target", "kyiv.example", ["kyiv"]],
    ["LIKE wildcards literally", "100%_", ["sale"]],
    ["a bare % only literally", "%", ["sale"]],
    ["nothing", "nope", []],
  ])("q matches %s", async (_, q, codes) => {
    expect(await listed(`/?q=${encodeURIComponent(q)}`)).toEqual(codes);
  });

  test("tag filters to links with that tag, never another user's", async () => {
    expect(await listed("/?tag=music")).toEqual(["lviv"]);
  });

  test("q and tag combine", async () => {
    expect(await listed("/?q=kyiv&tag=music")).toEqual([]);
    expect(await listed("/?q=lviv&tag=music")).toEqual(["lviv"]);
  });

  test.each([
    ["empty q and tag", "/?q=&tag="],
    ["blank q", "/?q=%20%20"],
  ])("%s means no filter", async (_, path) => {
    expect(await listed(path)).toEqual(["sale", "kyiv", "lviv"]);
  });

  test("a filter with no matches says so and keeps the search", async () => {
    const html = await (await get("/?q=nope")).text();
    expect(html).toContain("Нічого не знайдено");
    expect(html).toContain('value="nope"');
  });

  test("an over-long q is cut, not an error", async () => {
    expect((await get(`/?q=${"a".repeat(1000)}`)).status).toBe(200);
  });
});
