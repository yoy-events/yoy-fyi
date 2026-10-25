// OAuth hardening for MCP: token revocation (RFC 7009), step-up when a tool needs a scope the
// grant lacks, and skipping consent for a client the user already approved.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { createApp } from "../src/app";
import type { ClientMetadata } from "../src/oauth";
import { reset, testAdmin, testDb } from "./helpers";

const ORIGIN = "https://yoy.fyi";
const CLIENT = "https://claude.ai/oauth/mcp-client-metadata";
const OTHER = "https://chatgpt.com/oauth/client";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const GOOGLE_CLIENT = "123-test.apps.googleusercontent.com";

let sql: SQL;
let app: ReturnType<typeof createApp>;
let claims: Record<string, unknown>;
let cookie: string;
let now: Date;

const metadata: Record<string, ClientMetadata> = {
  [CLIENT]: { client_id: CLIENT, client_name: "Claude", redirect_uris: [REDIRECT] },
  [OTHER]: { client_id: OTHER, client_name: "ChatGPT", redirect_uris: ["https://chatgpt.com/cb"] },
};
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
const VERIFIER = "v".repeat(43);
const CHALLENGE = new Bun.CryptoHasher("sha256").update(VERIFIER).digest("base64url");

const cookies = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .filter((c) => !c.endsWith("="))
    .join("; ");
const get = (path: string, c = cookie) => app.request(`${ORIGIN}${path}`, { headers: c ? { cookie: c } : {} });
const post = (path: string, fields: Record<string, string | string[]>, c = cookie) => {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) for (const one of [v].flat()) body.append(k, one);
  return app.request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie: c },
    body: body.toString(),
  });
};
const authorizeQuery = (scope: string, client = CLIENT, redirect = REDIRECT) =>
  new URLSearchParams({
    response_type: "code",
    client_id: client,
    redirect_uri: redirect,
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    state: "st",
    scope,
    resource: `${ORIGIN}/mcp`,
  }).toString();
const pendingFrom = async (res: Response) => /name="pending" value="([^"]+)"/.exec(await res.text())?.[1];

async function signIn() {
  const start = await get("/login/google", "");
  const to = new URL(start.headers.get("location")!);
  claims = { iss: "https://accounts.google.com", aud: GOOGLE_CLIENT, sub: "g1", email: "ann@example.com", email_verified: true, nonce: to.searchParams.get("nonce"), exp: Date.now() / 1000 + 3600 };
  return cookies(await get(`/admin/login/google/callback?code=c&state=${to.searchParams.get("state")}`, cookies(start)));
}
const ownService = async () => (await sql`select s.id from services s join users u on u.id = s.owner_user_id`)[0]!.id as string;

// Consents with the given scopes and returns tokens.
async function connect(scopes: string[]) {
  const pending = (await pendingFrom(await get(`/oauth/authorize?${authorizeQuery("links:read analytics:read links:write")}`)))!;
  const res = await post("/oauth/authorize", { pending, decision: "approve", service: await ownService(), scope: scopes });
  const code = new URL(res.headers.get("location")!).searchParams.get("code")!;
  const tokens = await (
    await post("/oauth/token", { grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: CLIENT, code_verifier: VERIFIER }, "")
  ).json();
  return tokens as { access_token: string; refresh_token: string };
}
const mcp = (bearer: string, name: string, args: Record<string, unknown> = {}) =>
  app.request(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });

beforeAll(async () => {
  sql = await testDb();
});

beforeEach(async () => {
  await reset(sql);
  const mail = testAdmin();
  now = new Date();
  app = createApp({
    sql,
    now: () => now,
    publicOrigin: ORIGIN,
    countryOf: () => null,
    resolveHost: async () => ["93.184.215.14"],
    clientMetadata: async (url) => metadata[url] ?? null,
    admin: { ...mail.admin, google: { clientId: GOOGLE_CLIENT, clientSecret: "s", exchange: async () => Response.json({ id_token: `${b64({})}.${b64(claims)}.sig` }) } },
  });
  cookie = await signIn();
});

