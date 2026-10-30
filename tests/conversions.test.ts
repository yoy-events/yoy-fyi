// Conversions: a service reports that a click led to a sign-up or a purchase, and the link's
// stats show how many and how much. Valid, invalid and empty input, and tenant isolation.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { createApp } from "../src/app";
import { issueKey } from "../src/keys";
import { addClick, createLink, createService, reset, testDb } from "./helpers";

const ORIGIN = "https://yoy.fyi";
let sql: SQL;
let app: ReturnType<typeof createApp>;
let key: string;
let readKey: string;
let otherKey: string;
let serviceId: string;
let linkId: string;
let clickId: string;

beforeAll(async () => {
  sql = await testDb();
  app = createApp({ sql, publicOrigin: ORIGIN, countryOf: () => null, resolveHost: async () => ["93.184.215.14"] });
});

beforeEach(async () => {
  await reset(sql);
  ({ token: key } = await issueKey(sql, { serviceSlug: "yoy", name: "k", scopes: ["conversions:write", "analytics:read"] }));
  ({ token: readKey } = await issueKey(sql, { serviceSlug: "yoy", name: "ro", scopes: ["analytics:read", "links:read"] }));
  ({ token: otherKey } = await issueKey(sql, { serviceSlug: "other", name: "k", scopes: ["conversions:write", "analytics:read"] }));
  serviceId = (await sql`select id from services where slug = 'yoy'`)[0].id;
  linkId = await createLink(sql, serviceId, { code: "gig", target_url: "https://example.com/" });
  clickId = Bun.randomUUIDv7();
  await addClick(sql, { id: clickId, link_id: linkId, service_id: serviceId, clicked_at: new Date(Date.now() - 3600_000).toISOString(), utm_source: "telegram", country: "UA" });
});

const call = (method: string, path: string, body?: unknown, bearer = key) =>
  app.request(`${ORIGIN}${path}`, {
    method,
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const record = (body: unknown, bearer = key) => call("POST", "/v1/conversions", body, bearer);
const errorOf = async (res: Response) => (await res.json()).error;

describe("POST /v1/conversions", () => {
  test("records a sign-up for a click and returns it", async () => {
    const res = await record({ click_id: clickId, event: "signup" });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ click_id: clickId, link_id: linkId, event: "signup", value: null, currency: null, external_id: null });
  });

  test("records a purchase with value, currency, external id and time", async () => {
    const at = new Date(Date.now() - 600_000).toISOString();
    const res = await record({ click_id: clickId, event: "purchase", value: 450.5, currency: "uah", external_id: "order-77", occurred_at: at });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ event: "purchase", value: 450.5, currency: "UAH", external_id: "order-77" });
    expect(new Date(body.occurred_at).toISOString()).toBe(at);
  });

  test("the same external_id returns the existing conversion with 200 and creates nothing new", async () => {
    const first = await (await record({ click_id: clickId, event: "purchase", value: 10, currency: "USD", external_id: "o-1" })).json();
    const again = await record({ click_id: clickId, event: "purchase", value: 10, currency: "USD", external_id: "o-1" });
    expect(again.status).toBe(200);
    expect((await again.json()).id).toBe(first.id);
    expect(await sql`select 1 from conversions`).toHaveLength(1);
  });

  test("a retry of a value with more than two decimals is the same conversion, not a conflict", async () => {
    // value is stored as numeric(14,2): 19.999 is kept as 20.00, and the retry still sends 19.999.
    const body = { click_id: clickId, event: "purchase", value: 19.999, currency: "USD", external_id: "o-cents" };
    const first = await record(body);
    expect(first.status).toBe(201);
    const again = await record(body);
    expect(again.status).toBe(200);
    expect((await again.json()).id).toBe((await first.json()).id);
  });

  test("the same external_id with a value that differs after rounding is a conflict", async () => {
    await record({ click_id: clickId, event: "purchase", value: 10.004, currency: "USD", external_id: "o-2" });
    const res = await record({ click_id: clickId, event: "purchase", value: 10.01, currency: "USD", external_id: "o-2" });
    expect(res.status).toBe(409);
  });

  test("the same external_id with a different body is a conflict", async () => {
    await record({ click_id: clickId, event: "purchase", value: 10, currency: "USD", external_id: "o-1" });
    const res = await record({ click_id: clickId, event: "purchase", value: 99, currency: "USD", external_id: "o-1" });
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe("conversion_conflict");
  });

  test("without an external_id each call is a new conversion", async () => {
    await record({ click_id: clickId, event: "signup" });
    await record({ click_id: clickId, event: "signup" });
    expect(await sql`select 1 from conversions`).toHaveLength(2);
  });

  test.each([
    ["no body fields", {}, "click_id"],
    ["a click_id that is not a uuid", { click_id: "nope", event: "signup" }, "click_id"],
    ["no event", { click_id: "00000000-0000-7000-8000-000000000000" }, "event"],
    ["an empty event", { click_id: "00000000-0000-7000-8000-000000000000", event: "" }, "event"],
    ["an event over 64 characters", { click_id: "00000000-0000-7000-8000-000000000000", event: "e".repeat(65) }, "event"],
    ["an event with spaces", { click_id: "00000000-0000-7000-8000-000000000000", event: "sign up" }, "event"],
    ["a negative value", { click_id: "00000000-0000-7000-8000-000000000000", event: "purchase", value: -1, currency: "USD" }, "value"],
    ["a value that is not a number", { click_id: "00000000-0000-7000-8000-000000000000", event: "purchase", value: "10", currency: "USD" }, "value"],
    ["a value over 1e9", { click_id: "00000000-0000-7000-8000-000000000000", event: "purchase", value: 1e10, currency: "USD" }, "value"],
    ["a value without a currency", { click_id: "00000000-0000-7000-8000-000000000000", event: "purchase", value: 5 }, "currency"],
    ["a currency without a value", { click_id: "00000000-0000-7000-8000-000000000000", event: "purchase", currency: "USD" }, "value"],
    ["a currency that is not 3 letters", { click_id: "00000000-0000-7000-8000-000000000000", event: "purchase", value: 5, currency: "US" }, "currency"],
    ["an empty external_id", { click_id: "00000000-0000-7000-8000-000000000000", event: "signup", external_id: "" }, "external_id"],
    ["an external_id over 128 characters", { click_id: "00000000-0000-7000-8000-000000000000", event: "signup", external_id: "x".repeat(129) }, "external_id"],
    ["an occurred_at that is not a date", { click_id: "00000000-0000-7000-8000-000000000000", event: "signup", occurred_at: "yesterday" }, "occurred_at"],
    ["an occurred_at in the future", { click_id: "00000000-0000-7000-8000-000000000000", event: "signup", occurred_at: "2999-01-01T00:00:00Z" }, "occurred_at"],
    ["an unknown field", { click_id: "00000000-0000-7000-8000-000000000000", event: "signup", plan: "pro" }, "plan"],
  ])("%s is validation_failed naming the field", async (_, body, field) => {
    const res = await record(body);
    expect(res.status).toBe(422);
    const e = await errorOf(res);
    expect(e.code).toBe("validation_failed");
    expect(e.details.fields).toHaveProperty(field);
    expect(await sql`select 1 from conversions`).toHaveLength(0);
  });

  test("an unknown click is 404; so is another service's click", async () => {
    expect((await record({ click_id: "00000000-0000-7000-8000-000000000000", event: "signup" })).status).toBe(404);
    expect((await record({ click_id: clickId, event: "signup" }, otherKey)).status).toBe(404);
    expect(await sql`select 1 from conversions`).toHaveLength(0);
  });

  test("an occurred_at before the click is refused", async () => {
    const res = await record({ click_id: clickId, event: "signup", occurred_at: new Date(Date.now() - 7200_000).toISOString() });
    expect(res.status).toBe(422);
    expect((await errorOf(res)).details.fields).toHaveProperty("occurred_at");
  });

  test("a body that is not a JSON object is 400", async () => {
    expect((await call("POST", "/v1/conversions", "[]")).status).toBe(400);
    expect((await app.request(`${ORIGIN}/v1/conversions`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: "{oops" })).status).toBe(400);
  });

  test("needs the conversions:write scope", async () => {
    expect((await record({ click_id: clickId, event: "signup" }, readKey)).status).toBe(403);
    expect((await app.request(`${ORIGIN}/v1/conversions`, { method: "POST", body: "{}" })).status).toBe(401);
  });
});

