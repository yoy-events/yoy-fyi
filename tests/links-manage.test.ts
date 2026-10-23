import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { createApp } from "../src/app";
import { issueKey } from "../src/keys";
import { reset, testDb } from "./helpers";

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
  });
});

beforeEach(async () => {
  await reset(sql);
  ({ token } = await issueKey(sql, { serviceSlug: "yoy", name: "prod", scopes: ["links:write", "links:read"] }));
});

const call = (method: string, path: string, body?: unknown, key = token) =>
  app.request(`https://yoy.fyi${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const create = async (body: Record<string, unknown> = {}, key = token) =>
  (await call("POST", "/v1/links", { target_url: "https://example.com/", ...body }, key)).json();

const list = async (query = "") => {
  const res = await call("GET", `/v1/links${query}`);
  expect(res.status).toBe(200);
  return res.json();
};
const codes = (page: { data: { code: string }[] }) => page.data.map((l) => l.code);

describe("GET /v1/links", () => {
  test("lists this service's links newest first, never another service's", async () => {
    const { token: other } = await issueKey(sql, { serviceSlug: "diduny", name: "p", scopes: ["links:write"] });
    await create({ code: "a" });
    await create({ code: "b" });
    await create({ code: "theirs" }, other);

    const page = await list();

    expect(codes(page)).toEqual(["b", "a"]);
    expect(page.next_cursor).toBeNull();
  });

  test("pages with limit and cursor", async () => {
    for (const code of ["a", "b", "c"]) await create({ code });

    const p1 = await list("?limit=2");
    const p2 = await list(`?limit=2&cursor=${p1.next_cursor}`);

    expect(codes(p1)).toEqual(["c", "b"]);
    expect(codes(p2)).toEqual(["a"]);
    expect(p2.next_cursor).toBeNull();
  });

  test("filters by tag, code and external_ref", async () => {
    await create({ code: "a", tags: ["fall", "ig"] });
    await create({ code: "b", tags: ["ig"] });
    await create({ code: "c", external_ref: { service: "yoy", entity_type: "event", entity_id: "e1" } });
    await create({ code: "d", external_ref: { service: "yoy", entity_type: "event", entity_id: "e2" } });

    expect(codes(await list("?tag=fall"))).toEqual(["a"]);
    expect(codes(await list("?tag=ig"))).toEqual(["b", "a"]);
    expect(codes(await list("?code=b"))).toEqual(["b"]);
    expect(codes(await list("?ext_service=yoy&ext_entity_type=event"))).toEqual(["d", "c"]);
    expect(codes(await list("?ext_service=yoy&ext_entity_type=event&ext_entity_id=e1"))).toEqual(["c"]);
  });

  test("filters by creation time", async () => {
    await create({ code: "old" });
    await sql`update links set created_at = '2026-01-01T00:00:00Z' where code = 'old'`;
    await create({ code: "new" });

    expect(codes(await list("?created_after=2026-06-01T00:00:00Z"))).toEqual(["new"]);
    expect(codes(await list("?created_before=2026-06-01T00:00:00Z"))).toEqual(["old"]);
  });

  test("filters by status", async () => {
    await create({ code: "live" });
    await create({ code: "exp" });
    await create({ code: "off" });
    await sql`update links set expires_at = now() - interval '1 minute' where code = 'exp'`;
    await sql`update links set disabled_at = now(), expires_at = now() - interval '1 minute' where code = 'off'`;

    expect(codes(await list("?status=active"))).toEqual(["live"]);
    expect(codes(await list("?status=expired"))).toEqual(["exp"]);
    expect(codes(await list("?status=disabled"))).toEqual(["off"]);
    expect(codes(await list())).toEqual(["off", "exp", "live"]);
  });

  test.each(["?limit=0", "?limit=101", "?cursor=garbage", "?status=gone", "?created_after=yesterday", "?tag=UPPER"])(
    "rejects %s with 400",
    async (query) => {
      const res = await call("GET", `/v1/links${query}`);

      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("invalid_request");
    },
  );

  test("requires links:read", async () => {
    const { token: writeOnly } = await issueKey(sql, { serviceSlug: "yoy", name: "wo", scopes: ["links:write"] });

    expect((await call("GET", "/v1/links", undefined, writeOnly)).status).toBe(403);
  });
});
