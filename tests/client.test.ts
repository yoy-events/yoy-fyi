import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { YoyFyiError, createClient, verifyWebhook } from "../client/yoy-fyi";
import { createApp } from "../src/app";
import { issueKey } from "../src/keys";
import { sign } from "../src/outbox";
import { reset, testDb } from "./helpers";

let sql: SQL;
let client: ReturnType<typeof createClient>;

beforeAll(async () => {
  sql = await testDb();
});

beforeEach(async () => {
  await reset(sql);
  const app = createApp({
    sql,
    publicOrigin: "https://yoy.fyi",
    countryOf: () => null,
    resolveHost: async () => ["93.184.215.14"],
  });
  const { token } = await issueKey(sql, { serviceSlug: "yoy", name: "client", scopes: ["links:write", "links:read", "analytics:read"] });
  client = createClient({ apiKey: token, fetch: async (url, init) => app.request(url, init) });
});

describe("createClient", () => {
  test("me returns the calling key's service", async () => {
    expect((await client.me()).service.slug).toBe("yoy");
  });

  test("links.create returns the link, and the same Idempotency-Key replays it", async () => {
    const body = { target_url: "https://example.com/event", tags: ["event"] };

    const first = await client.links.create(body, { idempotencyKey: "evt-1" });
    const again = await client.links.create(body, { idempotencyKey: "evt-1" });

    expect(first.short_url).toBe(`https://yoy.fyi/${first.code}`);
    expect(again.id).toBe(first.id);
  });

  test("links.get, list, update and disable round-trip", async () => {
    const link = await client.links.create({ target_url: "https://example.com/", tags: ["a"] });

    expect((await client.links.get(link.id)).id).toBe(link.id);
    expect((await client.links.list({ tag: "a" })).data.map((l) => l.id)).toEqual([link.id]);
    expect((await client.links.update(link.id, { title: "Hi" })).title).toBe("Hi");
    expect((await client.links.disable(link.id)).status).toBe("disabled");
  });

  test("API errors become YoyFyiError with status, code and details", async () => {
    const err = await client.links.create({ target_url: "ftp://example.com/" }).catch((e) => e);

    expect(err).toBeInstanceOf(YoyFyiError);
    expect(err.status).toBe(422);
    expect(err.code).toBe("target_rejected");
    expect(err.details).toEqual({ reason: "scheme" });
  });

  test("analytics.timeseries and breakdown pass their query through", async () => {
    const range = { from: "2026-10-01T00:00:00Z", to: "2026-10-08T00:00:00Z" };

    const series = await client.analytics.timeseries({ ...range, interval: "day" });
    const countries = await client.analytics.breakdown({ ...range, dimension: "country" });

    expect(series.points).toHaveLength(7);
    expect(countries.dimension).toBe("country");
  });
});

describe("verifyWebhook", () => {
  const secret = "whsec_test";
  const body = JSON.stringify({ id: "evt", type: "link.clicked" });
  const now = 1_792_742_400_000;

  test("accepts a fresh, correctly signed body", async () => {
    expect(await verifyWebhook(secret, sign(secret, now / 1000, body), body, now)).toBe(true);
  });

  test("rejects a tampered body, a wrong secret and a stale timestamp", async () => {
    const header = sign(secret, now / 1000, body);

    expect(await verifyWebhook(secret, header, `${body} `, now)).toBe(false);
    expect(await verifyWebhook("other", header, body, now)).toBe(false);
    expect(await verifyWebhook(secret, header, body, now + 301_000)).toBe(false);
    expect(await verifyWebhook(secret, "garbage", body, now)).toBe(false);
  });
});
