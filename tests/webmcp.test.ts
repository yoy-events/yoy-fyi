// The JSON endpoints behind WebMCP (/static/webmcp.js): a browser's built-in agent calls them with
// the signed-in user's session, so they follow the same rules as the site's forms.
// Valid, invalid and empty input, and other users' links.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { reset, testDb } from "./helpers";
import { ORIGIN, webApp } from "./web-helpers";

let sql: SQL;
let now: Date;
let web: ReturnType<typeof webApp>;
let cookie: string;

beforeAll(async () => {
  sql = await testDb();
});

beforeEach(async () => {
  await reset(sql);
  now = new Date("2026-10-24T12:00:00Z");
  web = webApp(sql, () => now);
  ({ cookie } = await web.signIn());
});

const json = (method: string, path: string, body?: unknown, opts: { cookie?: string; origin?: string } = {}) =>
  web.app.request(`${ORIGIN}${path}`, {
    method,
    headers: { "content-type": "application/json", cookie: opts.cookie ?? cookie, ...(method === "GET" ? {} : { origin: opts.origin ?? ORIGIN }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const create = (body: unknown, opts?: { cookie?: string; origin?: string }) => json("POST", "/account/agent/links", body, opts);

describe("create", () => {
  test("creates a link marked webmcp and returns it with its QR as a PNG data URI", async () => {
    const res = await create({ target_url: "https://example.com/a", title: "Gig", tags: ["music"], code: "gig" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ code: "gig", short_url: `${ORIGIN}/gig`, title: "Gig", tags: ["music"] });
    expect(body.qr_png).toMatch(/^data:image\/png;base64,/);
    expect((await sql`select created_via from links`)[0].created_via).toBe("webmcp");
  });

  test("the call is logged for the AI usage page", async () => {
    await create({ target_url: "https://example.com/a" });
    expect(await sql`select client, tool, ok from mcp_calls`).toEqual([{ client: "webmcp", tool: "create_link", ok: true }]);
  });

  test.each([
    ["an empty body", {}],
    ["an empty target", { target_url: "" }],
    ["a non-http target", { target_url: "ftp://example.com/" }],
    ["a private target", { target_url: "http://127.0.0.1/" }],
    ["a bad code", { target_url: "https://example.com/", code: "no spaces" }],
    ["tags that are not a list", { target_url: "https://example.com/", tags: "music" }],
  ])("%s is refused with 422 and a readable error", async (_, body) => {
    const res = await create(body);
    expect(res.status).toBe(422);
    expect(typeof (await res.json()).error).toBe("string");
    expect(await sql`select 1 from links`).toHaveLength(0);
  });

  test("a body that is not a JSON object is 400", async () => {
    expect((await create([1])).status).toBe(400);
    expect((await create("x")).status).toBe(400);
  });

  test("shares the per-user limit of the create form", async () => {
    for (let i = 0; i < 20; i++) expect((await create({ target_url: `https://example.com/${i}` })).status).toBe(201);
    expect((await create({ target_url: "https://example.com/x" })).status).toBe(429);
  });

  test("needs a session and our own Origin", async () => {
    expect((await create({ target_url: "https://example.com/" }, { cookie: "" })).status).toBe(401);
    expect((await create({ target_url: "https://example.com/" }, { origin: "https://evil.example" })).status).toBe(403);
    expect(await sql`select 1 from links`).toHaveLength(0);
  });

  test("a write with no Origin at all is refused", async () => {
    const res = await web.app.request(`${ORIGIN}/account/agent/links`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ target_url: "https://example.com/" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("list, get and disable", () => {
  let id: string;
  beforeEach(async () => {
    id = (await (await create({ target_url: "https://lviv.example/concert", title: "Lviv concert", tags: ["music"] })).json()).id;
    await create({ target_url: "https://kyiv.example/talk", title: "Kyiv talk" });
  });

  test("list searches by text and tag", async () => {
    const titles = async (q: string) => (await (await json("GET", `/account/agent/links?${q}`)).json()).links.map((l: { title: string }) => l.title);
    expect(await titles("")).toEqual(["Kyiv talk", "Lviv concert"]);
    expect(await titles("q=concert")).toEqual(["Lviv concert"]);
    expect(await titles("tag=music")).toEqual(["Lviv concert"]);
    expect(await titles("q=nope")).toEqual([]);
  });

  test("get returns the link with 30-day clicks and its QR", async () => {
    const body = await (await json("GET", `/account/agent/links/${id}`)).json();
    expect(body).toMatchObject({ id, title: "Lviv concert", clicks_30d: 0 });
    expect(body.qr_png).toMatch(/^data:image\/png/);
    expect(Array.isArray(body.top_sources)).toBe(true);
  });

  test("disable takes the link down", async () => {
    expect((await json("POST", `/account/agent/links/${id}/disable`)).status).toBe(200);
    expect((await sql`select disabled_by from links where id = ${id}`)[0].disabled_by).toBe("owner");
  });

  test.each([
    ["an unknown id", "00000000-0000-0000-0000-000000000000"],
    ["a malformed id", "nope"],
  ])("get and disable of %s are 404", async (_, other) => {
    expect((await json("GET", `/account/agent/links/${other}`)).status).toBe(404);
    expect((await json("POST", `/account/agent/links/${other}/disable`)).status).toBe(404);
  });

  test("another user's link is 404 for get and disable", async () => {
    const { cookie: bob } = await web.signIn("google-2", "bob@example.com");
    expect((await json("GET", `/account/agent/links/${id}`, undefined, { cookie: bob })).status).toBe(404);
    expect((await json("POST", `/account/agent/links/${id}/disable`, undefined, { cookie: bob })).status).toBe(404);
    expect((await json("GET", "/account/agent/links", undefined, { cookie: bob })).status).toBe(200);
    expect((await (await json("GET", "/account/agent/links", undefined, { cookie: bob })).json()).links).toEqual([]);
    expect((await sql`select disabled_at from links where id = ${id}`)[0].disabled_at).toBeNull();
  });
});

describe("the script", () => {
  test("is served from our origin and loaded only on signed-in pages", async () => {
    const js = await web.app.request(`${ORIGIN}/static/webmcp.js`);
    expect(js.headers.get("content-type")).toStartWith("text/javascript");
    const code = await js.text();
    for (const name of ["create_link", "list_links", "get_link", "disable_link"]) expect(code).toContain(name);
    expect(await (await web.get("/", cookie)).text()).toContain('src="/static/webmcp.js"');
    expect(await (await web.get("/")).text()).not.toContain("webmcp.js");
    // Without connect-src the script's fetch calls would be blocked by the page's CSP.
    expect((await web.get("/", cookie)).headers.get("content-security-policy")).toContain("connect-src 'self'");
  });
});
