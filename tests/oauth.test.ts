import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { type AppDeps, createApp } from "../src/app";
import { issueKey } from "../src/keys";
import type { ClientMetadata } from "../src/oauth";
import { adminSession } from "./admin-helpers";
import { createService, reset, testAdmin, testDb } from "./helpers";

const ORIGIN = "https://yoy.fyi";
const CLIENT = "https://claude.ai/oauth/mcp-client-metadata";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

let sql: SQL;
let now: Date;
let mail: ReturnType<typeof testAdmin>;
let app: ReturnType<typeof createApp>;
let cookie: string;
let serviceId: string;
let fetched: string[];

const metadata: Record<string, ClientMetadata> = {
  [CLIENT]: { client_id: CLIENT, client_name: "Claude", redirect_uris: [REDIRECT, "http://localhost/callback"] },
};

const build = (deps: Partial<AppDeps> = {}) =>
  createApp({
    sql,
    publicOrigin: ORIGIN,
    countryOf: () => null,
    resolveHost: async () => ["93.184.215.14"],
    admin: mail.admin,
    now: () => now,
    clientMetadata: async (url) => {
      fetched.push(url);
      return metadata[url] ?? null;
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
  fetched = [];
  app = build();
  serviceId = await createService(sql, "yoy");
  await createService(sql, "diduny");
  cookie = await adminSession(app, mail);
});

const b64url = (bytes: ArrayBuffer | Uint8Array) => Buffer.from(bytes as ArrayBuffer).toString("base64url");
const VERIFIER = "v".repeat(43);
const CHALLENGE = b64url(new Bun.CryptoHasher("sha256").update(VERIFIER).digest());

const authorizeQuery = (over: Record<string, string | undefined> = {}) => {
  const q = new URLSearchParams();
  const all = {
    response_type: "code",
    client_id: CLIENT,
    redirect_uri: REDIRECT,
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    state: "st-1",
    scope: "links:read analytics:read links:write",
    resource: `${ORIGIN}/mcp`,
    ...over,
  };
  for (const [k, v] of Object.entries(all)) if (v !== undefined) q.set(k, v);
  return q.toString();
};

const get = (path: string, withCookie = true) => app.request(`${ORIGIN}${path}`, { headers: withCookie ? { cookie } : {} });
const form = (path: string, fields: Record<string, string | string[]>, headers: Record<string, string> = {}) => {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) for (const one of [v].flat()) body.append(k, one);
  return app.request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie, ...headers },
    body: body.toString(),
  });
};
const pendingFrom = async (res: Response) => /name="pending" value="([^"]+)"/.exec(await res.text())![1]!;

// Runs authorize + consent and returns the code from the redirect.
async function codeFor(scopes = ["links:read", "analytics:read"], service = serviceId): Promise<string> {
  const pending = await pendingFrom(await get(`/oauth/authorize?${authorizeQuery()}`));
  const res = await form("/oauth/authorize", { pending, decision: "approve", service, scope: scopes });
  return new URL(res.headers.get("location")!).searchParams.get("code")!;
}

const token = (fields: Record<string, string>) => form("/oauth/token", fields, { cookie: "", origin: "" });
const exchange = (code: string, over: Record<string, string> = {}) =>
  token({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: CLIENT, code_verifier: VERIFIER, resource: `${ORIGIN}/mcp`, ...over });

const mcp = (bearer: string, method = "tools/list", params?: unknown) =>
  app.request(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
  });

