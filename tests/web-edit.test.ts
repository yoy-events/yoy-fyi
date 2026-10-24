// Editing and re-enabling a link from its page: valid, invalid and empty input.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { createApp } from "../src/app";
import { reset, testAdmin, testDb } from "./helpers";

const ORIGIN = "https://yoy.fyi";
const CLIENT_ID = "123-test.apps.googleusercontent.com";
const UNSAFE = "https://phish.example/login";

let sql: SQL;
let now: Date;
let app: ReturnType<typeof createApp>;
let claims: Record<string, unknown>;
let cookie: string;
let id: string;

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
const cookies = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .filter((c) => !c.endsWith("="))
    .join("; ");
const get = (path: string, c = cookie) => app.request(`${ORIGIN}${path}`, { headers: c ? { cookie: c } : {} });
const post = (path: string, fields: Record<string, string>, c = cookie, origin = ORIGIN) =>
  app.request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin, cookie: c },
    body: new URLSearchParams(fields).toString(),
  });

async function signIn(sub: string, email: string) {
  const start = await get("/login/google", "");
  const to = new URL(start.headers.get("location")!);
  claims = {
    iss: "https://accounts.google.com",
    aud: CLIENT_ID,
    sub,
    email,
    email_verified: true,
    nonce: to.searchParams.get("nonce"),
    exp: now.getTime() / 1000 + 3600,
  };
  return cookies(await get(`/admin/login/google/callback?code=c&state=${to.searchParams.get("state")}`, cookies(start)));
}

const link = async () => (await sql`select * from links where id = ${id}`)[0];
const edit = (fields: Record<string, string>, c = cookie) =>
  post(`/links/${id}`, { target_url: "https://example.com/new", title: "", tags: "", expires_at: "", ...fields }, c);

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
    unsafeUrls: async (urls) => new Set(urls.filter((u) => u === UNSAFE)),
    admin: {
      ...mail.admin,
      google: { clientId: CLIENT_ID, clientSecret: "s", exchange: async () => Response.json({ id_token: `${b64({})}.${b64(claims)}.sig` }) },
    },
  });
  cookie = await signIn("g-ann", "ann@example.com");
  const res = await post("/links", { target_url: "https://example.com/old", title: "Old", tags: "a, b", code: "annlink" });
  id = new URL(res.headers.get("location")!, ORIGIN).searchParams.get("created")!;
});

