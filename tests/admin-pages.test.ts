import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { createApp } from "../src/app";
import { issueKey } from "../src/keys";
import { adminGet, adminPost, adminSession } from "./admin-helpers";
import { addClick, createLink, reset, testAdmin, testDb } from "./helpers";

let sql: SQL;
let app: ReturnType<typeof createApp>;
let mail: ReturnType<typeof testAdmin>;
let cookie: string;

beforeAll(async () => {
  sql = await testDb();
});

beforeEach(async () => {
  await reset(sql);
  mail = testAdmin();
  app = createApp({
    sql,
    publicOrigin: "https://yoy.fyi",
    countryOf: () => null,
    resolveHost: async () => ["93.184.215.14"],
    admin: mail.admin,
  });
  cookie = await adminSession(app, mail);
});

const html = async (path: string) => {
  const res = await adminGet(app, path, cookie);
  expect(res.status).toBe(200);
  return res.text();
};

describe("services and keys", () => {
  test("the dashboard lists every service with its key and link counts", async () => {
    await issueKey(sql, { serviceSlug: "yoy", name: "prod", scopes: ["links:read"] });
    await issueKey(sql, { serviceSlug: "diduny", name: "prod", scopes: ["links:read"] });
    const [{ id }] = await sql`select id from services where slug = 'yoy'`;
    await createLink(sql, id, { code: "a", target_url: "https://example.com/" });

    const page = await html("/admin");

    expect(page).toContain('href="/admin/services/yoy"');
    expect(page).toContain('href="/admin/services/diduny"');
    expect(page).toMatch(/yoy<\/a>.*?1 key.*?1 link/s);
  });

  test("creating a key shows its secret once, creating the service if new", async () => {
    const res = await adminPost(app, "/admin/keys", { service: "mnfaktr", name: "lms", scopes: ["links:write", "links:read"] }, cookie);

    expect(res.status).toBe(200);
    const page = await res.text();
    const secret = /yfi_[A-Za-z0-9]{8}_[A-Za-z0-9]{32}/.exec(page)?.[0];
    expect(secret).toBeTruthy();
    expect(page).toContain("shown only once");
    const me = await app.request("https://yoy.fyi/v1/me", { headers: { authorization: `Bearer ${secret}` } });
    expect((await me.json()).service.slug).toBe("mnfaktr");
    expect(await html("/admin/services/mnfaktr")).not.toContain(secret!);
  });

  test("an invalid key form re-renders with the problems", async () => {
    const res = await adminPost(app, "/admin/keys", { service: "Bad Slug", name: "", scopes: [] }, cookie);

    expect(res.status).toBe(422);
    const page = await res.text();
    expect(page).toContain("lowercase letters, digits and dashes");
    expect(page).toContain("at least one scope");
  });

  test("the service page lists keys and revokes them", async () => {
    const { key, token } = await issueKey(sql, { serviceSlug: "yoy", name: "old", scopes: ["links:read"] });

    expect(await html("/admin/services/yoy")).toContain(key.prefix);
    const res = await adminPost(app, `/admin/keys/${key.id}/revoke`, {}, cookie);

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/admin/services/yoy");
    expect((await app.request("https://yoy.fyi/v1/me", { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
    expect(await html("/admin/services/yoy")).toContain("revoked");
  });

  test("an unknown service is 404", async () => {
    expect((await adminGet(app, "/admin/services/nope", cookie)).status).toBe(404);
  });

  test("the service page shows dead webhook deliveries", async () => {
    await issueKey(sql, { serviceSlug: "yoy", name: "k", scopes: ["links:read"] });
    const [{ id }] = await sql`select id from services where slug = 'yoy'`;
    const webhookId = Bun.randomUUIDv7();
    await sql`insert into webhooks (id, service_id, url, secret_enc, events) values (${webhookId}, ${id}, 'https://hooks.example.com/', 'x', '{link.clicked}')`;
    await sql`insert into webhook_deliveries (id, webhook_id, click_id, payload, status) values (${Bun.randomUUIDv7()}, ${webhookId}, ${Bun.randomUUIDv7()}, '{}', 'dead')`;

    const page = await html("/admin/services/yoy");

    expect(page).toContain("https://hooks.example.com/");
    expect(page).toMatch(/1 dead/);
  });
});
