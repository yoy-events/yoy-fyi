// The personal home page and account pages (ADR-0004): valid, invalid and empty input.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { type AppDeps, createApp } from "../src/app";
import { reset, testAdmin, testDb } from "./helpers";

const ORIGIN = "https://yoy.fyi";
const CLIENT_ID = "123-test.apps.googleusercontent.com";

let sql: SQL;
let now: Date;
let mail: ReturnType<typeof testAdmin>;
let app: ReturnType<typeof createApp>;
let claims: Record<string, unknown>;

const b64url = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

const build = (deps: Partial<AppDeps> = {}) =>
  createApp({
    sql,
    publicOrigin: ORIGIN,
    countryOf: () => null,
    resolveHost: async () => ["93.184.215.14"],
    now: () => now,
    admin: {
      ...mail.admin,
      google: {
        clientId: CLIENT_ID,
        clientSecret: "s",
        exchange: async () => Response.json({ id_token: `${b64url({ alg: "RS256" })}.${b64url(claims)}.sig` }),
      },
    },
    ...deps,
  });

beforeAll(async () => {
  sql = await testDb();
});

beforeEach(async () => {
  await reset(sql);
  now = new Date("2026-10-24T12:00:00Z");
  mail = testAdmin();
  app = build();
});

const cookies = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .filter((c) => !c.endsWith("="))
    .join("; ");
const get = (path: string, cookie = "") => app.request(`${ORIGIN}${path}`, { headers: cookie ? { cookie } : {} });
const post = (path: string, fields: Record<string, string | string[]>, cookie: string, headers: Record<string, string> = {}) => {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) for (const one of [v].flat()) body.append(k, one);
  return app.request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie, ...headers },
    body: body.toString(),
  });
};

// Signs in through the real Google flow (with a fake token endpoint) and returns the session cookie.
async function signIn(sub = "google-1", email = "ann@example.com", extra: Record<string, unknown> = {}) {
  const start = await get("/login/google");
  const to = new URL(start.headers.get("location")!);
  claims = {
    iss: "https://accounts.google.com",
    aud: CLIENT_ID,
    sub,
    email,
    email_verified: true,
    name: "Ann",
    nonce: to.searchParams.get("nonce"),
    exp: now.getTime() / 1000 + 3600,
    ...extra,
  };
  const res = await get(`/admin/login/google/callback?code=c&state=${to.searchParams.get("state")}`, cookies(start));
  return { res, cookie: cookies(res) };
}

async function createVia(cookie: string, fields: Record<string, string>) {
  const res = await post("/links", fields, cookie);
  const location = res.headers.get("location");
  return { res, id: location ? new URL(location, ORIGIN).searchParams.get("created") : null };
}