describe("editing a link", () => {
  test("the link page shows an edit form with the current values", async () => {
    const html = await (await get(`/links/${id}`)).text();
    expect(html).toContain(`action="/links/${id}"`);
    expect(html).toContain('value="https://example.com/old"');
    expect(html).toContain('value="Old"');
    expect(html).toContain('value="a, b"');
  });

  test("valid changes are saved and the short link follows the new target", async () => {
    const res = await edit({ title: "New", tags: "x, y ,", expires_at: "2027-01-31T10:00" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/links/${id}`);
    expect(await link()).toMatchObject({ target_url: "https://example.com/new", title: "New", tags: ["x", "y"] });
    expect((await link()).expires_at.toISOString()).toBe("2027-01-31T10:00:00.000Z");
    expect((await get("/annlink", "")).headers.get("location")).toBe("https://example.com/new");
  });

  test("a preview is saved, shown in the form, and cleared when its fields are empty", async () => {
    await edit({ preview_title: "Gig", preview_description: "Sat", preview_image: "https://cdn.example/p.jpg" });
    expect((await link()).preview).toEqual({ title: "Gig", description: "Sat", image: "https://cdn.example/p.jpg" });
    expect(await (await get(`/links/${id}`)).text()).toContain('value="https://cdn.example/p.jpg"');
    await edit({});
    expect((await link()).preview).toBeNull();
  });

  test.each([
    ["a preview image without a title", { preview_image: "https://cdn.example/p.jpg" }],
    ["an http preview image", { preview_title: "Gig", preview_image: "http://cdn.example/p.jpg" }],
  ])("%s is refused with 422", async (_, fields) => {
    const res = await edit(fields);
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("preview");
    expect((await link()).preview).toBeNull();
  });

  test("the create form's More options take a preview", async () => {
    const res = await post("/links", { target_url: "https://example.com/p", code: "withprev", preview_title: "Hello" });
    expect(res.status).toBe(303);
    expect((await sql`select preview from links where code = 'withprev'`)[0].preview).toEqual({ title: "Hello" });
  });

  test("empty title, tags and expiry clear them", async () => {
    await edit({ expires_at: "2027-01-31T10:00" });
    expect((await edit({})).status).toBe(303);
    expect(await link()).toMatchObject({ title: null, tags: [], expires_at: null });
  });

  test.each([
    ["an empty target", { target_url: "" }, "target_url"],
    ["a target that is not a URL", { target_url: "not a url" }, "not allowed"],
    ["a non-http target", { target_url: "ftp://example.com/" }, "not allowed"],
    ["an unsafe target", { target_url: UNSAFE }, "unsafe"],
    ["a title over 200 characters", { title: "t".repeat(201) }, "title"],
    ["an expiry in the past", { expires_at: "2020-01-01T00:00" }, "expires_at"],
    ["a malformed expiry", { expires_at: "tomorrow" }, "expires_at"],
  ])("%s is refused with 422 and nothing changes", async (_, fields, message) => {
    const res = await edit(fields);
    expect(res.status).toBe(422);
    expect(await res.text()).toContain(message);
    expect(await link()).toMatchObject({ target_url: "https://example.com/old", title: "Old" });
  });

  test("a disabled link cannot be edited", async () => {
    await post(`/links/${id}/disable`, {});
    expect((await edit({})).status).toBe(409);
    expect((await link()).target_url).toBe("https://example.com/old");
  });

  test.each([
    ["another user's link", "other"],
    ["an unknown id", "00000000-0000-0000-0000-000000000000"],
    ["a malformed id", "nope"],
  ])("editing %s is 404", async (_, which) => {
    const bob = await signIn("g-bob", "bob@example.com");
    const target = which === "other" ? id : which;
    const res = await post(`/links/${target}`, { target_url: "https://evil.example/" }, which === "other" ? bob : cookie);
    expect(res.status).toBe(404);
    expect((await link()).target_url).toBe("https://example.com/old");
  });

  test("needs a session and our own Origin", async () => {
    expect((await edit({}, "")).status).toBe(401);
    expect((await post(`/links/${id}`, { target_url: "https://example.com/new" }, cookie, "https://evil.example")).status).toBe(403);
  });
});

describe("enabling a disabled link", () => {
  test("a disabled link offers Enable, and enabling makes it redirect again", async () => {
    await post(`/links/${id}/disable`, {});
    expect(await (await get(`/links/${id}`)).text()).toContain(`action="/links/${id}/enable"`);
    expect((await get("/annlink", "")).status).toBe(410);

    const res = await post(`/links/${id}/enable`, {});
    expect(res.status).toBe(303);
    expect((await link()).disabled_at).toBeNull();
    expect((await get("/annlink", "")).status).toBe(302);
  });

  test.each(["admin", "safe_browsing", null])("a link disabled by %p cannot be enabled by its owner", async (by) => {
    await sql`update links set disabled_at = ${now}, disabled_by = ${by} where id = ${id}`;
    expect(await (await get(`/links/${id}`)).text()).not.toContain(`action="/links/${id}/enable"`);
    expect((await post(`/links/${id}/enable`, {})).status).toBe(422);
    expect((await link()).disabled_at).not.toBeNull();
  });

  test("a link whose target is now unsafe stays disabled", async () => {
    await sql`update links set target_url = ${UNSAFE}, disabled_at = ${now}, disabled_by = 'owner' where id = ${id}`;
    const res = await post(`/links/${id}/enable`, {});
    expect(res.status).toBe(422);
    expect((await link()).disabled_at).not.toBeNull();
  });

  test("enabling an active link changes nothing", async () => {
    expect((await post(`/links/${id}/enable`, {})).status).toBe(303);
    expect((await link()).disabled_at).toBeNull();
  });

  test.each([
    ["another user's link", "other"],
    ["an unknown id", "00000000-0000-0000-0000-000000000000"],
    ["a malformed id", "nope"],
  ])("enabling %s is 404", async (_, which) => {
    await post(`/links/${id}/disable`, {});
    const bob = await signIn("g-bob", "bob@example.com");
    const res = await post(`/links/${which === "other" ? id : which}/enable`, {}, which === "other" ? bob : cookie);
    expect(res.status).toBe(404);
    expect((await link()).disabled_at).not.toBeNull();
  });

  test("needs a session", async () => {
    expect((await post(`/links/${id}/enable`, {}, "")).status).toBe(401);
  });
});

describe("links for channels", () => {
  test("the link page offers a copyable short link per channel with utm_source and utm_medium", async () => {
    const html = await (await get(`/links/${id}`)).text();
    for (const [source, medium] of [
      ["telegram", "social"],
      ["instagram", "social"],
      ["facebook", "social"],
      ["email", "email"],
    ]) {
      const url = `${ORIGIN}/annlink?utm_source=${source}&amp;utm_medium=${medium}`;
      expect(html).toContain(`data-copy="${url}"`);
    }
  });

  test("a channel link records its source on the click and reaches the target", async () => {
    const res = await get("/annlink?utm_source=telegram&utm_medium=social", "");
    expect(res.headers.get("location")).toBe("https://example.com/old?utm_source=telegram&utm_medium=social");
    expect((await sql`select utm_source, utm_medium from clicks`)[0]).toEqual({ utm_source: "telegram", utm_medium: "social" });
  });
});