describe("token revocation (RFC 7009)", () => {
  test("the server metadata advertises the revocation endpoint", async () => {
    const doc = await (await get("/.well-known/oauth-authorization-server", "")).json();
    expect(doc).toMatchObject({ revocation_endpoint: `${ORIGIN}/oauth/revoke`, revocation_endpoint_auth_methods_supported: ["none"] });
  });

  test.each(["access_token", "refresh_token"] as const)("revoking the %s ends the whole grant", async (which) => {
    const tokens = await connect(["links:read"]);
    const res = await post("/oauth/revoke", { token: tokens[which], client_id: CLIENT }, "");
    expect(res.status).toBe(200);
    expect((await mcp(tokens.access_token, "whoami")).status).toBe(401);
    const refreshed = await post("/oauth/token", { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: CLIENT }, "");
    expect(refreshed.status).toBe(400);
  });

  test.each([
    ["an unknown token", { token: "yfo_unknown", client_id: CLIENT }],
    ["an empty token", { token: "", client_id: CLIENT }],
    ["no token", { client_id: CLIENT }],
  ])("%s answers 200 and changes nothing", async (_, fields) => {
    const tokens = await connect(["links:read"]);
    expect((await post("/oauth/revoke", fields, "")).status).toBe(200);
    expect((await mcp(tokens.access_token, "whoami")).status).toBe(200);
  });

  test("another client cannot revoke the grant", async () => {
    const tokens = await connect(["links:read"]);
    await post("/oauth/revoke", { token: tokens.access_token, client_id: OTHER }, "");
    expect((await mcp(tokens.access_token, "whoami")).status).toBe(200);
  });
});

