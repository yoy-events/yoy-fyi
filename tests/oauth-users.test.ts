// Any signed-in user can connect claude.ai or ChatGPT to their own links (ADR-0005).
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { createApp } from "../src/app";
import type { ClientMetadata } from "../src/oauth";
import { adminPost, adminSession } from "./admin-helpers";
import { createService, reset, testAdmin, testDb } from "./helpers";

const ORIGIN = "https://yoy.fyi";
const CLIENT = "https://claude.ai/oauth/mcp-client-metadata";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const GOOGLE_CLIENT = "123-test.apps.googleusercontent.com";

let sql: SQL;
let now: Date;
let mail: ReturnType<typeof testAdmin>;
let app: ReturnType<typeof createApp>;
let claims: Record<string, unknown>;
let otherService: string;

const metadata: Record<string, ClientMetadata> = {
  [CLIENT]: { client_id: CLIENT, client_name: "Claude", redirect_uris: [REDIRECT] },
};
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

beforeAll(async () => {
  sql = await testDb();
});

beforeEach(async () => {
  await reset(sql);
  now = new Date("2026-10-24T12:00:00Z");
  mail = testAdmin();
  app = createApp({
    sql,
    publicOrigin: ORIGIN,
    countryOf: () => null,
    resolveHost: async () => ["93.184.215.14"],
    now: () => now,
    clientMetadata: async (url) => metadata[url] ?? null,
    admin: {
      ...mail.admin,
      google: {
        clientId: GOOGLE_CLIENT,
        clientSecret: "s",
        exchange: async () => Response.json({ id_token: `${b64({ alg: "RS256" })}.${b64(claims)}.sig` }),
      },
    },
  });
  otherService = await createService(sql, "yoy");
});

const VERIFIER = "v".repeat(43);
const CHALLENGE = new Bun.CryptoHasher("sha256").update(VERIFIER).digest("base64url");
const authorizeQuery = () =>
  new URLSearchParams({
    response_type: "code",
    client_id: CLIENT,
    redirect_uri: REDIRECT,
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    state: "st-1",
    scope: "links:read analytics:read links:write",
    resource: `${ORIGIN}/mcp`,
  }).toString();

const cookies = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .filter((c) => !c.endsWith("="))
    .join("; ");
const get = (path: string, cookie = "") => app.request(`${ORIGIN}${path}`, { headers: cookie ? { cookie } : {} });
const post = (path: string, fields: Record<string, string | string[]>, cookie: string) => {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) for (const one of [v].flat()) body.append(k, one);
  return app.request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie },
    body: body.toString(),
  });
};
const pendingFrom = async (res: Response) => /name="pending" value="([^"]+)"/.exec(await res.text())![1]!;

// Follows a Google sign-in started at `start` (with a fake token endpoint).
async function google(startPath: string, sub = "google-1", email = "ann@example.com") {
  const start = await get(startPath);
  const to = new URL(start.headers.get("location")!);
  claims = {
    iss: "https://accounts.google.com",
    aud: GOOGLE_CLIENT,
    sub,
    email,
    email_verified: true,
    name: "Ann",
    nonce: to.searchParams.get("nonce"),
    exp: now.getTime() / 1000 + 3600,
  };
  const res = await get(`/admin/login/google/callback?code=c&state=${to.searchParams.get("state")}`, cookies(start));
  return { res, cookie: cookies(res) };
}

const ownService = async (email = "ann@example.com") =>
  (await sql`select s.id from services s join users u on u.id = s.owner_user_id where u.email = ${email}`)[0]!.id as string;

// Signs Ann in, runs authorize + consent and returns the session cookie and the code.
async function connect(scopes = ["links:read", "links:write"]) {
  const { cookie } = await google("/login/google");
  const pending = await pendingFrom(await get(`/oauth/authorize?${authorizeQuery()}`, cookie));
  const res = await post("/oauth/authorize", { pending, decision: "approve", service: await ownService(), scope: scopes }, cookie);
  return { cookie, res, code: new URL(res.headers.get("location") ?? "https://x/").searchParams.get("code") };
}

async function accessToken(code: string) {
  const res = await post(
    "/oauth/token",
    { grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: CLIENT, code_verifier: VERIFIER },
    "",
  );
  return (await res.json()).access_token as string;
}

const mcp = (bearer: string, name: string, args: Record<string, unknown> = {}) =>
  app.request(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });

