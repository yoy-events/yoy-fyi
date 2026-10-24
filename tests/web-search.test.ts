// Search and tag filter on My links: valid, invalid and empty input.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { createApp } from "../src/app";
import { reset, testAdmin, testDb } from "./helpers";

const ORIGIN = "https://yoy.fyi";
const CLIENT_ID = "123-test.apps.googleusercontent.com";

let sql: SQL;
let now: Date;
let app: ReturnType<typeof createApp>;
let claims: Record<string, unknown>;
let cookie: string;

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
const cookies = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .filter((c) => !c.endsWith("="))
    .join("; ");
const get = (path: string, c = cookie) => app.request(`${ORIGIN}${path}`, { headers: c ? { cookie: c } : {} });
const post = (path: string, fields: Record<string, string>, c = cookie) =>
  app.request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie: c },
    body: new URLSearchParams(fields).toString(),
  });

async function signIn(sub: string, email: string) {
  const start = await get("/login/google", "");
  const to = new URL(start.headers.get("location")!);
  claims = { iss: "https://accounts.google.com", aud: CLIENT_ID, sub, email, email_verified: true, nonce: to.searchParams.get("nonce"), exp: now.getTime() / 1000 + 3600 };
  return cookies(await get(`/admin/login/google/callback?code=c&state=${to.searchParams.get("state")}`, cookies(start)));
}

// The codes of the links listed on a page, in order.
const listed = async (path: string) => [...(await (await get(path)).text()).matchAll(/https:\/\/yoy\.fyi\/([A-Za-z0-9_-]+) · /g)].map((m) => m[1]);

beforeAll(async () => {
  sql = await testDb();
});

beforeEach(async () => {
  await reset(sql);
  now = new Date("2026-10-24T12:00:00Z");
  const mail = testAdmin();
  app = createApp({
    sql,
    publicOrigin: ORIGIN,
    countryOf: () => null,
    resolveHost: async () => ["93.184.215.14"],
    now: () => now,
    admin: { ...mail.admin, google: { clientId: CLIENT_ID, clientSecret: "s", exchange: async () => Response.json({ id_token: `${b64({})}.${b64(claims)}.sig` }) } },
  });
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
    expect(html).toContain("No links match");
    expect(html).toContain('value="nope"');
  });

  test("an over-long q is cut, not an error", async () => {
    expect((await get(`/?q=${"a".repeat(1000)}`)).status).toBe(200);
  });
});
