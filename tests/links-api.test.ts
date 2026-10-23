import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { type AppDeps, createApp } from "../src/app";
import { issueKey } from "../src/keys";
import { reset, testDb } from "./helpers";

let sql: SQL;
let app: ReturnType<typeof createApp>;
let token: string;

const appWith = (deps: Partial<AppDeps> = {}) =>
  createApp({
    sql,
    publicOrigin: "https://yoy.fyi",
    countryOf: () => null,
    resolveHost: async () => ["93.184.215.14"],
    ...deps,
  });

beforeAll(async () => {
  sql = await testDb();
  app = appWith();
});

beforeEach(async () => {
  await reset(sql);
  ({ token } = await issueKey(sql, { serviceSlug: "yoy", name: "prod", scopes: ["links:write", "links:read"] }));
});

const call = (
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
  target = app,
  key = token,
) =>
  target.request(`https://yoy.fyi${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });

const create = (body: unknown, headers: Record<string, string> = {}) => call("POST", "/v1/links", body, headers);
const errorCode = async (res: Response) => (await res.json()).error.code;

describe("POST /v1/links", () => {
  test("creates a link with a generated 7-character code that redirects", async () => {
    const res = await create({ target_url: "https://example.com/page" });

    expect(res.status).toBe(201);
    const link = await res.json();
    expect(link.code).toMatch(/^[A-Za-z0-9]{7}$/);
    expect(link).toMatchObject({
      short_url: `https://yoy.fyi/${link.code}`,
      target_url: "https://example.com/page",
      title: null,
      tags: [],
      utm_defaults: null,
      pass_click_id: false,
      expires_at: null,
      external_ref: null,
      status: "active",
      disabled_at: null,
    });
    expect(res.headers.get("location")).toBe(`/v1/links/${link.id}`);

    const redirect = await app.request(`https://yoy.fyi/${link.code}`);
    expect(redirect.status).toBe(302);
  });

  test("stores every optional field", async () => {
    const expires = new Date(Date.now() + 86_400_000).toISOString();
    const res = await create({
      target_url: "https://example.com/",
      code: "My_Code-1",
      title: "Fall launch",
      tags: ["fall", "ig:story"],
      utm_defaults: { utm_source: "ig", utm_campaign: "fall" },
      pass_click_id: true,
      expires_at: expires,
      external_ref: { service: "yoy", entity_type: "event", entity_id: "evt_1" },
    });

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      code: "My_Code-1",
      short_url: "https://yoy.fyi/My_Code-1",
      title: "Fall launch",
      tags: ["fall", "ig:story"],
      utm_defaults: { utm_source: "ig", utm_campaign: "fall" },
      pass_click_id: true,
      expires_at: expires,
      external_ref: { service: "yoy", entity_type: "event", entity_id: "evt_1" },
    });
  });

  test("short URLs come from the configured public origin", async () => {
    const test = appWith({ publicOrigin: "https://yoy-fyi-test.fly.dev" });

    const res = await call("POST", "/v1/links", { target_url: "https://example.com/" }, {}, test);

    expect((await res.json()).short_url).toStartWith("https://yoy-fyi-test.fly.dev/");
  });

  test("requires links:write", async () => {
    const { token: readOnly } = await issueKey(sql, { serviceSlug: "yoy", name: "ro", scopes: ["links:read"] });

    const res = await call("POST", "/v1/links", { target_url: "https://example.com/" }, {}, app, readOnly);

    expect(res.status).toBe(403);
  });

  test("malformed JSON returns 400 invalid_request", async () => {
    const res = await create("{nope");

    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("invalid_request");
  });

  test("reports every invalid field at once", async () => {
    const res = await create({
      target_url: 42,
      code: "has space",
      title: "x".repeat(201),
      tags: ["UPPER"],
      utm_defaults: { source: "ig" },
      pass_click_id: "yes",
      expires_at: "tomorrow",
      external_ref: { service: "yoy" },
      surprise: true,
    });

    expect(res.status).toBe(422);
    const { error } = await res.json();
    expect(error.code).toBe("validation_failed");
    expect(Object.keys(error.details.fields).sort()).toEqual(
      ["code", "expires_at", "external_ref", "pass_click_id", "surprise", "tags", "target_url", "title", "utm_defaults"].sort(),
    );
  });

  test("an expiry in the past is invalid", async () => {
    const res = await create({ target_url: "https://example.com/", expires_at: "2020-01-01T00:00:00Z" });

    expect(res.status).toBe(422);
    expect((await res.json()).error.details.fields).toHaveProperty("expires_at");
  });

  test("rejected targets return 422 target_rejected with the reason", async () => {
    const res = await create({ target_url: "https://yoy.fyi/loop" });

    expect(res.status).toBe(422);
    const { error } = await res.json();
    expect(error).toMatchObject({ code: "target_rejected", details: { reason: "own_host" } });
  });

  test.each(["v1", "admin", "Admin", "health", "qr", "static", "openapi"])("reserved code %s returns 422", async (code) => {
    const res = await create({ target_url: "https://example.com/", code });

    expect(res.status).toBe(422);
    expect(await errorCode(res)).toBe("code_reserved");
  });

  test("a taken custom code returns 409 code_taken, even across services", async () => {
    const { token: other } = await issueKey(sql, { serviceSlug: "diduny", name: "p", scopes: ["links:write"] });
    await call("POST", "/v1/links", { target_url: "https://example.com/", code: "taken" }, {}, app, other);

    const res = await create({ target_url: "https://example.com/", code: "taken" });

    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("code_taken");
  });
});

