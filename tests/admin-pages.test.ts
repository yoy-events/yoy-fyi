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

describe("links", () => {
  let serviceId: string;
  beforeEach(async () => {
    await issueKey(sql, { serviceSlug: "yoy", name: "k", scopes: ["links:read"] });
    [{ id: serviceId }] = await sql`select id from services where slug = 'yoy'`;
  });

  test("creates a link from the form with every rule the API applies", async () => {
    const res = await adminPost(
      app,
      "/admin/services/yoy/links",
      {
        target_url: "https://example.com/landing",
        code: "fall",
        title: "Fall launch",
        tags: "fall, ig",
        utm_source: "ig",
        utm_medium: "",
        utm_campaign: "fall",
        expires_at: "2027-01-01T00:00",
        pass_click_id: "on",
      },
      cookie,
    );

    expect(res.status).toBe(303);
    const [link] = await sql`select * from links where code = 'fall'`;
    expect(res.headers.get("location")).toBe(`/admin/links/${link.id}`);
    expect(link).toMatchObject({
      service_id: serviceId,
      target_url: "https://example.com/landing",
      title: "Fall launch",
      tags: ["fall", "ig"],
      utm_defaults: { utm_source: "ig", utm_campaign: "fall" },
      pass_click_id: true,
      expires_at: new Date("2027-01-01T00:00:00Z"),
    });
    expect(await html(`/admin/links/${link.id}`)).toContain("https://yoy.fyi/fall");
  });

  test("shows the API's objections on the form", async () => {
    const rejected = await adminPost(app, "/admin/services/yoy/links", { target_url: "http://10.0.0.1/" }, cookie);
    expect(rejected.status).toBe(422);
    expect(await rejected.text()).toContain("private_address");

    await createLink(sql, serviceId, { code: "taken", target_url: "https://example.com/" });
    const taken = await adminPost(app, "/admin/services/yoy/links", { target_url: "https://example.com/", code: "taken" }, cookie);
    expect(taken.status).toBe(409);
    expect(await taken.text()).toContain("already in use");
  });

  test("the service page lists links newest first and filters by status", async () => {
    await createLink(sql, serviceId, { code: "first", target_url: "https://example.com/1" });
    await createLink(sql, serviceId, { code: "second", target_url: "https://example.com/2", disabled_at: new Date() });

    const all = await html("/admin/services/yoy");
    const disabled = await html("/admin/services/yoy?status=disabled");

    expect(all.indexOf(">second<")).toBeLessThan(all.indexOf(">first<"));
    expect(disabled).toContain(">second<");
    expect(disabled).not.toContain(">first<");
  });

  test("disables a link from its page", async () => {
    const id = await createLink(sql, serviceId, { code: "bye", target_url: "https://example.com/" });

    const res = await adminPost(app, `/admin/links/${id}/disable`, {}, cookie);

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/admin/links/${id}`);
    expect(await html(`/admin/links/${id}`)).toContain("disabled");
    expect((await app.request("https://yoy.fyi/bye")).status).toBe(410);
    expect((await sql`select disabled_by from links where id = ${id}`)[0].disabled_by).toBe("admin");
  });

  test("a link its owner disabled can still be taken down by the admin", async () => {
    const id = await createLink(sql, serviceId, { code: "own", target_url: "https://example.com/", disabled_at: new Date() });
    await sql`update links set disabled_by = 'owner' where id = ${id}`;
    expect(await html(`/admin/links/${id}`)).toContain(`action="/admin/links/${id}/disable"`);

    expect((await adminPost(app, `/admin/links/${id}/disable`, {}, cookie)).status).toBe(303);
    expect((await sql`select disabled_by from links where id = ${id}`)[0].disabled_by).toBe("admin");
  });

  test("an unknown link is 404", async () => {
    expect((await adminGet(app, `/admin/links/${Bun.randomUUIDv7()}`, cookie)).status).toBe(404);
    expect((await adminGet(app, "/admin/links/nope", cookie)).status).toBe(404);
  });

  // 36 characters of hex and dashes that are not a UUID used to reach Postgres and fail with 500.
  test.each(["-".repeat(36), "a".repeat(36)])("a 36-character id that is not a UUID (%s) is 404", async (id) => {
    expect((await adminGet(app, `/admin/links/${id}`, cookie)).status).toBe(404);
    expect((await adminGet(app, `/admin/links/${id}/qr.svg`, cookie)).status).toBe(404);
    expect((await adminPost(app, `/admin/links/${id}/disable`, {}, cookie)).status).toBe(404);
    expect((await adminPost(app, `/admin/keys/${id}/revoke`, {}, cookie)).status).toBe(404);
  });
});

describe("link analytics page", () => {
  let serviceId: string;
  let linkId: string;
  const DAY = 86_400_000;
  const today = () => new Date(Math.floor(Date.now() / DAY) * DAY);

  beforeEach(async () => {
    await issueKey(sql, { serviceSlug: "yoy", name: "k", scopes: ["links:read"] });
    [{ id: serviceId }] = await sql`select id from services where slug = 'yoy'`;
    linkId = await createLink(sql, serviceId, { code: "stats", target_url: "https://example.com/" });
    const click = (at: Date, extra: Record<string, unknown> = {}) =>
      addClick(sql, { link_id: linkId, service_id: serviceId, clicked_at: at.toISOString(), ...extra });
    const t = today().getTime();
    await click(new Date(t + 60_000), { visitor_hash: "a", referer_host: "t.co", country: "UA" });
    await click(new Date(t + 120_000), { visitor_hash: "b", referer_host: "t.co", country: "PL" });
    await click(new Date(t - DAY + 60_000), { visitor_hash: "a", referer_host: "google.com", country: "UA" });
    await click(new Date(t + 180_000), { is_bot: true, referer_host: "t.me" });
    const { rollupDays } = await import("../src/rollup");
    const day = (d: Date) => d.toISOString().slice(0, 10);
    await rollupDays(sql, day(new Date(t - DAY)), day(today()));
  });

  test("shows totals, a bar per day and breakdowns, bots excluded by default", async () => {
    const page = await html(`/admin/links/${linkId}`);

    expect(page).toMatch(/<strong>3<\/strong>\s*clicks/);
    expect(page).toMatch(/<strong>1<\/strong>\s*bot/);
    expect((page.match(/class="bar"/g) ?? []).length).toBe(30 + 48);
    expect(page).toContain(`${today().toISOString().slice(0, 10)}: 2 clicks`);
    expect(page).toContain("t.co");
    expect(page).toContain("google.com");
    expect(page).not.toContain("t.me");
  });

  test("range and bots are adjustable", async () => {
    const page = await html(`/admin/links/${linkId}?range=7&bots=include`);

    expect((page.match(/class="bar"/g) ?? []).length).toBe(7 + 48);
    expect(page).toMatch(/<strong>4<\/strong>\s*clicks/);
    expect(page).toContain("t.me");
  });

  test("embeds the QR code from an admin route", async () => {
    expect(await html(`/admin/links/${linkId}`)).toContain(`src="/admin/links/${linkId}/qr.svg"`);

    const qr = await adminGet(app, `/admin/links/${linkId}/qr.svg`, cookie);
    expect(qr.headers.get("content-type")).toBe("image/svg+xml");
    expect(await qr.text()).toStartWith("<svg");
    expect((await adminGet(app, `/admin/links/${Bun.randomUUIDv7()}/qr.svg`, cookie)).status).toBe(404);
  });
});
