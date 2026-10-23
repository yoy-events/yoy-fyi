import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { createApp } from "../src/app";
import { issueKey } from "../src/keys";
import { reset, testDb } from "./helpers";

let sql: SQL;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  sql = await testDb();
  app = createApp({ sql, publicOrigin: "https://yoy.fyi", countryOf: () => null });
});

beforeEach(async () => {
  await reset(sql);
});

const call = (method: string, path: string, token?: string, body?: unknown) =>
  app.request(`https://yoy.fyi${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

const ALL = ["links:write", "links:read", "analytics:read", "keys:manage", "webhooks:manage"] as const;

describe("issueKey", () => {
  test("creates the service on first use and returns a yfi_ token once", async () => {
    const { token, key } = await issueKey(sql, { serviceSlug: "yoy", name: "prod", scopes: ["links:read"] });

    expect(token).toMatch(/^yfi_[A-Za-z0-9]{8}_[A-Za-z0-9]{32}$/);
    expect(token.startsWith(key.prefix + "_")).toBe(true);
    const [service] = await sql`select slug from services`;
    expect(service.slug).toBe("yoy");
  });

  test("stores only a hash of the secret", async () => {
    const { token } = await issueKey(sql, { serviceSlug: "yoy", name: "prod", scopes: ["links:read"] });

    const [row] = await sql`select * from api_keys`;
    const secret = token.split("_")[2]!;
    expect(JSON.stringify(row)).not.toContain(secret);
    expect(row.secret_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("bearer auth", () => {
  test("a valid key identifies its service and key on /v1/me", async () => {
    const { token, key } = await issueKey(sql, { serviceSlug: "yoy", name: "prod", scopes: ["links:read"] });

    const res = await call("GET", "/v1/me", token);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.service).toMatchObject({ slug: "yoy", name: "yoy" });
    expect(body.key).toMatchObject({ id: key.id, name: "prod", prefix: key.prefix, scopes: ["links:read"] });
    expect(JSON.stringify(body)).not.toContain(token);
  });

  test.each([
    ["missing", undefined],
    ["malformed", "not-a-key"],
    ["unknown prefix", "yfi_AAAAAAAA_" + "a".repeat(32)],
  ])("%s key returns 401 unauthorized", async (_, token) => {
    const res = await call("GET", "/v1/me", token);

    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("unauthorized");
  });

  test("a known prefix with the wrong secret returns 401", async () => {
    const { token } = await issueKey(sql, { serviceSlug: "yoy", name: "prod", scopes: ["links:read"] });
    const forged = token.slice(0, 13) + "b".repeat(32);

    expect((await call("GET", "/v1/me", forged)).status).toBe(401);
  });

  test("a key of a disabled service returns 401", async () => {
    const { token } = await issueKey(sql, { serviceSlug: "yoy", name: "prod", scopes: ["links:read"] });
    await sql`update services set disabled_at = now()`;

    expect((await call("GET", "/v1/me", token)).status).toBe(401);
  });

  test("records last use", async () => {
    const { token } = await issueKey(sql, { serviceSlug: "yoy", name: "prod", scopes: ["links:read"] });

    await call("GET", "/v1/me", token);

    const [row] = await sql`select last_used_at from api_keys`;
    expect(row.last_used_at).toBeInstanceOf(Date);
  });
});

describe("key management", () => {
  test("requires keys:manage", async () => {
    const { token } = await issueKey(sql, { serviceSlug: "yoy", name: "prod", scopes: ["links:read"] });

    const res = await call("GET", "/v1/keys", token);

    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("missing_scope");
  });

  test("creates a working key and shows its secret only once", async () => {
    const { token } = await issueKey(sql, { serviceSlug: "yoy", name: "admin", scopes: [...ALL] });

    const res = await call("POST", "/v1/keys", token, { name: "rotated", scopes: ["links:read"] });

    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.key).toMatchObject({ name: "rotated", scopes: ["links:read"], revoked_at: null });
    expect((await call("GET", "/v1/me", created.secret)).status).toBe(200);
    const list = await (await call("GET", "/v1/keys", token)).json();
    expect(JSON.stringify(list)).not.toContain(created.secret);
    expect(list.data.map((k: { name: string }) => k.name).sort()).toEqual(["admin", "rotated"]);
  });

  test("cannot grant scopes the caller does not have", async () => {
    const { token } = await issueKey(sql, { serviceSlug: "yoy", name: "k", scopes: ["keys:manage", "links:read"] });

    const res = await call("POST", "/v1/keys", token, { name: "x", scopes: ["links:write"] });

    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("scope_not_allowed");
  });

  test("rejects an invalid body with validation_failed", async () => {
    const { token } = await issueKey(sql, { serviceSlug: "yoy", name: "k", scopes: [...ALL] });

    const res = await call("POST", "/v1/keys", token, { name: "", scopes: ["nope"] });

    expect(res.status).toBe(422);
    const { error } = await res.json();
    expect(error.code).toBe("validation_failed");
    expect(Object.keys(error.details.fields).sort()).toEqual(["name", "scopes"]);
  });

  test("revoking a key stops it immediately; revoking again is a no-op", async () => {
    const { token } = await issueKey(sql, { serviceSlug: "yoy", name: "admin", scopes: [...ALL] });
    const other = await issueKey(sql, { serviceSlug: "yoy", name: "old", scopes: ["links:read"] });

    const first = await call("POST", `/v1/keys/${other.key.id}/revoke`, token);
    const again = await call("POST", `/v1/keys/${other.key.id}/revoke`, token);

    expect(first.status).toBe(200);
    const revokedAt = (await first.json()).revoked_at;
    expect(revokedAt).toBeTruthy();
    expect((await again.json()).revoked_at).toBe(revokedAt);
    expect((await call("GET", "/v1/me", other.token)).status).toBe(401);
  });

  test("revoked keys are listed only on request", async () => {
    const { token } = await issueKey(sql, { serviceSlug: "yoy", name: "admin", scopes: [...ALL] });
    const other = await issueKey(sql, { serviceSlug: "yoy", name: "old", scopes: ["links:read"] });
    await call("POST", `/v1/keys/${other.key.id}/revoke`, token);

    const active = await (await call("GET", "/v1/keys", token)).json();
    const all = await (await call("GET", "/v1/keys?include_revoked=true", token)).json();

    expect(active.data).toHaveLength(1);
    expect(all.data).toHaveLength(2);
  });

  test("pages with an opaque cursor", async () => {
    const { token } = await issueKey(sql, { serviceSlug: "yoy", name: "a", scopes: [...ALL] });
    await issueKey(sql, { serviceSlug: "yoy", name: "b", scopes: ["links:read"] });
    await issueKey(sql, { serviceSlug: "yoy", name: "c", scopes: ["links:read"] });

    const p1 = await (await call("GET", "/v1/keys?limit=2", token)).json();
    const p2 = await (await call("GET", `/v1/keys?limit=2&cursor=${p1.next_cursor}`, token)).json();

    expect(p1.data.map((k: { name: string }) => k.name)).toEqual(["c", "b"]);
    expect(p2.data.map((k: { name: string }) => k.name)).toEqual(["a"]);
    expect(p2.next_cursor).toBeNull();
  });

  test("another service's key is invisible: revoke returns 404", async () => {
    const { token } = await issueKey(sql, { serviceSlug: "yoy", name: "admin", scopes: [...ALL] });
    const foreign = await issueKey(sql, { serviceSlug: "diduny", name: "prod", scopes: ["links:read"] });

    const res = await call("POST", `/v1/keys/${foreign.key.id}/revoke`, token);

    expect(res.status).toBe(404);
    expect((await call("GET", "/v1/me", foreign.token)).status).toBe(200);
  });

  test("a malformed id returns 404, not a server error", async () => {
    const { token } = await issueKey(sql, { serviceSlug: "yoy", name: "admin", scopes: [...ALL] });

    expect((await call("POST", "/v1/keys/not-a-uuid/revoke", token)).status).toBe(404);
  });
});