describe("create idempotency", () => {
  const body = { target_url: "https://example.com/", title: "a" };

  test("the same Idempotency-Key and body returns the existing link with 200", async () => {
    const first = await create(body, { "idempotency-key": "k1" });
    const again = await create({ title: "a", target_url: "https://example.com/" }, { "idempotency-key": "k1" });

    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect((await again.json()).id).toBe((await first.json()).id);
    const [{ count }] = await sql`select count(*)::int as count from links`;
    expect(count).toBe(1);
  });

  test("the same Idempotency-Key with a different body returns 422", async () => {
    await create(body, { "idempotency-key": "k1" });

    const res = await create({ ...body, title: "b" }, { "idempotency-key": "k1" });

    expect(res.status).toBe(422);
    expect(await errorCode(res)).toBe("idempotency_key_reused");
  });

  test("Idempotency-Keys are scoped to the service", async () => {
    const { token: other } = await issueKey(sql, { serviceSlug: "diduny", name: "p", scopes: ["links:write"] });
    const mine = await create(body, { "idempotency-key": "k1" });

    const theirs = await call("POST", "/v1/links", body, { "idempotency-key": "k1" }, app, other);

    expect(theirs.status).toBe(201);
    expect((await theirs.json()).id).not.toBe((await mine.json()).id);
  });

  test("an overlong Idempotency-Key returns 400", async () => {
    const res = await create(body, { "idempotency-key": "k".repeat(256) });

    expect(res.status).toBe(400);
  });

  test("the same external_ref returns the existing link whatever the body says", async () => {
    const ref = { service: "yoy", entity_type: "event", entity_id: "evt_1" };
    const first = await create({ target_url: "https://example.com/a", external_ref: ref });

    const again = await create({ target_url: "https://example.com/b", external_ref: ref });

    expect(again.status).toBe(200);
    const link = await again.json();
    expect(link.id).toBe((await first.json()).id);
    expect(link.target_url).toBe("https://example.com/a");
  });

  test("concurrent creates with one Idempotency-Key make one link", async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => create(body, { "idempotency-key": "race" })));

    const ids = new Set(await Promise.all(results.map(async (r) => (await r.json()).id)));
    expect(ids.size).toBe(1);
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 201]);
  });

  test("concurrent creates with one external_ref make one link", async () => {
    const ref = { service: "yoy", entity_type: "event", entity_id: "evt_2" };
    const results = await Promise.all(
      Array.from({ length: 5 }, () => create({ target_url: "https://example.com/", external_ref: ref })),
    );

    const ids = new Set(await Promise.all(results.map(async (r) => (await r.json()).id)));
    expect(ids.size).toBe(1);
  });
});

describe("create rate limit", () => {
  test("limits creates per API key and reports the quota", async () => {
    const limited = appWith({ createLimit: { perMinute: 60, burst: 2 } });
    const post = () => call("POST", "/v1/links", { target_url: "https://example.com/" }, {}, limited);

    const ok = await post();
    expect(ok.headers.get("ratelimit-limit")).toBe("2");
    expect(ok.headers.get("ratelimit-remaining")).toBe("1");
    await post();
    const res = await post();

    expect(res.status).toBe(429);
    expect(await errorCode(res)).toBe("rate_limited");
    expect(res.headers.get("retry-after")).toBe("1");
  });
});
