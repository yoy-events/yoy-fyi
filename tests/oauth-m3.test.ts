// More MCP clients: Client ID Metadata Documents from any https host (unverified ones are marked
// on the consent page) and Dynamic Client Registration (RFC 7591) for clients such as Cursor.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { createApp } from "../src/app";
import type { ClientMetadata } from "../src/oauth";
import { reset, testAdmin, testDb } from "./helpers";

const ORIGIN = "https://yoy.fyi";
const GOOGLE_CLIENT = "123-test.apps.googleusercontent.com";
const UNVERIFIED = "https://tools.example.dev/mcp-client.json";
const CLAUDE_CODE = "https://claude.ai/oauth/claude-code-client-metadata";

let sql: SQL;
let app: ReturnType<typeof createApp>;
let claims: Record<string, unknown>;
let cookie: string;
let now: Date;

const metadata: Record<string, ClientMetadata> = {
  [UNVERIFIED]: { client_id: UNVERIFIED, client_name: "Example Tool", redirect_uris: ["https://tools.example.dev/cb"] },
  [CLAUDE_CODE]: { client_id: CLAUDE_CODE, client_name: "Claude Code", redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"] },
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
const form = (path: string, fields: Record<string, string | string[]>, c = cookie) => {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) for (const one of [v].flat()) body.append(k, one);
  return app.request(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie: c }, body: body.toString() });
};
const register = (body: unknown, ip = "203.0.113.5") =>
  app.request(`${ORIGIN}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, { ip });
const authorize = (clientId: string, redirect: string) =>
  get(
    `/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirect, code_challenge: CHALLENGE, code_challenge_method: "S256", state: "s", scope: "links:read" })}`,
  );
const pendingFrom = async (res: Response) => /name="pending" value="([^"]+)"/.exec(await res.text())?.[1];

async function signIn() {
  const start = await get("/login/google", "");
  const to = new URL(start.headers.get("location")!);
  claims = { iss: "https://accounts.google.com", aud: GOOGLE_CLIENT, sub: "g1", email: "ann@example.com", email_verified: true, nonce: to.searchParams.get("nonce"), exp: Date.now() / 1000 + 3600 };
  return cookies(await get(`/admin/login/google/callback?code=c&state=${to.searchParams.get("state")}`, cookies(start)));
}

beforeAll(async () => {
  sql = await testDb();
});

beforeEach(async () => {
  await reset(sql);
  now = new Date();
  const mail = testAdmin();
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

describe("client metadata documents from any https host", () => {
  test("a client outside the known hosts can connect, marked as unverified with its domain shown", async () => {
    const res = await authorize(UNVERIFIED, "https://tools.example.dev/cb");
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("Example Tool");
    expect(html).toContain("tools.example.dev");
    expect(html).toContain("не перевіряв");
  });

  test("a known host is not marked as unverified", async () => {
    const html = await (await authorize(CLAUDE_CODE, "http://localhost:51234/callback")).text();
    expect(html).toContain("Claude Code");
    expect(html).not.toContain("не перевіряв");
  });

  test("a client_id over http is still refused", async () => {
    expect((await authorize("http://tools.example.dev/mcp-client.json", "https://tools.example.dev/cb")).status).toBe(400);
  });
});

describe("dynamic client registration", () => {
  test("the server metadata advertises the registration endpoint", async () => {
    const doc = await (await get("/.well-known/oauth-authorization-server", "")).json();
    expect(doc.registration_endpoint).toBe(`${ORIGIN}/oauth/register`);
  });

  test("a public client registers with loopback, https and private-scheme redirects and can then authorize", async () => {
    const res = await register({
      client_name: "Cursor",
      redirect_uris: ["http://localhost:8787/callback", "cursor://anysphere.cursor-mcp/oauth/callback", "https://cursor.com/oauth/cb"],
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "none",
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.client_id).toMatch(/^dcr_[A-Za-z0-9_-]{20,}$/);
    expect(body).toMatchObject({ client_name: "Cursor", token_endpoint_auth_method: "none" });
    expect(body.client_secret).toBeUndefined();

    const consent = await authorize(body.client_id, "cursor://anysphere.cursor-mcp/oauth/callback");
    const html = await consent.text();
    expect(consent.status).toBe(200);
    expect(html).toContain("Cursor");
    expect(html).toContain("не перевіряв");

    const pending = (await pendingFrom(await authorize(body.client_id, "http://localhost:8787/callback")))!;
    const service = (await sql`select id from services`)[0].id;
    const approved = await form("/oauth/authorize", { pending, decision: "approve", service, scope: "links:read" });
    const code = new URL(approved.headers.get("location")!).searchParams.get("code")!;
    const tokens = await form("/oauth/token", { grant_type: "authorization_code", code, redirect_uri: "http://localhost:8787/callback", client_id: body.client_id, code_verifier: VERIFIER }, "");
    expect(tokens.status).toBe(200);
  });

  test.each([
    ["no redirect_uris", { client_name: "X" }],
    ["empty redirect_uris", { redirect_uris: [] }],
    ["an http redirect that is not loopback", { redirect_uris: ["http://evil.example/cb"] }],
    ["a javascript: redirect", { redirect_uris: ["javascript:alert(1)"] }],
    ["a data: redirect", { redirect_uris: ["data:text/html,hi"] }],
    ["a redirect with a fragment", { redirect_uris: ["https://a.example/cb#x"] }],
    ["a confidential client", { redirect_uris: ["https://a.example/cb"], token_endpoint_auth_method: "client_secret_basic" }],
    ["more than 10 redirects", { redirect_uris: Array.from({ length: 11 }, (_, i) => `https://a.example/cb${i}`) }],
    ["a non-object body", ["https://a.example/cb"]],
  ])("%s is refused with invalid_client_metadata or invalid_redirect_uri", async (_, body) => {
    const res = await register(body);
    expect(res.status).toBe(400);
    expect(["invalid_client_metadata", "invalid_redirect_uri"]).toContain((await res.json()).error);
    expect(await sql`select 1 from oauth_clients`).toHaveLength(0);
  });

  test("an unknown dcr_ client_id is refused on authorize", async () => {
    expect((await authorize("dcr_doesnotexist000000000000", "http://localhost:8787/callback")).status).toBe(400);
  });

  test("registrations are rate-limited per address", async () => {
    for (let i = 0; i < 10; i++) expect((await register({ redirect_uris: ["http://localhost/cb"] })).status).toBe(201);
    expect((await register({ redirect_uris: ["http://localhost/cb"] })).status).toBe(429);
    expect((await register({ redirect_uris: ["http://localhost/cb"] }, "203.0.113.6")).status).toBe(201);
  });

  test("silent consent never applies to a registered client", async () => {
    const { client_id } = await (await register({ client_name: "Tool", redirect_uris: ["https://tool.example/cb"] })).json();
    const service = (await sql`select id from services`)[0].id;
    for (let i = 0; i < 2; i++) {
      const res = await authorize(client_id, "https://tool.example/cb");
      expect(res.status).toBe(200);
      const pending = (await pendingFrom(res))!;
      const approved = await form("/oauth/authorize", { pending, decision: "approve", service, scope: "links:read" });
      const code = new URL(approved.headers.get("location")!).searchParams.get("code")!;
      await form("/oauth/token", { grant_type: "authorization_code", code, redirect_uri: "https://tool.example/cb", client_id, code_verifier: VERIFIER }, "");
    }
  });
});
