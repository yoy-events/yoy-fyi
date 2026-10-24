import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { type AppDeps, createApp } from "../src/app";
import { ADMIN_EMAIL, reset, testAdmin, testDb } from "./helpers";

const ORIGIN = "https://yoy.fyi";
const CLIENT_ID = "123-test.apps.googleusercontent.com";
const REDIRECT = `${ORIGIN}/admin/login/google/callback`;

let sql: SQL;
let now: Date;
let mail: ReturnType<typeof testAdmin>;
let app: ReturnType<typeof createApp>;
let exchanged: URLSearchParams[];
let idClaims: Record<string, unknown>;
let tokenStatus: number;

const b64url = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
// Google's id_token arrives straight from its token endpoint over TLS, so the app checks claims, not the signature.
const idToken = (claims: Record<string, unknown>) => `${b64url({ alg: "RS256", kid: "k" })}.${b64url(claims)}.sig`;

const build = (deps: Partial<AppDeps> = {}) =>
  createApp({
    sql,
    publicOrigin: ORIGIN,
    countryOf: () => null,
    now: () => now,
    admin: {
      ...mail.admin,
      google: {
        clientId: CLIENT_ID,
        clientSecret: "test-secret",
        exchange: async (body) => {
          exchanged.push(body);
          return tokenStatus === 200
            ? Response.json({ id_token: idToken(idClaims), access_token: "ya29.x", token_type: "Bearer" })
            : Response.json({ error: "invalid_grant" }, { status: tokenStatus });
        },
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
  exchanged = [];
  tokenStatus = 200;
  app = build();
});

const get = (path: string, cookie = "") => app.request(`${ORIGIN}${path}`, { headers: cookie ? { cookie } : {} });
const cookieOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

// Starts the flow and returns what Google would send back, with the browser's cookies.
async function start(path = "/admin/login/google") {
  const res = await get(path);
  const to = new URL(res.headers.get("location")!);
  const nonce = to.searchParams.get("nonce")!;
  idClaims = { iss: "https://accounts.google.com", aud: CLIENT_ID, sub: "1", email: ADMIN_EMAIL, email_verified: true, nonce, exp: now.getTime() / 1000 + 3600 };
  return { res, to, state: to.searchParams.get("state")!, cookie: cookieOf(res) };
}
const callback = (cookie: string, query: Record<string, string>) => get(`/admin/login/google/callback?${new URLSearchParams(query)}`, cookie);

describe("starting Google sign-in", () => {
  test("the login page offers Google when it is configured", async () => {
    expect(await (await get("/admin/login")).text()).toContain('href="/admin/login/google"');
    const without = build({ admin: mail.admin });
    expect(await (await without.request(`${ORIGIN}/admin/login`)).text()).not.toContain("/admin/login/google");
  });

  test("redirects to Google with PKCE S256, state, nonce and only openid email", async () => {
    const { res, to } = await start();

    expect(res.status).toBe(302);
    expect(`${to.origin}${to.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(to.searchParams)).toMatchObject({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      response_type: "code",
      scope: "openid email",
      code_challenge_method: "S256",
      login_hint: ADMIN_EMAIL,
    });
    expect(to.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(to.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(to.searchParams.get("nonce")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("without Google configured the start route only leads back to the login page", async () => {
    const without = build({ admin: mail.admin });
    const res = await without.request(`${ORIGIN}/admin/login/google`);
    expect(res.headers.get("location")).toBe("/admin/login");
  });
});

describe("Google callback", () => {
  test("valid: the admin is signed in and the code is exchanged with the PKCE verifier", async () => {
    const { state, cookie } = await start();
    const res = await callback(cookie, { code: "c1", state });

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/admin");
    expect(Object.fromEntries(exchanged[0]!)).toMatchObject({
      code: "c1",
      client_id: CLIENT_ID,
      client_secret: "test-secret",
      redirect_uri: REDIRECT,
      grant_type: "authorization_code",
    });
    expect(exchanged[0]!.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await get("/admin", cookieOf(res))).status).toBe(200);
  });

  test("valid: a pending OAuth authorize request resumes after sign-in", async () => {
    const pending = "0194f0c2-3d6a-7c1e-9b2a-1234567890ab";
    const { state, cookie } = await start(`/admin/login/google?pending=${pending}`);
    const res = await callback(cookie, { code: "c1", state });
    expect(res.headers.get("location")).toBe(`/oauth/authorize?pending=${pending}`);
  });

  test("an invalid pending id is ignored", async () => {
    const { state, cookie } = await start("/admin/login/google?pending=not-a-uuid");
    expect((await callback(cookie, { code: "c1", state })).headers.get("location")).toBe("/admin");
  });

  test.each([
    ["no code", (s: string) => ({ state: s })],
    ["an empty code", (s: string) => ({ code: "", state: s })],
    ["no state", () => ({ code: "c1" })],
    ["another state", () => ({ code: "c1", state: "x".repeat(43) })],
  ])("empty or invalid: %s is refused without a session", async (_, query) => {
    const { state, cookie } = await start();
    const res = await callback(cookie, query(state));
    expect(res.status).toBe(400);
    expect(cookieOf(res)).not.toContain("yfi_admin");
  });

  test("a callback without the flow cookie is refused", async () => {
    const { state } = await start();
    expect((await callback("", { code: "c1", state })).status).toBe(400);
  });

  test("the flow expires after 10 minutes", async () => {
    const { state, cookie } = await start();
    now = new Date(now.getTime() + 11 * 60_000);
    expect((await callback(cookie, { code: "c1", state })).status).toBe(400);
  });

  test("Google's error (user cancelled) shows the login page", async () => {
    const { state, cookie } = await start();
    const res = await callback(cookie, { error: "access_denied", state });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Sign in");
    expect(exchanged).toHaveLength(0);
  });

  test("a failed token exchange is refused", async () => {
    const { state, cookie } = await start();
    tokenStatus = 400;
    expect((await callback(cookie, { code: "c1", state })).status).toBe(400);
  });

  test.each([
    ["another email", { email: "someone@example.com" }],
    ["an unverified email", { email_verified: false }],
    ["another audience", { aud: "other.apps.googleusercontent.com" }],
    ["another issuer", { iss: "https://evil.example" }],
    ["a wrong nonce", { nonce: "n".repeat(43) }],
    ["an expired token", { exp: 1 }],
  ])("an id_token with %s gives no session", async (_, over) => {
    const { state, cookie } = await start();
    idClaims = { ...idClaims, ...over };
    const res = await callback(cookie, { code: "c1", state });
    expect(res.status).toBe(400);
    expect(cookieOf(res)).not.toContain("yfi_admin=");
  });

  test("the state cookie works once", async () => {
    const { state, cookie } = await start();
    const first = await callback(cookie, { code: "c1", state });
    expect(first.status).toBe(303);
    expect(first.headers.getSetCookie().some((c) => /^__Host-yfi_google=;/.test(c))).toBe(true);
  });
});