describe("GET /v1/analytics/conversions", () => {
  const range = () => {
    const to = new Date(Date.now() + 3600_000).toISOString().slice(0, 19) + "Z";
    const from = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 19) + "Z";
    return `from=${from}&to=${to}`;
  };

  beforeEach(async () => {
    await record({ click_id: clickId, event: "signup" });
    await record({ click_id: clickId, event: "purchase", value: 100, currency: "UAH", external_id: "a" });
    await record({ click_id: clickId, event: "purchase", value: 50.5, currency: "UAH", external_id: "b" });
    await record({ click_id: clickId, event: "purchase", value: 20, currency: "USD", external_id: "c" });
  });

  test("totals per event, with value per currency", async () => {
    const res = await call("GET", `/v1/analytics/conversions?${range()}`);
    expect(res.status).toBe(200);
    const { events } = await res.json();
    const purchase = events.find((e: { event: string }) => e.event === "purchase");
    expect(events.find((e: { event: string }) => e.event === "signup")).toMatchObject({ count: 1, values: [] });
    expect(purchase.count).toBe(3);
    expect(purchase.values).toEqual([
      { currency: "UAH", total: 150.5 },
      { currency: "USD", total: 20 },
    ]);
  });

  test("can be limited to one link, and to one that has none", async () => {
    const other = await createLink(sql, serviceId, { code: "other", target_url: "https://example.com/o" });
    expect((await (await call("GET", `/v1/analytics/conversions?${range()}&link_id=${linkId}`)).json()).events.length).toBe(2);
    expect((await (await call("GET", `/v1/analytics/conversions?${range()}&link_id=${other}`)).json()).events).toEqual([]);
  });

  test("never shows another service's conversions", async () => {
    expect((await (await call("GET", `/v1/analytics/conversions?${range()}`, undefined, otherKey)).json()).events).toEqual([]);
    expect((await call("GET", `/v1/analytics/conversions?${range()}&link_id=${linkId}`, undefined, otherKey)).status).toBe(404);
  });

  test.each([["no range", ""], ["a bad link id", "&link_id=nope"], ["from after to", "from=2026-10-26T00:00:00Z&to=2026-10-25T00:00:00Z"]])("%s is 400", async (_, extra) => {
    const query = extra.startsWith("from") ? extra : `${extra === "" ? "" : `${range()}${extra}`}`;
    expect((await call("GET", `/v1/analytics/conversions?${query}`)).status).toBe(400);
  });

  test("needs analytics:read", async () => {
    const { token } = await issueKey(sql, { serviceSlug: "yoy", name: "w", scopes: ["conversions:write"] });
    expect((await call("GET", `/v1/analytics/conversions?${range()}`, undefined, token)).status).toBe(403);
  });
});
