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
    // An offset is honoured: 03:00+03:00 is midnight UTC.
    expect(codes(await list("?created_after=2026-06-01T03:00:00%2B03:00"))).toEqual(["new"]);
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

  test.each([
    "?limit=0",
    "?limit=101",
    "?cursor=garbage",
    "?status=gone",
    "?created_after=yesterday",
    "?tag=UPPER",
    // RFC 3339 in shape but not a real date-time.
    "?created_after=2026-13-01T00:00:00Z",
    "?created_before=2026-01-01T25:00:00Z",
    "?created_before=2026-02-30T00:00:00Z",
  ])(
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

describe("PATCH /v1/links/{id}", () => {
  const patch = (id: string, body: unknown, key = token) => call("PATCH", `/v1/links/${id}`, body, key);

  test("changes the target and metadata, leaving omitted fields alone", async () => {
    const link = await create({ code: "p", title: "old", tags: ["a"], pass_click_id: true });

    const res = await patch(link.id, { target_url: "https://example.org/new", title: "new", tags: ["b"] });

    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated).toMatchObject({
      target_url: "https://example.org/new",
      title: "new",
      tags: ["b"],
      pass_click_id: true,
      code: "p",
    });
    expect(Date.parse(updated.updated_at)).toBeGreaterThan(Date.parse(link.updated_at));
    const redirect = await app.request("https://yoy.fyi/p");
    expect(redirect.headers.get("location")).toStartWith("https://example.org/new?yoy_sid=");
  });

  test("null clears title, utm_defaults and expires_at", async () => {
    const link = await create({
      title: "t",
      utm_defaults: { utm_source: "ig" },
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });

    const updated = await (await patch(link.id, { title: null, utm_defaults: null, expires_at: null })).json();

    expect(updated).toMatchObject({ title: null, utm_defaults: null, expires_at: null });
  });

  test("an empty body is a validation error", async () => {
    const link = await create();

    const res = await patch(link.id, {});

    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("validation_failed");
  });

  test("code and external_ref cannot change; required fields cannot be null", async () => {
    const link = await create();

    const res = await patch(link.id, {
      code: "new",
      external_ref: { service: "yoy", entity_type: "e", entity_id: "1" },
      target_url: null,
      tags: null,
      pass_click_id: null,
      expires_at: "2020-01-01T00:00:00Z",
    });

    expect(res.status).toBe(422);
    const { fields } = (await res.json()).error.details;
    expect(Object.keys(fields).sort()).toEqual(
      ["code", "expires_at", "external_ref", "pass_click_id", "tags", "target_url"].sort(),
    );
  });

  test("a new target must pass the target policy", async () => {
    const link = await create();

    const res = await patch(link.id, { target_url: "http://10.0.0.1/" });

    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatchObject({ code: "target_rejected", details: { reason: "private_address" } });
  });

  test("a disabled link cannot be updated", async () => {
    const link = await create();
    await sql`update links set disabled_at = now()`;

    const res = await patch(link.id, { title: "x" });

    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("link_disabled");
  });

  test("another service's link is 404 and links:write is required", async () => {
    const { token: other } = await issueKey(sql, { serviceSlug: "diduny", name: "p", scopes: ["links:write", "links:read"] });
    const { token: readOnly } = await issueKey(sql, { serviceSlug: "yoy", name: "ro", scopes: ["links:read"] });
    const link = await create();

    expect((await patch(link.id, { title: "x" }, other)).status).toBe(404);
    expect((await patch(link.id, { title: "x" }, readOnly)).status).toBe(403);
    expect((await patch("not-a-uuid", { title: "x" })).status).toBe(404);
  });
});

describe("POST /v1/links/{id}/disable", () => {
  const disable = (id: string, key = token) => call("POST", `/v1/links/${id}/disable`, undefined, key);

  test("disables the link, which then answers 410, and keeps its row", async () => {
    const link = await create({ code: "bye" });

    const res = await disable(link.id);

    expect(res.status).toBe(200);
    const disabled = await res.json();
    expect(disabled.status).toBe("disabled");
    expect(disabled.disabled_at).toBeTruthy();
    expect((await app.request("https://yoy.fyi/bye")).status).toBe(410);
    const [{ count }] = await sql`select count(*)::int as count from links`;
    expect(count).toBe(1);
  });

  test("is idempotent", async () => {
    const link = await create();
    const first = await (await disable(link.id)).json();

    const again = await disable(link.id);

    expect(again.status).toBe(200);
    expect((await again.json()).disabled_at).toBe(first.disabled_at);
  });

  test("the code stays taken after disabling", async () => {
    const link = await create({ code: "keep" });
    await disable(link.id);

    const res = await call("POST", "/v1/links", { target_url: "https://example.com/", code: "keep" });

    expect(res.status).toBe(409);
  });

  test("another service's link is 404 and links:write is required", async () => {
    const { token: other } = await issueKey(sql, { serviceSlug: "diduny", name: "p", scopes: ["links:write"] });
    const { token: readOnly } = await issueKey(sql, { serviceSlug: "yoy", name: "ro", scopes: ["links:read"] });
    const link = await create();

    expect((await disable(link.id, other)).status).toBe(404);
    expect((await disable(link.id, readOnly)).status).toBe(403);
    expect((await disable("nope")).status).toBe(404);
  });
});

describe("QR codes", () => {
  test("SVG encodes the short URL", async () => {
    const link = await create({ code: "qr1" });

    const res = await call("GET", `/v1/links/${link.id}/qr.svg`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    const QRCode = await import("qrcode");
    expect(await res.text()).toBe(await QRCode.toString("https://yoy.fyi/qr1", { type: "svg", margin: 2 }));
  });

  test("PNG defaults to 512 px and honours size", async () => {
    const link = await create();
    const width = async (res: Response) => {
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect([...bytes.slice(1, 4)]).toEqual([0x50, 0x4e, 0x47]); // "PNG"
      return new DataView(bytes.buffer).getUint32(16); // IHDR width
    };

    const plain = await call("GET", `/v1/links/${link.id}/qr.png`);
    const sized = await call("GET", `/v1/links/${link.id}/qr.png?size=256`);

    expect(plain.headers.get("content-type")).toBe("image/png");
    expect(await width(plain)).toBe(512);
    expect(await width(sized)).toBe(256);
  });

  test.each(["127", "2049", "abc"])("size=%s returns 422", async (size) => {
    const link = await create();

    const res = await call("GET", `/v1/links/${link.id}/qr.png?size=${size}`);

    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("validation_failed");
  });

  test("works for disabled links", async () => {
    const link = await create();
    await call("POST", `/v1/links/${link.id}/disable`);

    expect((await call("GET", `/v1/links/${link.id}/qr.svg`)).status).toBe(200);
  });

  test("another service's link is 404 and links:read is required", async () => {
    const { token: other } = await issueKey(sql, { serviceSlug: "diduny", name: "p", scopes: ["links:read"] });
    const { token: writeOnly } = await issueKey(sql, { serviceSlug: "yoy", name: "wo", scopes: ["links:write"] });
    const link = await create();

    expect((await call("GET", `/v1/links/${link.id}/qr.svg`, undefined, other)).status).toBe(404);
    expect((await call("GET", `/v1/links/${link.id}/qr.png`, undefined, writeOnly)).status).toBe(403);
  });
});