describe("discovery", () => {
  test("protected resource metadata names /mcp and this origin as the only authorization server", async () => {
    for (const path of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
      const doc = await (await get(path, false)).json();
      expect(doc).toEqual({
        resource: `${ORIGIN}/mcp`,
        authorization_servers: [ORIGIN],
        scopes_supported: ["links:read", "analytics:read", "links:write"],
        bearer_methods_supported: ["header"],
      });
    }
  });

  test("authorization server metadata advertises S256, public clients, CIMD and iss", async () => {
    const doc = await (await get("/.well-known/oauth-authorization-server", false)).json();
    expect(doc).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/oauth/authorize`,
      token_endpoint: `${ORIGIN}/oauth/token`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
  });
});

describe("GET /oauth/authorize", () => {
  test("signed in: shows consent with the client, the redirect host, services and scopes; links:write unticked", async () => {
    const res = await get(`/oauth/authorize?${authorizeQuery()}`);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain("Claude");
    expect(html).toContain("claude.ai");
    expect(html).toContain('value="yoy"'.replace("yoy", serviceId));
    expect(html).toMatch(/value="links:read" checked/);
    expect(html).not.toMatch(/value="links:write" checked/);
    expect(fetched).toEqual([CLIENT]);
  });

  test("not signed in: shows the sign-in form carrying the pending request", async () => {
    const html = await (await get(`/oauth/authorize?${authorizeQuery()}`, false)).text();
    expect(html).toContain('action="/admin/login"');
    expect(html).toMatch(/name="pending" value="[0-9a-f-]{36}"/);
  });

  test.each([
    ["no client_id", { client_id: undefined }],
    ["a client_id that is not https", { client_id: "http://claude.ai/x" }],
    ["an unknown client", { client_id: "https://claude.ai/unknown" }],
    ["a client host off the allowlist", { client_id: "https://evil.example/client" }],
    ["a redirect_uri the client did not declare", { redirect_uri: "https://claude.ai/elsewhere" }],
    ["no redirect_uri", { redirect_uri: undefined }],
  ])("%s: an error page, never a redirect", async (_, over) => {
    const res = await get(`/oauth/authorize?${authorizeQuery(over)}`);
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  test.each([
    ["an unsupported response_type", { response_type: "token" }, "unsupported_response_type"],
    ["no code_challenge", { code_challenge: undefined }, "invalid_request"],
    ["a plain PKCE method", { code_challenge_method: "plain" }, "invalid_request"],
    ["a foreign resource", { resource: "https://other.example/mcp" }, "invalid_target"],
    ["only scopes OAuth never grants", { scope: "keys:manage webhooks:manage" }, "invalid_scope"],
  ])("%s: redirects with error, state and iss", async (_, over, error) => {
    const res = await get(`/oauth/authorize?${authorizeQuery(over)}`);
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location")!);
    expect(`${to.origin}${to.pathname}`).toBe(REDIRECT);
    expect(Object.fromEntries(to.searchParams)).toMatchObject({ error, state: "st-1", iss: ORIGIN });
  });

  test("a loopback redirect matches whatever port the client uses", async () => {
    const res = await get(`/oauth/authorize?${authorizeQuery({ redirect_uri: "http://localhost:53682/callback" })}`);
    expect(res.status).toBe(200);
  });
});

describe("sign-in resume", () => {
  test("the emailed link returns to the pending authorize request", async () => {
    const pending = await pendingFrom(await get(`/oauth/authorize?${authorizeQuery()}`, false));
    await form("/admin/login", { email: mail.admin.email, pending }, { cookie: "" });
    const link = new URL(/https:\/\/\S+/.exec(mail.sent.at(-1)!.text)![0]);

    const res = await form("/admin/login/verify", { token: link.searchParams.get("token")! }, { cookie: "" });

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/oauth/authorize?pending=${pending}`);
  });
});

