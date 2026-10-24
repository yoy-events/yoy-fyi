import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { createApp } from "../src/app";
import { issueKey } from "../src/keys";
import { upsertGoogleUser } from "../src/users";
import { adminGet, adminPost, adminSession } from "./admin-helpers";
import { createLink, reset, testAdmin, testDb } from "./helpers";

let sql: SQL;
let app: ReturnType<typeof createApp>;
let mail: ReturnType<typeof testAdmin>;
let cookie: string;
let userId: string;
let serviceSlug: string;
let code: string;

beforeAll(async () => {
  sql = await testDb();
});

beforeEach(async () => {
  await reset(sql);
  mail = testAdmin();
  app = createApp({ sql, publicOrigin: "https://yoy.fyi", countryOf: () => null, admin: mail.admin });
  cookie = await adminSession(app, mail);
  ({ id: userId } = (await upsertGoogleUser(sql, { sub: "g1", email: "ann@example.com", name: "Ann" }, new Date()))!);
  const [service] = await sql`select id, slug from services where owner_user_id = ${userId}`;
  serviceSlug = service.slug;
  code = "annlink";
  await createLink(sql, service.id, { code, target_url: "https://example.com/" });
});

const keyFor = async () => (await issueKey(sql, { serviceSlug, name: "k", scopes: ["links:read"] })).token;
const me = (key: string) => app.request("https://yoy.fyi/v1/me", { headers: { authorization: `Bearer ${key}` } });

describe("admin users", () => {
  test("lists users with their link count and service", async () => {
    const page = await (await adminGet(app, "/admin/users", cookie)).text();
    expect(page).toContain("ann@example.com");
    expect(page).toContain("1 link");
    expect(page).toContain(`/admin/services/${serviceSlug}`);
  });

  test("blocking stops the user's links, keys and sessions; unblocking restores them", async () => {
    const key = await keyFor();

    expect((await adminPost(app, `/admin/users/${userId}/block`, {}, cookie)).status).toBe(303);
    expect((await app.request(`https://yoy.fyi/${code}`)).status).toBe(410);
    expect((await me(key)).status).toBe(401);
    expect(await (await adminGet(app, "/admin/users", cookie)).text()).toContain("blocked");

    expect((await adminPost(app, `/admin/users/${userId}/unblock`, {}, cookie)).status).toBe(303);
    expect((await app.request(`https://yoy.fyi/${code}`)).status).toBe(302);
    expect((await me(key)).status).toBe(200);
  });

  test.each(["block", "unblock"])("%s of an unknown or malformed id is 404", async (action) => {
    expect((await adminPost(app, `/admin/users/00000000-0000-0000-0000-000000000000/${action}`, {}, cookie)).status).toBe(404);
    expect((await adminPost(app, `/admin/users/not-a-uuid/${action}`, {}, cookie)).status).toBe(404);
  });

  test("needs the admin session", async () => {
    expect((await adminGet(app, "/admin/users", "")).headers.get("location")).toBe("/admin/login");
    expect((await adminPost(app, `/admin/users/${userId}/block`, {}, "")).headers.get("location")).toBe("/admin/login");
  });
});