describe("signing in", () => {
  test("signed out, / describes yoy.fyi and offers Google sign-in", async () => {
    const res = await get("/");
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('href="/login/google"');
    expect(html).not.toContain('action="/links"');
  });

  test("the first sign-in creates the user and a personal service; the next one reuses them", async () => {
    const first = await signIn();
    expect(first.res.status).toBe(303);
    expect(first.res.headers.get("location")).toBe("/");
    await signIn();

    const users = await sql`select email, name from users`;
    const services = await sql`select slug from services where owner_user_id is not null`;
    expect(users).toEqual([{ email: "ann@example.com", name: "Ann" }]);
    expect(services).toHaveLength(1);
    expect(services[0].slug).toMatch(/^u-[a-z0-9]{10}$/);
  });

  test("Google sign-in for users asks for no login hint", async () => {
    const to = new URL((await get("/login/google")).headers.get("location")!);
    expect(to.searchParams.get("login_hint")).toBeNull();
    expect(to.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/admin/login/google/callback`);
  });

  test("an unverified Google email cannot sign in", async () => {
    const { res, cookie } = await signIn("g2", "bob@example.com", { email_verified: false });
    expect(res.status).toBe(400);
    expect(cookie).not.toContain("yfi_user");
  });

  test("a blocked user cannot sign in", async () => {
    await signIn();
    await sql`update users set disabled_at = now()`;
    expect((await signIn()).res.status).toBe(400);
  });

  test("a user session is not an admin session", async () => {
    const { cookie } = await signIn("g3", mail.admin.email);
    expect((await get("/admin", cookie)).headers.get("location")).toBe("/admin/login");
  });

  test("sign out ends the session", async () => {
    const { cookie } = await signIn();
    const out = await post("/logout", {}, cookie);
    expect(out.status).toBe(303);
    expect(out.headers.getSetCookie().some((c) => /^__Host-yfi_user=;/.test(c))).toBe(true);
  });
});

describe("home page", () => {
  test("with no links: an empty state and the create form", async () => {
    const { cookie } = await signIn();
    const html = await (await get("/", cookie)).text();
    expect(html).toContain("Create your first short link");
    expect(html).toContain('action="/links"');
  });

  test("lists only the signed-in user's links", async () => {
    const ann = (await signIn("ga", "ann@example.com")).cookie;
    const bob = (await signIn("gb", "bob@example.com")).cookie;
    await createVia(ann, { target_url: "https://example.com/ann" });
    await createVia(bob, { target_url: "https://example.com/bob" });

    const html = await (await get("/", ann)).text();
    expect(html).toContain("https://example.com/ann");
    expect(html).not.toContain("https://example.com/bob");
  });
});

describe("after creating", () => {
  test("returns to / with a card: short link, copy button, QR and downloads", async () => {
    const { cookie } = await signIn();
    const { res, id } = await createVia(cookie, { target_url: "https://example.com/a" });
    expect(res.headers.get("location")).toBe(`/?created=${id}`);

    const html = await (await get(`/?created=${id}`, cookie)).text();
    const [{ code }] = await sql`select code from links where id = ${id}`;
    const short = `${ORIGIN}/${code}`;
    expect(html).toContain(`value="${short}" readonly`);
    expect(html).toContain(`data-copy="${short}"`);
    expect(html).toContain(`src="/links/${id}/qr.svg"`);
    expect(html).toContain(`href="/links/${id}/qr.png"`);
    expect(html).toContain(`href="/links/${id}"`);
    expect(html).toContain('src="/static/copy.js"');
  });

  test.each([
    ["another user's link", "other"],
    ["a malformed id", "not-a-uuid"],
    ["an empty id", ""],
  ])("with %s there is no card", async (_, which) => {
    const ann = (await signIn("ga", "ann@example.com")).cookie;
    const bob = (await signIn("gb", "bob@example.com")).cookie;
    const { id } = await createVia(bob, { target_url: "https://example.com/b" });
    const created = which === "other" ? id : which;
    const res = await get(`/?created=${created}`, ann);
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("data-copy=");
  });

  test("the link page has a copy button too", async () => {
    const { cookie } = await signIn();
    const { id } = await createVia(cookie, { target_url: "https://example.com/a" });
    expect(await (await get(`/links/${id}`, cookie)).text()).toContain("data-copy=");
  });

  test("copy.js is served from our origin and allowed by the CSP, with no inline script", async () => {
    const js = await get("/static/copy.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toStartWith("text/javascript");
    const page = await get("/");
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(await page.text()).not.toMatch(/<script>(?!<\/script>)/);
  });
});

describe("create form", () => {
  test("shows only the long URL; everything else waits under More options", async () => {
    const { cookie } = await signIn();
    const html = await (await get("/", cookie)).text();
    const [visible, hidden] = html.split("<details");

    expect(visible).toContain('name="target_url"');
    expect(hidden).toContain("More options");
    for (const name of ["title", "code", "tags", "utm_source", "utm_medium", "utm_campaign"]) {
      expect(visible).not.toContain(`name="${name}"`);
      expect(hidden).toContain(`name="${name}"`);
    }
    expect(html).not.toMatch(/<details[^>]*open/);
  });

  test("after an error in an optional field, More options stays open with the values", async () => {
    const { cookie } = await signIn();
    const html = await (await post("/links", { target_url: "https://example.com/", code: "no spaces" }, cookie)).text();
    expect(html).toMatch(/<details[^>]*open/);
    expect(html).toContain('value="no spaces"');
  });
});

describe("POST /links", () => {
  test("valid: creates a link in the user's service, marked web, and opens it", async () => {
    const { cookie } = await signIn();
    const { res, id } = await createVia(cookie, { target_url: "https://example.com/a", title: "A", tags: "x, y" });

    expect(res.status).toBe(303);
    const [row] = await sql`select l.created_via, l.title, l.tags, s.owner_user_id is not null as owned from links l join services s on s.id = l.service_id where l.id = ${id}`;
    expect(row).toEqual({ created_via: "web", title: "A", tags: ["x", "y"], owned: true });
  });

  test.each([
    ["an empty body", {}],
    ["an empty target", { target_url: "" }],
    ["a non-http target", { target_url: "ftp://example.com/" }],
    ["a private target", { target_url: "http://127.0.0.1/" }],
    ["a bad custom code", { target_url: "https://example.com/", code: "no spaces" }],
    ["a reserved code", { target_url: "https://example.com/", code: "account" }],
  ])("%s shows the form again with an error and creates nothing", async (_, fields) => {
    const { cookie } = await signIn();
    const res = await post("/links", fields, cookie);
    expect(res.status).toBe(422);
    expect(await res.text()).toContain('class="errors"');
    const [{ count }] = await sql`select count(*)::int as count from links`;
    expect(count).toBe(0);
  });

  test("needs a session and our own Origin", async () => {
    const { cookie } = await signIn();
    expect((await post("/links", { target_url: "https://example.com/" }, "")).status).toBe(401);
    expect((await post("/links", { target_url: "https://example.com/" }, cookie, { origin: "https://evil.example" })).status).toBe(403);
  });

  test("allows 20 links an hour per user", async () => {
    const { cookie } = await signIn();
    const statuses = [];
    for (let i = 0; i < 21; i++) statuses.push((await post("/links", { target_url: `https://example.com/${i}` }, cookie)).status);
    expect(statuses.slice(0, 20).every((s) => s === 303)).toBe(true);
    expect(statuses[20]).toBe(429);
  });
});

describe("link page", () => {
  test("shows the short URL, QR codes and clicks of the user's own link", async () => {
    const { cookie } = await signIn();
    const { id } = await createVia(cookie, { target_url: "https://example.com/a" });
    const html = await (await get(`/links/${id}`, cookie)).text();
    const [{ code }] = await sql`select code from links where id = ${id}`;

    expect(html).toContain(`${ORIGIN}/${code}`);
    expect(html).toContain(`/links/${id}/qr.svg`);
    expect(html).toContain(`/links/${id}/qr.png`);
    expect((await get(`/links/${id}/qr.svg`, cookie)).headers.get("content-type")).toStartWith("image/svg+xml");
    expect((await get(`/links/${id}/qr.png`, cookie)).headers.get("content-type")).toBe("image/png");
  });

  test("another user's link, a malformed id and no session all hide it", async () => {
    const ann = (await signIn("ga", "ann@example.com")).cookie;
    const bob = (await signIn("gb", "bob@example.com")).cookie;
    const { id } = await createVia(ann, { target_url: "https://example.com/a" });

    expect((await get(`/links/${id}`, bob)).status).toBe(404);
    expect((await get(`/links/${id}/qr.svg`, bob)).status).toBe(404);
    expect((await post(`/links/${id}/disable`, {}, bob)).status).toBe(404);
    expect((await get("/links/not-a-uuid", ann)).status).toBe(404);
    expect((await get(`/links/${id}`)).headers.get("location")).toBe("/");
  });

  test("disable turns the link off", async () => {
    const { cookie } = await signIn();
    const { id } = await createVia(cookie, { target_url: "https://example.com/a" });
    expect((await post(`/links/${id}/disable`, {}, cookie)).status).toBe(303);
    const [{ code }] = await sql`select code from links where id = ${id}`;
    expect((await get(`/${code}`)).status).toBe(410);
  });
});

describe("account API keys", () => {
  test("valid: a key for the user's own service, shown once, works on /v1", async () => {
    const { cookie } = await signIn();
    const res = await post("/account/keys", { name: "my app", scope: ["links:read", "links:write"] }, cookie);
    const secret = /yfi_[A-Za-z0-9]{8}_[A-Za-z0-9]{32}/.exec(await res.text())?.[0];

    expect(res.status).toBe(201);
    const me = await app.request(`${ORIGIN}/v1/me`, { headers: { authorization: `Bearer ${secret}` } });
    expect((await me.json()).service.slug).toMatch(/^u-/);
    expect(await (await get("/account/keys", cookie)).text()).not.toContain(secret!);
  });

  test.each([
    ["an empty name", { name: "", scope: ["links:read"] }],
    ["no scopes", { name: "x" }],
    ["keys:manage", { name: "x", scope: ["keys:manage"] }],
    ["an unknown scope", { name: "x", scope: ["links:delete"] }],
    ["a name over 100 characters", { name: "x".repeat(101), scope: ["links:read"] }],
  ])("%s is refused with 422", async (_, fields) => {
    const { cookie } = await signIn();
    expect((await post("/account/keys", fields, cookie)).status).toBe(422);
  });

  test("revoking stops the key; another user's key cannot be revoked", async () => {
    const ann = (await signIn("ga", "ann@example.com")).cookie;
    const bob = (await signIn("gb", "bob@example.com")).cookie;
    const secret = /yfi_[A-Za-z0-9]{8}_[A-Za-z0-9]{32}/.exec(await (await post("/account/keys", { name: "k", scope: ["links:read"] }, ann)).text())![0];
    const [{ id }] = await sql`select id from api_keys`;

    expect((await post(`/account/keys/${id}/revoke`, {}, bob)).status).toBe(404);
    expect((await post(`/account/keys/${id}/revoke`, {}, ann)).status).toBe(303);
    expect((await app.request(`${ORIGIN}/v1/me`, { headers: { authorization: `Bearer ${secret}` } })).status).toBe(401);
  });

  test("needs a session", async () => {
    expect((await get("/account/keys")).headers.get("location")).toBe("/");
  });

  test("allows at most 10 active keys", async () => {
    const { cookie } = await signIn();
    const statuses = [];
    for (let i = 0; i < 11; i++) statuses.push((await post("/account/keys", { name: `k${i}`, scope: ["links:read"] }, cookie)).status);
    expect(statuses.slice(0, 10).every((s) => s === 201)).toBe(true);
    expect(statuses[10]).toBe(422);
  });

  test("a blocked user's keys stop working on /v1 and /mcp", async () => {
    const { cookie } = await signIn();
    const secret = /yfi_[A-Za-z0-9]{8}_[A-Za-z0-9]{32}/.exec(await (await post("/account/keys", { name: "k", scope: ["links:read"] }, cookie)).text())![0];
    await sql`update users set disabled_at = now()`;
    const auth = { authorization: `Bearer ${secret}` };

    expect((await app.request(`${ORIGIN}/v1/me`, { headers: auth })).status).toBe(401);
    const mcp = await app.request(`${ORIGIN}/mcp`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
    expect(mcp.status).toBe(401);
  });
});

describe("public pages", () => {
  test.each(["/privacy", "/terms"])("%s is public", async (path) => {
    const res = await get(path);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("yoy.fyi");
  });
});
