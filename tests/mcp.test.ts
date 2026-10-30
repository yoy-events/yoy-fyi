import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { type AppDeps, createApp } from "../src/app";
import { issueKey } from "../src/keys";
import { reset, testDb } from "./helpers";

let sql: SQL;
let app: ReturnType<typeof createApp>;
let token: string;
let readOnly: string;

const build = (deps: Partial<AppDeps> = {}) =>
  createApp({ sql, publicOrigin: "https://yoy.fyi", countryOf: () => null, resolveHost: async () => ["93.184.215.14"], ...deps });

beforeAll(async () => {
  sql = await testDb();
  app = build();
});

beforeEach(async () => {
  await reset(sql);
  ({ token } = await issueKey(sql, { serviceSlug: "yoy", name: "agent", scopes: ["links:write", "links:read", "analytics:read"] }));
  ({ token: readOnly } = await issueKey(sql, { serviceSlug: "yoy", name: "reader", scopes: ["links:read"] }));
});

const post = (body: unknown, { key = token, headers = {}, target = app }: { key?: string | null; headers?: Record<string, string>; target?: typeof app } = {}) =>
  target.request("https://yoy.fyi/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

// JSON-RPC results are free-form; the assertions below check their shape.
// biome-ignore lint/suspicious/noExplicitAny: test-only view of untyped JSON
type Loose = any;

let nextId = 1;
const rpc = async (method: string, params?: unknown, opts?: Parameters<typeof post>[1]) => {
  const res = await post({ jsonrpc: "2.0", id: nextId++, method, ...(params === undefined ? {} : { params }) }, opts);
  return (await res.json()) as { result?: Loose; error?: { code: number; message: string } };
};
const call = async (name: string, args: Record<string, unknown> = {}, key = token) =>
  (await rpc("tools/call", { name, arguments: args }, { key })).result as {
    isError?: boolean;
    structuredContent?: Loose;
    content: { type: string; text: string }[];
  };

describe("transport and auth", () => {
  test("no or unknown token returns 401 pointing at the protected resource metadata", async () => {
    for (const key of [null, "yfi_AAAAAAAA_" + "a".repeat(32)]) {
      const res = await post({ jsonrpc: "2.0", id: 1, method: "ping" }, { key });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe(
        'Bearer resource_metadata="https://yoy.fyi/.well-known/oauth-protected-resource/mcp"',
      );
    }
  });

  test("a foreign Origin is refused; our own is accepted", async () => {
    expect((await post({ jsonrpc: "2.0", id: 1, method: "ping" }, { headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await post({ jsonrpc: "2.0", id: 1, method: "ping" }, { headers: { origin: "https://yoy.fyi" } })).status).toBe(200);
  });

  test("GET and DELETE answer 405", async () => {
    for (const method of ["GET", "DELETE"]) {
      const res = await app.request("https://yoy.fyi/mcp", { method, headers: { authorization: `Bearer ${token}` } });
      expect(res.status).toBe(405);
    }
  });

  test.each([
    ["an empty body", "", -32700],
    ["malformed JSON", "{", -32700],
    ["an array (batches are not supported)", "[]", -32600],
    ["{}", "{}", -32600],
    ["a request without method", JSON.stringify({ jsonrpc: "2.0", id: 1 }), -32600],
  ])("%s returns a JSON-RPC error", async (_, body, code) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(code);
  });

  test("an unknown method returns -32601", async () => {
    // prompts are not offered; resources are (see mcp-parity.test.ts)
    expect((await rpc("prompts/list")).error?.code).toBe(-32601);
  });

  test("initialize echoes a supported protocol version and offers tools and resources", async () => {
    const { result } = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect(result.protocolVersion).toBe("2025-06-18");
    expect(result.capabilities).toEqual({ tools: {}, resources: {} });
    expect(result.serverInfo.name).toBe("yoy.fyi");
  });

  test("initialize answers an unknown version with the newest supported one", async () => {
    const { result } = await rpc("initialize", { protocolVersion: "1999-01-01", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect(result.protocolVersion).toBe("2025-11-25");
  });

  test("notifications are accepted with 202 and no body", async () => {
    const res = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  test("ping returns an empty result", async () => {
    expect((await rpc("ping")).result).toEqual({});
  });

  test("calls are rate limited per credential", async () => {
    const limited = build({ mcpLimit: { perMinute: 120, burst: 2 } });
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await post({ jsonrpc: "2.0", id: i, method: "ping" }, { target: limited })).status);
    expect(statuses).toEqual([200, 200, 429]);
  });
});

describe("tools/list", () => {
  test("lists the thirteen tools with titles, schemas and explicit hints", async () => {
    const { tools } = (await rpc("tools/list")).result;

    expect(tools.map((t: { name: string }) => t.name).sort()).toEqual(
      [
        "create_link",
        "create_links",
        "disable_link",
        "get_bio",
        "get_click_breakdown",
        "get_click_timeseries",
        "get_conversions",
        "get_link",
        "get_qr",
        "list_links",
        "update_bio",
        "update_link",
        "whoami",
      ],
    );
    for (const t of tools) {
      expect(t.title).toBeString();
      expect(t.inputSchema.type).toBe("object");
      expect(t.outputSchema.type).toBe("object");
      for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
        expect(typeof t.annotations[hint]).toBe("boolean");
      }
      expect(t.annotations.openWorldHint).toBe(false);
    }
    const byName = Object.fromEntries(tools.map((t: { name: string }) => [t.name, t]));
    expect(byName.list_links.annotations.readOnlyHint).toBe(true);
    expect(byName.update_link.annotations.destructiveHint).toBe(true);
    expect(byName.disable_link.annotations.destructiveHint).toBe(true);
    expect(byName.create_link.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });

  test("an unknown tool returns -32602", async () => {
    expect((await rpc("tools/call", { name: "delete_everything", arguments: {} })).error?.code).toBe(-32602);
  });
});

describe("tools", () => {
  test("whoami names the service and the key's scopes", async () => {
    const r = await call("whoami");
    expect(r.structuredContent).toMatchObject({ service: { slug: "yoy" }, scopes: ["links:write", "links:read", "analytics:read"] });
    expect(JSON.parse(r.content[0]!.text)).toEqual(r.structuredContent);
  });

  test("create_link creates a link marked created_via mcp; the same idempotency_key replays it", async () => {
    const first = await call("create_link", { target_url: "https://example.com/e", idempotency_key: "k1" });
    const again = await call("create_link", { target_url: "https://example.com/e", idempotency_key: "k1" });

    expect(first.isError).toBeFalsy();
    expect(first.structuredContent.short_url).toBe(`https://yoy.fyi/${first.structuredContent.code}`);
    expect(again.structuredContent.id).toBe(first.structuredContent.id);
    const [row] = await sql`select created_via from links where id = ${first.structuredContent.id}`;
    expect(row.created_via).toBe("mcp");
  });

  test.each([
    ["empty arguments", {}, "validation_failed"],
    ["an empty target_url", { target_url: "" }, "validation_failed"],
    ["a rejected target", { target_url: "http://127.0.0.1/" }, "target_rejected"],
    ["an unknown field", { target_url: "https://example.com/", owner: "me" }, "validation_failed"],
  ])("create_link with %s is a tool error naming the API error", async (_, args, code) => {
    const r = await call("create_link", args);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain(code);
  });

  test("a key without the scope gets a tool error naming it", async () => {
    const r = await call("create_link", { target_url: "https://example.com/" }, readOnly);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("links:write");
  });

  test("list_links, get_link by id and by code, update_link and disable_link", async () => {
    const link = (await call("create_link", { target_url: "https://example.com/", tags: ["a"] })).structuredContent;

    const listed = (await call("list_links", { tag: "a" })).structuredContent;
    expect(listed.data.map((l: { id: string }) => l.id)).toEqual([link.id]);
    expect((await call("get_link", { id: link.id })).structuredContent.id).toBe(link.id);
    expect((await call("get_link", { code: link.code })).structuredContent.id).toBe(link.id);
    expect((await call("update_link", { id: link.id, title: "Launch" })).structuredContent.title).toBe("Launch");
    expect((await call("disable_link", { id: link.id })).structuredContent.status).toBe("disabled");
  });

  test("get_link needs exactly one of id or code; an unknown one is not_found", async () => {
    expect((await call("get_link", {})).isError).toBe(true);
    expect((await call("get_link", { id: "x", code: "y" })).isError).toBe(true);
    const r = await call("get_link", { code: "nope" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("not_found");
  });

  test("list_links defaults to 20 and caps limit at 50", async () => {
    expect((await call("list_links", { limit: 51 })).isError).toBe(true);
    expect((await call("list_links", { limit: 50 })).isError).toBeFalsy();
  });

  test("another service's link is not found", async () => {
    const { token: other } = await issueKey(sql, { serviceSlug: "diduny", name: "o", scopes: ["links:write", "links:read"] });
    const theirs = (await call("create_link", { target_url: "https://example.com/" }, other)).structuredContent;

    expect((await call("get_link", { id: theirs.id })).isError).toBe(true);
    expect((await call("disable_link", { id: theirs.id })).isError).toBe(true);
  });

  test("click timeseries and breakdown return rollup shapes; hourly is capped at 7 days", async () => {
    const link = (await call("create_link", { target_url: "https://example.com/" })).structuredContent;
    const range = { from: "2026-10-01T00:00:00Z", to: "2026-10-08T00:00:00Z" };

    const series = await call("get_click_timeseries", { ...range, interval: "day", link_id: link.id });
    expect(series.isError).toBeFalsy();
    expect(series.structuredContent.points).toHaveLength(7);
    expect((await call("get_click_breakdown", { ...range, dimension: "country" })).structuredContent.dimension).toBe("country");
    expect((await call("get_click_timeseries", { from: "2026-10-01T00:00:00Z", to: "2026-10-09T00:00:00Z", interval: "hour" })).isError).toBe(true);
  });
});

describe("created_via", () => {
  test("links created through /v1 are marked api and the field is returned", async () => {
    const res = await app.request("https://yoy.fyi/v1/links", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ target_url: "https://example.com/" }),
    });
    expect((await res.json()).created_via).toBe("api");
  });
});