describe("POST /oauth/authorize (consent)", () => {
  test("approve redirects with a code, state and iss", async () => {
    const pending = await pendingFrom(await get(`/oauth/authorize?${authorizeQuery()}`));
    const res = await form("/oauth/authorize", { pending, decision: "approve", service: serviceId, scope: ["links:read"] });

    expect(res.status).toBe(303);
    const to = new URL(res.headers.get("location")!);
    expect(to.searchParams.get("code")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(to.searchParams.get("state")).toBe("st-1");
    expect(to.searchParams.get("iss")).toBe(ORIGIN);
  });

  test("deny redirects with access_denied", async () => {
    const pending = await pendingFrom(await get(`/oauth/authorize?${authorizeQuery()}`));
    const res = await form("/oauth/authorize", { pending, decision: "deny" });
    expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("access_denied");
  });

  test.each([
    ["no scope", { scope: [] }],
    ["a scope OAuth never grants", { scope: ["keys:manage"] }],
    ["an unknown service", { service: "00000000-0000-0000-0000-000000000000" }],
    ["an empty service", { service: "" }],
  ])("%s is refused with 400", async (_, over) => {
    const pending = await pendingFrom(await get(`/oauth/authorize?${authorizeQuery()}`));
    const res = await form("/oauth/authorize", { pending, decision: "approve", service: serviceId, scope: ["links:read"], ...over });
    expect(res.status).toBe(400);
  });

  test("a scope ticked twice is granted once", async () => {
    const body = await (await exchange(await codeFor(["links:read", "links:read", "analytics:read"]))).json();
    expect(body.scope).toBe("links:read analytics:read");
    const [grant] = await sql`select scopes from oauth_grants`;
    expect(grant.scopes).toEqual(["links:read", "analytics:read"]);
  });

  test("a pending request works once", async () => {
    const pending = await pendingFrom(await get(`/oauth/authorize?${authorizeQuery()}`));
    await form("/oauth/authorize", { pending, decision: "approve", service: serviceId, scope: ["links:read"] });
    expect((await form("/oauth/authorize", { pending, decision: "approve", service: serviceId, scope: ["links:read"] })).status).toBe(400);
  });

  test("needs the admin session and our own Origin", async () => {
    const pending = await pendingFrom(await get(`/oauth/authorize?${authorizeQuery()}`));
    const fields = { pending, decision: "approve", service: serviceId, scope: ["links:read"] };
    expect((await form("/oauth/authorize", fields, { cookie: "" })).status).toBe(401);
    expect((await form("/oauth/authorize", fields, { origin: "https://evil.example" })).status).toBe(403);
  });
});

describe("POST /oauth/token", () => {
  test("exchanges a code for a Bearer access token and a refresh token", async () => {
    const res = await exchange(await codeFor());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(body).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "links:read analytics:read" });
    expect(body.access_token).toStartWith("yfo_");
    expect(body.refresh_token).toStartWith("yfr_");
  });

  test.each([
    ["a wrong verifier", { code_verifier: "w".repeat(43) }, "invalid_grant"],
    ["another redirect_uri", { redirect_uri: "http://localhost/callback" }, "invalid_grant"],
    ["another client", { client_id: "https://chatgpt.com/client" }, "invalid_grant"],
    ["a foreign resource", { resource: "https://other.example/mcp" }, "invalid_target"],
    ["an unknown grant_type", { grant_type: "password" }, "unsupported_grant_type"],
    ["no code", { code: "" }, "invalid_request"],
  ])("%s is refused", async (_, over, error) => {
    const res = await exchange(await codeFor(), over);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(error);
  });

  test("an empty body is invalid_request", async () => {
    const res = await app.request(`${ORIGIN}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_request");
  });

  test("a code works once and expires after 60 seconds", async () => {
    const code = await codeFor();
    expect((await exchange(code)).status).toBe(200);
    expect((await (await exchange(code)).json()).error).toBe("invalid_grant");

    const late = await codeFor();
    now = new Date(now.getTime() + 61_000);
    expect((await (await exchange(late)).json()).error).toBe("invalid_grant");
  });

  test("refresh rotates both tokens; reusing an old refresh token revokes the grant", async () => {
    const first = await (await exchange(await codeFor())).json();
    const second = await (await token({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: CLIENT })).json();

    expect(second.access_token).not.toBe(first.access_token);
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect((await mcp(first.access_token)).status).toBe(401);
    expect((await mcp(second.access_token)).status).toBe(200);

    const reuse = await token({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: CLIENT });
    expect((await reuse.json()).error).toBe("invalid_grant");
    expect((await mcp(second.access_token)).status).toBe(401);
  });

  test("an unknown refresh token is invalid_grant", async () => {
    const res = await token({ grant_type: "refresh_token", refresh_token: "yfr_nope", client_id: CLIENT });
    expect((await res.json()).error).toBe("invalid_grant");
  });
});

describe("OAuth tokens on /mcp", () => {
  const callTool = async (bearer: string, name: string, args: Record<string, unknown>) =>
    (await (await mcp(bearer, "tools/call", { name, arguments: args })).json()).result;

  test("act for the chosen service with the granted scopes only", async () => {
    const { access_token } = await (await exchange(await codeFor(["links:read"]))).json();

    const who = await callTool(access_token, "whoami", {});
    expect(who.structuredContent).toMatchObject({ service: { slug: "yoy" }, scopes: ["links:read"] });
    // A missing scope is a step-up (see oauth-m2.test.ts), not a tool error.
    const denied = await mcp(access_token, "tools/call", { name: "create_link", arguments: { target_url: "https://example.com/" } });
    expect(denied.status).toBe(403);
    expect((await denied.json()).error.message).toContain("links:write");
  });

  test("expire after an hour", async () => {
    const { access_token } = await (await exchange(await codeFor())).json();
    now = new Date(now.getTime() + 3_601_000);
    expect((await mcp(access_token)).status).toBe(401);
  });

  test("are not accepted by /v1", async () => {
    const { access_token } = await (await exchange(await codeFor())).json();
    const res = await app.request(`${ORIGIN}/v1/me`, { headers: { authorization: `Bearer ${access_token}` } });
    expect(res.status).toBe(401);
  });

  test("tools/list declares the OAuth scope each tool needs", async () => {
    const { access_token } = await (await exchange(await codeFor())).json();
    const { tools } = (await (await mcp(access_token)).json()).result;
    const create = tools.find((t: { name: string }) => t.name === "create_link");
    expect(create.securitySchemes).toEqual([{ type: "oauth2", scopes: ["links:write"] }]);
  });

  test("API keys still work on /mcp", async () => {
    const { token: key } = await issueKey(sql, { serviceSlug: "yoy", name: "k", scopes: ["links:read"] });
    expect((await mcp(key)).status).toBe(200);
  });
});

describe("admin: connected apps", () => {
  test("lists grants and revokes them", async () => {
    const { access_token } = await (await exchange(await codeFor())).json();
    const page = await (await get("/admin/apps")).text();
    expect(page).toContain("Claude");
    expect(page).toContain("yoy");
    const grantId = /action="\/admin\/apps\/([0-9a-f-]{36})\/revoke"/.exec(page)![1]!;

    const res = await form(`/admin/apps/${grantId}/revoke`, {});

    expect(res.status).toBe(303);
    expect((await mcp(access_token)).status).toBe(401);
  });
});
