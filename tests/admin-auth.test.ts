import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { type AppDeps, createApp } from "../src/app";
import { ADMIN_EMAIL, reset, testAdmin, testDb } from "./helpers";

let sql: SQL;
let now: Date;
let mail: ReturnType<typeof testAdmin>;
let app: ReturnType<typeof createApp>;

const build = (deps: Partial<AppDeps> = {}) =>
  createApp({ sql, publicOrigin: "https://yoy.fyi", countryOf: () => null, admin: mail.admin, now: () => now, ...deps });

beforeAll(async () => {
  sql = await testDb();
});

beforeEach(async () => {
  await reset(sql);
  now = new Date("2026-10-23T12:00:00Z");
  mail = testAdmin();
  app = build();
});

const ORIGIN = { origin: "https://yoy.fyi" };
const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
const post = (path: string, fields: Record<string, string>, headers: Record<string, string> = {}, target = app) =>
  target.request(`https://yoy.fyi${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...ORIGIN, ...headers },
    body: form(fields),
  });
const get = (path: string, headers: Record<string, string> = {}) => app.request(`https://yoy.fyi${path}`, { headers });

const tokenFromMail = () => new URL(/https:\/\/\S+/.exec(mail.sent.at(-1)!.text)![0]).searchParams.get("token")!;
const cookieFrom = (res: Response) => res.headers.get("set-cookie")!.split(";")[0]!;

async function signIn(): Promise<string> {
  await post("/admin/login", { email: ADMIN_EMAIL });
  return cookieFrom(await post("/admin/login/verify", { token: tokenFromMail() }));
}

describe("admin sign-in", () => {
  test("pages need a session; without one they redirect to the login form", async () => {
    const res = await get("/admin");

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin/login");
    const login = await get("/admin/login");
    expect(login.status).toBe(200);
    expect(await login.text()).toContain('name="email"');
  });

  test("emails a sign-in link to the admin address, matched case-insensitively", async () => {
    const res = await post("/admin/login", { email: "Roman@Example.com" });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Check your inbox");
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]!.to).toBe(ADMIN_EMAIL);
    expect(mail.sent[0]!.text).toMatch(/https:\/\/yoy\.fyi\/admin\/login\/verify\?token=[A-Za-z0-9_-]{43}/);
  });

  test("any other address gets the same answer and no email", async () => {
    const res = await post("/admin/login", { email: "someone@example.com" });

    expect(await res.text()).toContain("Check your inbox");
    expect(mail.sent).toHaveLength(0);
  });

  test("stores only a hash of the token", async () => {
    await post("/admin/login", { email: ADMIN_EMAIL });

    const rows = await sql`select * from admin_login_tokens`;
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(tokenFromMail());
  });

  test("opening the link only shows a confirm button, so link scanners cannot use it up", async () => {
    await post("/admin/login", { email: ADMIN_EMAIL });
    const token = tokenFromMail();

    const page = await get(`/admin/login/verify?token=${token}`);

    expect(page.status).toBe(200);
    expect(await page.text()).toContain(`value="${token}"`);
    const [{ used_at }] = await sql`select used_at from admin_login_tokens`;
    expect(used_at).toBeNull();
  });

  test("confirming signs in with a host-only, HttpOnly, Secure, Lax cookie", async () => {
    await post("/admin/login", { email: ADMIN_EMAIL });

    const res = await post("/admin/login/verify", { token: tokenFromMail() });

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/admin");
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toStartWith("__Host-yfi_admin=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect((await get("/admin", { cookie: cookieFrom(res) })).status).toBe(200);
  });

  test("a token works once", async () => {
    await post("/admin/login", { email: ADMIN_EMAIL });
    const token = tokenFromMail();
    await post("/admin/login/verify", { token });

    const again = await post("/admin/login/verify", { token });

    expect(again.status).toBe(400);
    expect(again.headers.get("set-cookie")).toBeNull();
  });

  test("a token expires after 15 minutes", async () => {
    await post("/admin/login", { email: ADMIN_EMAIL });
    now = new Date(now.getTime() + 15 * 60_000 + 1000);

    expect((await post("/admin/login/verify", { token: tokenFromMail() })).status).toBe(400);
  });

  test("a session lasts 7 days", async () => {
    const cookie = await signIn();

    now = new Date(now.getTime() + 7 * 86_400_000 - 1000);
    expect((await get("/admin", { cookie })).status).toBe(200);
    now = new Date(now.getTime() + 2000);
    expect((await get("/admin", { cookie })).status).toBe(302);
  });

  test("a tampered cookie is ignored", async () => {
    const cookie = await signIn();
    const tampered = cookie.replace(/=(.)/, (_, ch) => `=${ch === "a" ? "b" : "a"}`);

    expect((await get("/admin", { cookie: tampered })).status).toBe(302);
  });

  test("signing out clears the cookie", async () => {
    const cookie = await signIn();

    const res = await post("/admin/logout", {}, { cookie });

    expect(res.status).toBe(303);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  test("form posts from another origin are refused", async () => {
    const cookie = await signIn();

    const res = await post("/admin/logout", {}, { cookie, origin: "https://evil.example" });

    expect(res.status).toBe(403);
  });

  test("login requests are limited per IP", async () => {
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await post("/admin/login", { email: "x@example.com" }, { "fly-client-ip": "203.0.113.5" })).status);
    }

    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
  });
});
