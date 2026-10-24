// Custom social previews: link-preview bots get a page with Open Graph tags, people a redirect.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { createApp } from "../src/app";
import { issueKey } from "../src/keys";
import { reset, testDb } from "./helpers";

const TELEGRAM = "TelegramBot (like TwitterBot)";
const FACEBOOK = "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";
const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const PREVIEW = { title: "Lviv concert", description: "Saturday, 19:00", image: "https://cdn.example/poster.jpg" };

let sql: SQL;
let app: ReturnType<typeof createApp>;
let token: string;

beforeAll(async () => {
  sql = await testDb();
  app = createApp({ sql, publicOrigin: "https://yoy.fyi", countryOf: () => null, resolveHost: async () => ["93.184.215.14"] });
});

beforeEach(async () => {
  await reset(sql);
  ({ token } = await issueKey(sql, { serviceSlug: "yoy", name: "k", scopes: ["links:write", "links:read"] }));
});

const call = (method: string, path: string, body?: unknown) =>
  app.request(`https://yoy.fyi${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const visit = (code: string, ua: string) => app.request(`https://yoy.fyi/${code}`, { headers: { "user-agent": ua } });

describe("preview in the API", () => {
  test("create stores a preview and returns it; links without one have null", async () => {
    const res = await call("POST", "/v1/links", { target_url: "https://example.com/", code: "gig", preview: PREVIEW });
    expect(res.status).toBe(201);
    expect((await res.json()).preview).toEqual(PREVIEW);
    expect((await (await call("POST", "/v1/links", { target_url: "https://example.com/" })).json()).preview).toBeNull();
  });

  test("title alone is enough; update changes it and null removes it", async () => {
    const { id } = await (await call("POST", "/v1/links", { target_url: "https://example.com/", preview: { title: "T" } })).json();
    expect((await (await call("PATCH", `/v1/links/${id}`, { preview: PREVIEW })).json()).preview).toEqual(PREVIEW);
    expect((await (await call("PATCH", `/v1/links/${id}`, { preview: null })).json()).preview).toBeNull();
  });

  test.each([
    ["a string", "hello"],
    ["an empty object", {}],
    ["an empty title", { title: "" }],
    ["a title over 200 characters", { title: "t".repeat(201) }],
    ["a description over 500 characters", { title: "T", description: "d".repeat(501) }],
    ["an http image", { title: "T", image: "http://cdn.example/a.jpg" }],
    ["an image that is not a URL", { title: "T", image: "poster.jpg" }],
    ["an image URL over 2048 characters", { title: "T", image: `https://cdn.example/${"a".repeat(2048)}` }],
    ["an unknown key", { title: "T", video: "https://cdn.example/v.mp4" }],
  ])("%s is refused with validation_failed on preview", async (_, preview) => {
    const res = await call("POST", "/v1/links", { target_url: "https://example.com/", preview });
    expect(res.status).toBe(422);
    expect((await res.json()).error.details.fields).toHaveProperty("preview");
  });
});

test.each([
  ["a private address", "https://127.0.0.1/a.jpg", "private_address"],
  ["yoy.fyi itself", "https://yoy.fyi/static/a.jpg", "own_host"],
])("a preview image at %s is refused like a target", async (_, image, reason) => {
  const res = await call("POST", "/v1/links", { target_url: "https://example.com/", preview: { title: "T", image } });
  expect(res.status).toBe(422);
  expect((await res.json()).error).toMatchObject({ code: "target_rejected", details: { reason, field: "preview.image" } });
});

describe("the short link with a preview", () => {
  beforeEach(async () => {
    await call("POST", "/v1/links", { target_url: "https://example.com/gig?x=1", code: "gig", preview: PREVIEW });
    await call("POST", "/v1/links", { target_url: "https://example.com/plain", code: "plain" });
  });

  test.each([
    ["Telegram", TELEGRAM],
    ["Facebook", FACEBOOK],
  ])("%s gets the Open Graph page and the click is recorded as a bot", async (_, ua) => {
    const res = await visit("gig", ua);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toStartWith("text/html");
    expect(html).toContain('<meta property="og:title" content="Lviv concert">');
    expect(html).toContain('<meta property="og:description" content="Saturday, 19:00">');
    expect(html).toContain('<meta property="og:image" content="https://cdn.example/poster.jpg">');
    expect(html).toContain('<meta property="og:url" content="https://yoy.fyi/gig">');
    expect(html).toContain('<meta property="og:site_name" content="example.com">');
    expect(html).toContain('<meta http-equiv="refresh" content="0;url=https://example.com/gig?x=1">');
    expect((await sql`select is_bot from clicks`)[0].is_bot).toBe(true);
  });

  test("a person is redirected as before", async () => {
    const res = await visit("gig", CHROME);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://example.com/gig?x=1");
  });

  test("a bot on a link without a preview is redirected, so it reads the target's own tags", async () => {
    expect((await visit("plain", TELEGRAM)).status).toBe(302);
  });

  test("preview text is HTML-escaped", async () => {
    await call("POST", "/v1/links", { target_url: "https://example.com/", code: "xss", preview: { title: '"><script>alert(1)</script>' } });
    const html = await (await visit("xss", TELEGRAM)).text();
    expect(html).not.toContain("<script>");
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
  });
});
