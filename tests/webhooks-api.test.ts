import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { createApp } from "../src/app";
import { issueKey } from "../src/keys";
import { openSecret, loadSecretKey } from "../src/secretbox";
import { reset, testDb, testWebhookKey } from "./helpers";

let sql: SQL;
let app: ReturnType<typeof createApp>;
let token: string;
const keyBase64 = testWebhookKey();

beforeAll(async () => {
  sql = await testDb();
  app = createApp({
    sql,
    publicOrigin: "https://yoy.fyi",
    countryOf: () => null,
    resolveHost: async () => ["93.184.215.14"],
    webhookKey: await loadSecretKey(keyBase64),
  });
});

beforeEach(async () => {
  await reset(sql);
  ({ token } = await issueKey(sql, { serviceSlug: "yoy", name: "k", scopes: ["webhooks:manage"] }));
});

const call = (method: string, path: string, body?: unknown, key = token) =>
  app.request(`https://yoy.fyi${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("webhook registration", () => {
  test("registers a webhook and returns its signing secret once", async () => {
    const res = await call("POST", "/v1/webhooks", { url: "https://hooks.example.com/yoy" });

    expect(res.status).toBe(201);
    const { webhook, secret } = await res.json();
    expect(secret).toMatch(/^whsec_[A-Za-z0-9]{32}$/);
    expect(webhook).toMatchObject({
      url: "https://hooks.example.com/yoy",
      events: ["link.clicked"],
      include_bots: false,
      disabled_at: null,
    });
    const fetched = await (await call("GET", `/v1/webhooks/${webhook.id}`)).json();
    expect(fetched).toEqual(webhook);
    expect(JSON.stringify(await (await call("GET", "/v1/webhooks")).json())).not.toContain(secret);
  });

  test("stores the secret encrypted, recoverable only with the key", async () => {
    const { secret } = await (await call("POST", "/v1/webhooks", { url: "https://hooks.example.com/" })).json();

    const [row] = await sql`select secret_enc from webhooks`;
    expect(row.secret_enc).not.toContain(secret);
    expect(await openSecret(await loadSecretKey(keyBase64), row.secret_enc)).toBe(secret);
    await expect(openSecret(await loadSecretKey(testWebhookKey()), row.secret_enc)).rejects.toThrow();
  });

  test("honours include_bots", async () => {
    const { webhook } = await (
      await call("POST", "/v1/webhooks", { url: "https://hooks.example.com/", include_bots: true })
    ).json();

    expect(webhook.include_bots).toBe(true);
  });

  test.each([
    ["http://hooks.example.com/", "scheme"],
    ["https://yoy.fyi/hook", "own_host"],
    ["https://10.0.0.1/hook", "private_address"],
    ["https://hooks.example.com:8443/hook", "port"],
  ])("rejects %s (%s)", async (url, reason) => {
    const res = await call("POST", "/v1/webhooks", { url });

    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatchObject({ code: "target_rejected", details: { reason } });
  });

  test("validates the body", async () => {
    const res = await call("POST", "/v1/webhooks", { url: 5, events: ["link.created"], include_bots: "no", x: 1 });

    expect(res.status).toBe(422);
    expect(Object.keys((await res.json()).error.details.fields).sort()).toEqual(["events", "include_bots", "url", "x"]);
  });

  test("lists only this service's webhooks", async () => {
    const { token: other } = await issueKey(sql, { serviceSlug: "diduny", name: "o", scopes: ["webhooks:manage"] });
    await call("POST", "/v1/webhooks", { url: "https://a.example.com/" });
    await call("POST", "/v1/webhooks", { url: "https://b.example.com/" }, other);

    const { data } = await (await call("GET", "/v1/webhooks")).json();

    expect(data.map((w: { url: string }) => w.url)).toEqual(["https://a.example.com/"]);
  });

  test("disable is idempotent and marks pending deliveries dead", async () => {
    const { webhook } = await (await call("POST", "/v1/webhooks", { url: "https://a.example.com/" })).json();
    await sql`insert into webhook_deliveries (id, webhook_id, click_id, payload)
              values (${Bun.randomUUIDv7()}, ${webhook.id}, ${Bun.randomUUIDv7()}, '{}')`;

    const first = await (await call("POST", `/v1/webhooks/${webhook.id}/disable`)).json();
    const again = await (await call("POST", `/v1/webhooks/${webhook.id}/disable`)).json();

    expect(first.disabled_at).toBeTruthy();
    expect(again.disabled_at).toBe(first.disabled_at);
    const [delivery] = await sql`select status, next_attempt_at from webhook_deliveries`;
    expect(delivery).toEqual({ status: "dead", next_attempt_at: null });
  });

  test("another service's webhook is 404; webhooks:manage is required", async () => {
    const { token: other } = await issueKey(sql, { serviceSlug: "diduny", name: "o", scopes: ["webhooks:manage"] });
    const { token: links } = await issueKey(sql, { serviceSlug: "yoy", name: "l", scopes: ["links:read"] });
    const { webhook } = await (await call("POST", "/v1/webhooks", { url: "https://a.example.com/" })).json();

    expect((await call("GET", `/v1/webhooks/${webhook.id}`, undefined, other)).status).toBe(404);
    expect((await call("POST", `/v1/webhooks/${webhook.id}/disable`, undefined, other)).status).toBe(404);
    expect((await call("GET", "/v1/webhooks", undefined, links)).status).toBe(403);
    expect((await call("GET", "/v1/webhooks/nope")).status).toBe(404);
  });
});

describe("GET /v1/webhooks/{id}/deliveries", () => {
  const addDelivery = async (webhookId: string, status: string) => {
    const id = Bun.randomUUIDv7();
    const clickId = Bun.randomUUIDv7();
    await sql`insert into webhook_deliveries (id, webhook_id, click_id, payload, status, attempts, last_status, last_error)
              values (${id}, ${webhookId}, ${clickId}, '{}', ${status}, 2, 500, 'HTTP 500')`;
    return { id, clickId };
  };

  test("lists deliveries newest first with their outcome, filtered by status, paged", async () => {
    const { webhook } = await (await call("POST", "/v1/webhooks", { url: "https://a.example.com/" })).json();
    const first = await addDelivery(webhook.id, "dead");
    const second = await addDelivery(webhook.id, "pending");
    const third = await addDelivery(webhook.id, "dead");

    const all = await (await call("GET", `/v1/webhooks/${webhook.id}/deliveries`)).json();
    const dead = await (await call("GET", `/v1/webhooks/${webhook.id}/deliveries?status=dead&limit=1`)).json();
    const deadNext = await (
      await call("GET", `/v1/webhooks/${webhook.id}/deliveries?status=dead&limit=1&cursor=${dead.next_cursor}`)
    ).json();

    expect(all.data.map((d: { id: string }) => d.id)).toEqual([third.id, second.id, first.id]);
    expect(all.data[0]).toEqual({
      id: third.id,
      event_id: third.clickId,
      status: "dead",
      attempts: 2,
      next_attempt_at: expect.any(String),
      last_status: 500,
      last_error: "HTTP 500",
      created_at: expect.any(String),
      delivered_at: null,
    });
    expect(Object.keys(all.data[0])).not.toContain("payload");
    expect(dead.data.map((d: { id: string }) => d.id)).toEqual([third.id]);
    expect(deadNext.data.map((d: { id: string }) => d.id)).toEqual([first.id]);
    expect(deadNext.next_cursor).toBeNull();
  });

  test("another service's webhook is 404; a bad status is 400", async () => {
    const { token: other } = await issueKey(sql, { serviceSlug: "diduny", name: "o", scopes: ["webhooks:manage"] });
    const { webhook } = await (await call("POST", "/v1/webhooks", { url: "https://a.example.com/" })).json();

    expect((await call("GET", `/v1/webhooks/${webhook.id}/deliveries`, undefined, other)).status).toBe(404);
    expect((await call("GET", `/v1/webhooks/${webhook.id}/deliveries?status=lost`)).status).toBe(400);
  });
});
