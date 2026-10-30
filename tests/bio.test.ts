// Link-in-bio pages at yoy.fyi/@handle: valid, invalid and empty input.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { reset, testDb } from "./helpers";
import { ORIGIN, webApp } from "./web-helpers";

let sql: SQL;
let now: Date;
let web: ReturnType<typeof webApp>;
let app: typeof web.app;
let cookie: string;
let ids: Record<string, string>;

const get = (path: string, c = cookie) => web.get(path, c);
const post = (path: string, fields: Record<string, string | string[]>, c = cookie, origin = ORIGIN) => web.post(path, fields, c, origin);
const signIn = async (sub: string, email: string) => (await web.signIn(sub, email)).cookie;
async function linkFor(c: string, code: string, title?: string) {
  const res = await post("/links", { target_url: `https://example.com/${code}`, code, ...(title ? { title } : {}) }, c);
  return new URL(res.headers.get("location")!, ORIGIN).searchParams.get("created")!;
}
const save = (fields: Record<string, string | string[]>, c = cookie) =>
  post("/account/bio", { handle: "ann", title: "Ann's links", description: "Events in Lviv", link: [], ...fields }, c);

beforeAll(async () => {
  sql = await testDb();
});

beforeEach(async () => {
  await reset(sql);
  now = new Date("2026-10-24T12:00:00Z");
  web = webApp(sql, () => now);
  app = web.app;
  cookie = await signIn("g-ann", "ann@example.com");
  ids = { gig: await linkFor(cookie, "gig", "Concert"), talk: await linkFor(cookie, "talk"), hidden: await linkFor(cookie, "hidden") };
});

describe("editing the page", () => {
  test("the form lists the user's links to choose from", async () => {
    const html = await (await get("/account/bio")).text();
    expect(html).toContain('name="handle"');
    expect(html).toContain(`value="${ids.gig}"`);
  });

  test("saving publishes the page with the chosen links, as short links, in list order", async () => {
    expect((await save({ link: [ids.gig!, ids.talk!] })).status).toBe(303);
    const res = await get("/@ann", "");
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("Ann&#39;s links");
    expect(html).toContain("Events in Lviv");
    expect(html).toContain('href="https://yoy.fyi/gig"');
    expect(html).toContain(">Concert<");
    expect(html).toContain('href="https://yoy.fyi/talk"');
    expect(html).not.toContain("hidden");
    expect(html.indexOf("/talk")).toBeLessThan(html.indexOf("/gig"));
    expect(html).toContain('<meta property="og:title" content="Ann&#39;s links"/>');
  });

  test("the form shows the saved page with its links ticked", async () => {
    await save({ link: [ids.gig!] });
    const html = await (await get("/account/bio")).text();
    expect(html).toContain('value="ann"');
    expect(html).toMatch(new RegExp(`value="${ids.gig}" checked`));
    expect(html).not.toMatch(new RegExp(`value="${ids.talk}" checked`));
  });

  test("the handle is lower-cased, and saving again updates the page", async () => {
    await save({ handle: "Ann" });
    await save({ handle: "ann", title: "New title" });
    expect(await (await get("/@ann", "")).text()).toContain("New title");
  });

  test("empty title, description and links make a bare page", async () => {
    expect((await save({ title: "", description: "" })).status).toBe(303);
    expect((await get("/@ann", "")).status).toBe(200);
  });

  test.each([
    ["an empty handle", { handle: "" }, "handle"],
    ["a two-letter handle", { handle: "ab" }, "handle"],
    ["a handle with spaces", { handle: "an n" }, "handle"],
    ["a 31-character handle", { handle: "a".repeat(31) }, "handle"],
    ["a reserved handle", { handle: "admin" }, "taken"],
    ["a title over 100 characters", { title: "t".repeat(101) }, "title"],
    ["a description over 300 characters", { description: "d".repeat(301) }, "description"],
    ["more than 30 links", { link: Array.from({ length: 31 }, () => crypto.randomUUID()) }, "30"],
  ])("%s is refused with 422", async (_, fields, message) => {
    const res = await save(fields);
    expect(res.status).toBe(422);
    expect(await res.text()).toContain(message);
    expect(await sql`select 1 from bio_pages`).toHaveLength(0);
  });

  test("another user's handle is taken; another user's links are refused", async () => {
    const bob = await signIn("g-bob", "bob@example.com");
    const bobLink = await linkFor(bob, "boblink");
    await save({}, cookie);
    expect((await save({}, bob)).status).toBe(422);
    expect((await save({ handle: "annfake", link: [bobLink] })).status).toBe(422);
  });

  test("needs a session and our own Origin", async () => {
    expect((await get("/account/bio", "")).status).toBe(302);
    expect((await save({}, "")).status).toBe(401);
    expect((await post("/account/bio", { handle: "ann" }, cookie, "https://evil.example")).status).toBe(403);
  });
});

describe("the public page", () => {
  test("a disabled link drops off the page", async () => {
    await save({ link: [ids.gig!, ids.talk!] });
    await post(`/links/${ids.gig}/disable`, {});
    expect(await (await get("/@ann", "")).text()).not.toContain("/gig");
  });

  test.each([
    ["en-GB,en;q=0.9", "en", "Privacy"],
    ["fr-FR", "fr", "Confidentialité"],
    ["de-DE", "uk", "Конфіденційність"],
    ["", "uk", "Конфіденційність"],
  ])("with Accept-Language %p the page frame is in %s", async (header, lang, privacy) => {
    await save({});
    const res = await app.request(`${ORIGIN}/@ann`, { headers: header ? { "accept-language": header } : {} });
    const html = await res.text();
    expect(html).toContain(`<html lang="${lang}">`);
    expect(html).toContain(`<a href="/privacy">${privacy}</a>`);
  });

  test.each(["/@nobody", "/@x", "/@"])("%s is 404", async (path) => {
    expect((await get(path, "")).status).toBe(404);
  });

  test("a blocked user's page is gone", async () => {
    await save({});
    await sql`update users set disabled_at = now()`;
    expect((await get("/@ann", "")).status).toBe(404);
  });
});