describe("user sign-in for an OAuth connection", () => {
  test("signed out, the authorize page offers Google sign-in that returns to the request", async () => {
    const html = await (await get(`/oauth/authorize?${authorizeQuery()}`)).text();
    const pending = /href="\/login\/google\?pending=([0-9a-f-]{36})"/.exec(html)?.[1];
    expect(pending).toBeDefined();

    const { res } = await google(`/login/google?pending=${pending}`);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/oauth/authorize?pending=${pending}`);
  });

  test.each([
    ["a malformed pending", "/login/google?pending=nope"],
    ["an empty pending", "/login/google?pending="],
    ["no pending", "/login/google"],
  ])("%s goes back to the home page", async (_, path) => {
    const { res } = await google(path);
    expect(res.headers.get("location")).toBe("/");
  });
});

describe("user consent", () => {
  test("offers only the user's own service, never another one", async () => {
    const { cookie } = await google("/login/google");
    const html = await (await get(`/oauth/authorize?${authorizeQuery()}`, cookie)).text();
    expect(html).toContain(await ownService());
    expect(html).not.toContain(otherService);
    expect(html).toContain("ann@example.com");
  });

  test("approve gives a token that works on /mcp for the user's own links only", async () => {
    const { res, code } = await connect();
    expect(res.status).toBe(303);
    const token = await accessToken(code!);

    const created = await (await mcp(token, "create_link", { target_url: "https://example.com/a" })).json();
    expect(created.result.isError).toBeFalsy();
    const [row] = await sql`select service_id, created_via from links`;
    expect(row).toEqual({ service_id: await ownService(), created_via: "mcp" });
  });

  test.each([
    ["another service", () => otherService],
    ["an unknown service", () => "00000000-0000-0000-0000-000000000000"],
    ["an empty service", () => ""],
  ])("%s is refused with 400", async (_, service) => {
    const { cookie } = await google("/login/google");
    const pending = await pendingFrom(await get(`/oauth/authorize?${authorizeQuery()}`, cookie));
    const res = await post("/oauth/authorize", { pending, decision: "approve", service: service(), scope: ["links:read"] }, cookie);
    expect(res.status).toBe(400);
    expect(await sql`select 1 from oauth_codes`).toHaveLength(0);
  });

  test("a blocked user's connection stops working", async () => {
    const { code } = await connect(["links:read"]);
    const token = await accessToken(code!);
    const [user] = await sql`select id from users`;
    await adminPost(app, `/admin/users/${user.id}/block`, {}, await adminSession(app, mail));

    expect((await mcp(token, "list_links")).status).toBe(401);
  });
});

describe("/account/apps", () => {
  test("lists the user's connections and revokes one", async () => {
    const { cookie, code } = await connect(["links:read"]);
    const token = await accessToken(code!);
    const page = await (await get("/account/apps", cookie)).text();
    expect(page).toContain("Claude");
    const id = /action="\/account\/apps\/([0-9a-f-]{36})\/revoke"/.exec(page)![1]!;

    const res = await post(`/account/apps/${id}/revoke`, {}, cookie);
    expect(res.status).toBe(303);
    expect((await mcp(token, "list_links")).status).toBe(401);
  });

  test("empty: explains how to connect", async () => {
    const { cookie } = await google("/login/google");
    expect(await (await get("/account/apps", cookie)).text()).toContain(`${ORIGIN}/mcp`);
  });

  test.each([
    ["another user's connection", "other"],
    ["an unknown id", "00000000-0000-0000-0000-000000000000"],
    ["a malformed id", "not-a-uuid"],
  ])("revoking %s is 404", async (_, which) => {
    await accessToken((await connect(["links:read"])).code!);
    const annGrant = (await sql`select id from oauth_grants`)[0]!.id;
    const bob = await google("/login/google", "google-2", "bob@example.com");
    const id = which === "other" ? annGrant : which;

    expect((await post(`/account/apps/${id}/revoke`, {}, bob.cookie)).status).toBe(404);
    expect((await sql`select revoked_at from oauth_grants where id = ${annGrant}`)[0].revoked_at).toBeNull();
  });

  test("needs a session", async () => {
    expect((await get("/account/apps")).status).toBe(302);
    expect((await post("/account/apps/00000000-0000-0000-0000-000000000000/revoke", {}, "")).status).toBe(401);
  });
});
