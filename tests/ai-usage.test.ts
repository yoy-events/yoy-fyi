// Tracking use through AI assistants: MCP calls, links created by an OAuth client, clicks that
// come from AI chats, and the admin page that shows them.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { createApp } from "../src/app";
import { issueKey } from "../src/keys";
import { adminGet, adminSession } from "./admin-helpers";
import { addClick, reset, testAdmin, testDb } from "./helpers";

const ORIGIN = "https://yoy.fyi";
const CLIENT = "https://claude.ai/oauth/mcp-oauth-client-metadata";
const ACCESS = `yfo_${"a".repeat(43)}`;

let sql: SQL;
let app: ReturnType<typeof createApp>;
let mail: ReturnType<typeof testAdmin>;
let serviceId: string;
let apiKey: string;

const sha256 = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");

beforeAll(async () => {
  sql = await testDb();
});

beforeEach(async () => {
  await reset(sql);
  mail = testAdmin();
  app = createApp({ sql, publicOrigin: ORIGIN, countryOf: () => null, resolveHost: async () => ["93.184.215.14"], admin: mail.admin });
  ({ token: apiKey } = await issueKey(sql, { serviceSlug: "yoy", name: "k", scopes: ["links:read", "links:write", "analytics:read"] }));
  serviceId = (await sql`select id from services where slug = 'yoy'`)[0].id;
  await sql`insert into oauth_clients (client_id, name, redirect_uris, fetched_at) values (${CLIENT}, 'Claude', ${sql.array(["https://claude.ai/cb"], "text")}, now())`;
  await sql`
    insert into oauth_grants (id, client_id, service_id, scopes, access_hash, access_expires_at, refresh_hash, refresh_expires_at)
    values (${Bun.randomUUIDv7()}, ${CLIENT}, ${serviceId}, ${sql.array(["links:read", "links:write", "analytics:read"], "text")},
            ${sha256(ACCESS)}, now() + interval '1 hour', ${sha256("yfr_x")}, now() + interval '1 day')`;
});

const mcp = (bearer: string, method: string, params?: unknown) =>
  app.request(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
  });
const call = (bearer: string, name: string, args: Record<string, unknown> = {}) => mcp(bearer, "tools/call", { name, arguments: args });
const calls = () => sql`select client, tool, ok from mcp_calls order by at, id`;

describe("MCP call log", () => {
  test("a tool call over OAuth is logged with its client, tool and outcome", async () => {
    await call(ACCESS, "create_link", { target_url: "https://example.com/" });
    await call(ACCESS, "create_link", { target_url: "" });
    expect(await calls()).toEqual([
      { client: CLIENT, tool: "create_link", ok: true },
      { client: CLIENT, tool: "create_link", ok: false },
    ]);
  });

  test("a call with an API key is logged without a client", async () => {
    await call(apiKey, "whoami");
    expect(await calls()).toEqual([{ client: null, tool: "whoami", ok: true }]);
  });

  test("tools/list, unknown tools and unauthenticated calls are not logged", async () => {
    await mcp(ACCESS, "tools/list");
    await call(ACCESS, "no_such_tool");
    await call("yfo_wrong", "whoami");
    expect(await calls()).toEqual([]);
  });
});

describe("who created a link", () => {
  test("a link created over OAuth records the client; API-key and /v1 links do not", async () => {
    await call(ACCESS, "create_link", { target_url: "https://example.com/a", code: "viaai" });
    await call(apiKey, "create_link", { target_url: "https://example.com/b", code: "viakey" });
    await app.request(`${ORIGIN}/v1/links`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ target_url: "https://example.com/c", code: "viaapi" }),
    });
    const rows = await sql`select code, created_via, created_by_client from links order by code`;
    expect(rows).toEqual([
      { code: "viaai", created_via: "mcp", created_by_client: CLIENT },
      { code: "viaapi", created_via: "api", created_by_client: null },
      { code: "viakey", created_via: "mcp", created_by_client: null },
    ]);
  });
});

describe("admin AI page", () => {
  test("shows calls by client and tool, links made by AI, and clicks from AI chats", async () => {
    await call(ACCESS, "create_link", { target_url: "https://example.com/a", code: "viaai" });
    const [link] = await sql`select id from links`;
    const at = new Date(Date.now() - 3600_000).toISOString();
    await addClick(sql, { link_id: link.id, service_id: serviceId, clicked_at: at, referer_host: "chatgpt.com" });
    await addClick(sql, { link_id: link.id, service_id: serviceId, clicked_at: at, referer_host: "www.perplexity.ai" });
    await addClick(sql, { link_id: link.id, service_id: serviceId, clicked_at: at, referer_host: "t.me" });

    const cookie = await adminSession(app, mail);
    const res = await adminGet(app, "/admin/ai", cookie);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain(">Claude<");
    expect(html).toContain(">create_link<");
    expect(html).toContain(">chatgpt.com<");
    expect(html).toContain(">www.perplexity.ai<");
    expect(html).not.toContain(">t.me<");
  });

  test("with nothing yet, the page still renders", async () => {
    const cookie = await adminSession(app, mail);
    expect((await adminGet(app, "/admin/ai", cookie)).status).toBe(200);
  });

  test("needs the admin session", async () => {
    expect((await adminGet(app, "/admin/ai", "")).headers.get("location")).toBe("/admin/login");
  });
});
