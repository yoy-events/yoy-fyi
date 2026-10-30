// Valid, invalid and empty input for every /v1 endpoint that takes a body or required query.
// Deeper behaviour lives in the per-resource test files; this file pins the input contract.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { createApp } from "../src/app";
import { issueKey } from "../src/keys";
import { loadSecretKey } from "../src/secretbox";
import { reset, testDb, testWebhookKey } from "./helpers";

let sql: SQL;
let app: ReturnType<typeof createApp>;
let token: string;

beforeAll(async () => {
  sql = await testDb();
  app = createApp({
    sql,
    publicOrigin: "https://yoy.fyi",
    countryOf: () => null,
    resolveHost: async () => ["93.184.215.14"],
    webhookKey: await loadSecretKey(testWebhookKey()),
  });
});

beforeEach(async () => {
  await reset(sql);
  ({ token } = await issueKey(sql, {
    serviceSlug: "yoy",
    name: "all",
    scopes: ["links:write", "links:read", "analytics:read", "keys:manage", "webhooks:manage"],
  }));
});

// `raw` sends the body exactly as given; anything else is JSON-encoded.
const send = (method: string, path: string, body?: { raw: string } | unknown) =>
  app.request(`https://yoy.fyi${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : typeof body === "object" && body && "raw" in body ? (body as { raw: string }).raw : JSON.stringify(body),
  });

const errorOf = async (res: Response) => (await res.json()).error;

const EMPTY_BODIES = [
  ["no body", undefined],
  ["an empty string", { raw: "" }],
  ["whitespace", { raw: "  " }],
  ["null", { raw: "null" }],
  ["an array", { raw: "[]" }],
  ["malformed JSON", { raw: "{" }],
] as const;

async function newLinkId(): Promise<string> {
  const res = await send("POST", "/v1/links", { target_url: "https://example.com/" });
  return (await res.json()).id;
}

describe("POST /v1/links", () => {
  test("valid: a target URL alone creates a link", async () => {
    expect((await send("POST", "/v1/links", { target_url: "https://example.com/a" })).status).toBe(201);
  });

  test("valid: empty optional collections are accepted", async () => {
    const res = await send("POST", "/v1/links", { target_url: "https://example.com/a", tags: [], utm_defaults: {} });
    expect(res.status).toBe(201);
  });

  test.each(EMPTY_BODIES)("empty: %s returns 400 invalid_request", async (_, body) => {
    const res = await send("POST", "/v1/links", body);
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("invalid_request");
  });

  test("empty: {} names target_url as missing", async () => {
    const res = await send("POST", "/v1/links", {});
    expect(res.status).toBe(422);
    expect(Object.keys((await errorOf(res)).details.fields)).toEqual(["target_url"]);
  });

  test.each([
    ["target_url", { target_url: "" }],
    ["code", { target_url: "https://example.com/", code: "" }],
    ["tags", { target_url: "https://example.com/", tags: [""] }],
    ["external_ref", { target_url: "https://example.com/", external_ref: { service: "", entity_type: "", entity_id: "" } }],
  ])("empty: an empty %s returns 422", async (_, body) => {
    expect((await send("POST", "/v1/links", body)).status).toBe(422);
  });

  test.each([
    ["target_url as a number", { target_url: 42 }],
    ["pass_click_id as a string", { target_url: "https://example.com/", pass_click_id: "yes" }],
    ["tags as a string", { target_url: "https://example.com/", tags: "a" }],
    ["an unknown field", { target_url: "https://example.com/", owner: "me" }],
    ["expires_at that is not a date", { target_url: "https://example.com/", expires_at: "tomorrow" }],
    ["expires_at on a day the month does not have", { target_url: "https://example.com/", expires_at: "2099-02-30T00:00:00Z" }],
  ])("invalid: %s returns 422 validation_failed", async (_, body) => {
    const res = await send("POST", "/v1/links", body);
    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe("validation_failed");
  });
});

describe("PATCH /v1/links/{id}", () => {
  test("valid: a new title is saved", async () => {
    const id = await newLinkId();
    const res = await send("PATCH", `/v1/links/${id}`, { title: "Launch" });
    expect(res.status).toBe(200);
    expect((await res.json()).title).toBe("Launch");
  });

  test.each(EMPTY_BODIES)("empty: %s returns 400 invalid_request", async (_, body) => {
    const id = await newLinkId();
    expect((await send("PATCH", `/v1/links/${id}`, body)).status).toBe(400);
  });

  test.each([
    ["{}", {}],
    ["an empty target_url", { target_url: "" }],
    ["tags with an empty tag", { tags: [""] }],
  ])("empty: %s returns 422", async (_, body) => {
    const id = await newLinkId();
    expect((await send("PATCH", `/v1/links/${id}`, body)).status).toBe(422);
  });

  test("invalid: pass_click_id as a string returns 422 validation_failed", async () => {
    const id = await newLinkId();
    const res = await send("PATCH", `/v1/links/${id}`, { pass_click_id: "yes" });
    expect(res.status).toBe(422);
    expect((await errorOf(res)).code).toBe("validation_failed");
  });
});

describe("GET /v1/links", () => {
  test("valid: a tag filter returns matching links", async () => {
    await send("POST", "/v1/links", { target_url: "https://example.com/", tags: ["a"] });
    const res = await send("GET", "/v1/links?tag=a");
    expect((await res.json()).data).toHaveLength(1);
  });

  test.each(["tag=", "code=", "status=", "limit=", "cursor="])("empty: %s returns 400", async (query) => {
    expect((await send("GET", `/v1/links?${query}`)).status).toBe(400);
  });

  test.each(["limit=0", "limit=101", "limit=x", "status=gone", "created_after=yesterday", "cursor=not-a-cursor"])(
    "invalid: %s returns 400",
    async (query) => {
      expect((await send("GET", `/v1/links?${query}`)).status).toBe(400);
    },
  );
});

describe("other lists", () => {
  test.each(["/v1/keys?cursor=", "/v1/keys?limit=", "/v1/keys?cursor=x"])("%s returns 400", async (path) => {
    expect((await send("GET", path)).status).toBe(400);
  });

  test.each(["cursor=", "status=", "cursor=x", "status=lost"])("webhook deliveries ?%s returns 400", async (query) => {
    const hook = await (await send("POST", "/v1/webhooks", { url: "https://hooks.example.com/yoy" })).json();
    expect((await send("GET", `/v1/webhooks/${hook.id}/deliveries?${query}`)).status).toBe(400);
  });
});

describe("POST /v1/keys", () => {
  test("valid: a name and scopes create a key", async () => {
    expect((await send("POST", "/v1/keys", { name: "ci", scopes: ["links:read"] })).status).toBe(201);
  });

  test.each(EMPTY_BODIES)("empty: %s returns 400 invalid_request", async (_, body) => {
    expect((await send("POST", "/v1/keys", body)).status).toBe(400);
  });

  test("empty: {} names name and scopes as missing", async () => {
    const res = await send("POST", "/v1/keys", {});
    expect(res.status).toBe(422);
    expect(Object.keys((await errorOf(res)).details.fields).sort()).toEqual(["name", "scopes"]);
  });

  test.each([
    ["name", { name: "", scopes: ["links:read"] }],
    ["scopes", { name: "ci", scopes: [] }],
  ])("empty: an empty %s returns 422", async (_, body) => {
    expect((await send("POST", "/v1/keys", body)).status).toBe(422);
  });

  test.each([
    ["an unknown scope", { name: "ci", scopes: ["links:delete"] }],
    ["a repeated scope", { name: "ci", scopes: ["links:read", "links:read"] }],
    ["a name over 100 characters", { name: "x".repeat(101), scopes: ["links:read"] }],
  ])("invalid: %s returns 422", async (_, body) => {
    expect((await send("POST", "/v1/keys", body)).status).toBe(422);
  });
});

describe("POST /v1/webhooks", () => {
  test("valid: an https URL registers a webhook", async () => {
    expect((await send("POST", "/v1/webhooks", { url: "https://hooks.example.com/yoy" })).status).toBe(201);
  });

  test.each(EMPTY_BODIES)("empty: %s returns 400 invalid_request", async (_, body) => {
    expect((await send("POST", "/v1/webhooks", body)).status).toBe(400);
  });

  test.each([
    ["{}", {}],
    ["an empty url", { url: "" }],
    ["empty events", { url: "https://hooks.example.com/yoy", events: [] }],
  ])("empty: %s returns 422", async (_, body) => {
    expect((await send("POST", "/v1/webhooks", body)).status).toBe(422);
  });

  test.each([
    ["an http URL", { url: "http://hooks.example.com/yoy" }],
    ["a non-default port", { url: "https://hooks.example.com:8443/yoy" }],
    ["an unknown event", { url: "https://hooks.example.com/yoy", events: ["link.created"] }],
    ["include_bots as a string", { url: "https://hooks.example.com/yoy", include_bots: "no" }],
  ])("invalid: %s returns 422", async (_, body) => {
    expect((await send("POST", "/v1/webhooks", body)).status).toBe(422);
  });
});

describe("analytics", () => {
  const range = "from=2026-10-01T00:00:00Z&to=2026-10-08T00:00:00Z";

  test("valid: a daily timeseries and a country breakdown", async () => {
    expect((await send("GET", `/v1/analytics/timeseries?${range}&interval=day`)).status).toBe(200);
    expect((await send("GET", `/v1/analytics/breakdown?${range}&dimension=country`)).status).toBe(200);
  });

  test.each([
    ["no query", "/v1/analytics/timeseries"],
    ["empty from and to", "/v1/analytics/timeseries?from=&to=&interval=day"],
    ["an empty interval", `/v1/analytics/timeseries?${range}&interval=`],
    ["an empty dimension", `/v1/analytics/breakdown?${range}&dimension=`],
  ])("empty: %s returns 400", async (_, path) => {
    expect((await send("GET", path)).status).toBe(400);
  });

  test.each([
    ["from after to", "/v1/analytics/timeseries?from=2026-10-08T00:00:00Z&to=2026-10-01T00:00:00Z&interval=day"],
    ["a date that is not a date", "/v1/analytics/timeseries?from=monday&to=2026-10-08T00:00:00Z&interval=day"],
    ["an unknown interval", `/v1/analytics/timeseries?${range}&interval=week`],
    ["an unknown dimension", `/v1/analytics/breakdown?${range}&dimension=city`],
    ["bots=maybe", `/v1/analytics/timeseries?${range}&interval=day&bots=maybe`],
  ])("invalid: %s returns 400", async (_, path) => {
    expect((await send("GET", path)).status).toBe(400);
  });
});