describe("step-up", () => {
  test("a tool needing a scope the grant lacks answers 403 insufficient_scope naming the scope", async () => {
    const { access_token } = await connect(["links:read"]);
    const res = await mcp(access_token, "create_link", { target_url: "https://example.com/" });
    expect(res.status).toBe(403);
    const header = res.headers.get("www-authenticate")!;
    expect(header).toContain('error="insufficient_scope"');
    expect(header).toContain('scope="links:read links:write"');
    expect(header).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`);
    expect(await sql`select 1 from links`).toHaveLength(0);
  });

  test("a tool within the granted scopes works", async () => {
    const { access_token } = await connect(["links:read"]);
    expect((await mcp(access_token, "list_links")).status).toBe(200);
  });
});

describe("remembered consent", () => {
  test("the same client asking for scopes it already holds gets a code without the consent page", async () => {
    await connect(["links:read", "links:write"]);
    const res = await get(`/oauth/authorize?${authorizeQuery("links:read links:write")}`);
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location")!);
    expect(`${to.origin}${to.pathname}`).toBe(REDIRECT);
    expect(to.searchParams.get("code")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(to.searchParams.get("state")).toBe("st");
  });

  test.each([
    ["a scope beyond the earlier grant", "links:read links:write analytics:read", CLIENT, REDIRECT],
    ["another client", "links:read", OTHER, "https://chatgpt.com/cb"],
  ])("%s shows the consent page again", async (_, scope, client, redirect) => {
    await connect(["links:read", "links:write"]);
    const res = await get(`/oauth/authorize?${authorizeQuery(scope, client, redirect)}`);
    expect(res.status).toBe(200);
    expect(await pendingFrom(res)).toBeDefined();
  });

  test("a loopback redirect always shows consent, even for a client already approved", async () => {
    metadata[CLIENT] = { ...metadata[CLIENT]!, redirect_uris: [REDIRECT, "http://localhost/callback"] };
    await connect(["links:read"]);
    const res = await get(`/oauth/authorize?${authorizeQuery("links:read", CLIENT, "http://localhost:4567/callback")}`);
    metadata[CLIENT] = { client_id: CLIENT, client_name: "Claude", redirect_uris: [REDIRECT] };
    expect(res.status).toBe(200);
  });

  test("another declared redirect of the same client shows consent", async () => {
    metadata[CLIENT] = { ...metadata[CLIENT]!, redirect_uris: [REDIRECT, "https://claude.ai/other_callback"] };
    await connect(["links:read"]);
    const res = await get(`/oauth/authorize?${authorizeQuery("links:read", CLIENT, "https://claude.ai/other_callback")}`);
    metadata[CLIENT] = { client_id: CLIENT, client_name: "Claude", redirect_uris: [REDIRECT] };
    expect(res.status).toBe(200);
  });

  test("a connection past its 90 days is not remembered, even with a refresh token still in date", async () => {
    const { refresh_token } = await connect(["links:read"]);
    now = new Date(now.getTime() + 50 * 86_400_000);
    await post("/oauth/token", { grant_type: "refresh_token", refresh_token, client_id: CLIENT }, "");
    now = new Date(now.getTime() + 41 * 86_400_000);
    expect((await get(`/oauth/authorize?${authorizeQuery("links:read")}`)).status).toBe(200);
  });

  test("after the grant is revoked, consent is asked again", async () => {
    const tokens = await connect(["links:read"]);
    await post("/oauth/revoke", { token: tokens.refresh_token, client_id: CLIENT }, "");
    expect((await get(`/oauth/authorize?${authorizeQuery("links:read")}`)).status).toBe(200);
  });
});

describe("connections page for users", () => {
  test("shows each connection's calls in the last 30 days and its latest tools", async () => {
    const { access_token } = await connect(["links:read"]);
    await mcp(access_token, "list_links");
    await mcp(access_token, "whoami");
    const html = await (await get("/account/apps")).text();
    expect(html).toContain("викликів за 30 днів: 2");
    expect(html).toMatch(/останні: (whoami, list_links|list_links, whoami)/);
  });

  test("Disconnect all revokes every connection of the account", async () => {
    const a = await connect(["links:read"]);
    const res = await post("/account/apps/revoke-all", {});
    expect(res.status).toBe(303);
    expect((await mcp(a.access_token, "whoami")).status).toBe(401);
    expect(await sql`select 1 from oauth_grants where revoked_at is null`).toHaveLength(0);
  });

  test("Disconnect all needs a session and our own Origin", async () => {
    expect((await post("/account/apps/revoke-all", {}, "")).status).toBe(401);
  });
});

describe("token lifetime", () => {
  test("a refresh token stops working 90 days after the connection was made, however often it was used", async () => {
    const first = await connect(["links:read"]);
    const refresh = (token: string) => post("/oauth/token", { grant_type: "refresh_token", refresh_token: token, client_id: CLIENT }, "");
    now = new Date(now.getTime() + 50 * 86_400_000);
    const second = await refresh(first.refresh_token);
    expect(second.status).toBe(200);
    // 50 days after the last refresh, inside its 60-day window, but 100 days after connecting.
    now = new Date(now.getTime() + 50 * 86_400_000);
    expect((await refresh((await second.json()).refresh_token)).status).toBe(400);
  });
;
});

describe("loopback redirects", () => {
  test("the consent page warns when the app returns to this computer", async () => {
    metadata[CLIENT] = { ...metadata[CLIENT]!, redirect_uris: [REDIRECT, "http://localhost/callback"] };
    const html = await (await get(`/oauth/authorize?${authorizeQuery("links:read", CLIENT, "http://localhost:4567/callback")}`)).text();
    expect(html).toContain("localhost");
    expect(html).toContain("на цьому комп&#39;ютері");
    metadata[CLIENT] = { client_id: CLIENT, client_name: "Claude", redirect_uris: [REDIRECT] };
  });

  test("a normal https redirect has no such warning", async () => {
    const html = await (await get(`/oauth/authorize?${authorizeQuery("links:read")}`)).text();
    expect(html).not.toContain("на цьому комп&#39;ютері");
    // A user is not shown the admin's navigation.
    expect(html).not.toContain('href="/admin/users"');
  });
});
