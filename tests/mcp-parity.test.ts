// MCP tools that match the website: search, QR codes, several links at once, the bio page, and
// server instructions. Valid, invalid and empty input.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { createApp } from "../src/app";
import { issueKey } from "../src/keys";
import { upsertGoogleUser } from "../src/users";
import { reset, testAdmin, testDb } from "./helpers";

const ORIGIN = "https://yoy.fyi";
let sql: SQL;
let app: ReturnType<typeof createApp>;
let key: string; // a personal account's key
let serviceKey: string; // a key of a plain service with no owner

beforeAll(async () => {
  sql = await testDb();
});

beforeEach(async () => {
  await reset(sql);
  app = createApp({ sql, publicOrigin: ORIGIN, countryOf: () => null, resolveHost: async () => ["93.184.215.14"], admin: testAdmin().admin });
  const user = await upsertGoogleUser(sql, { sub: "g1", email: "ann@example.com", name: "Ann" }, new Date());
  const [service] = await sql`select slug from services where owner_user_id = ${user!.id}`;
  ({ token: key } = await issueKey(sql, { serviceSlug: service.slug, name: "k", scopes: ["links:read", "links:write"] }));
  ({ token: serviceKey } = await issueKey(sql, { serviceSlug: "yoy", name: "k", scopes: ["links:read", "links:write"] }));
});

const rpc = async (method: string, params?: unknown, bearer = key) =>
  (
    await app.request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
    })
  ).json();
const tool = async (name: string, args: Record<string, unknown> = {}, bearer = key) => (await rpc("tools/call", { name, arguments: args }, bearer)).result;
const v1 = (path: string) => app.request(`${ORIGIN}/v1${path}`, { headers: { authorization: `Bearer ${key}` } });
const make = (target_url: string, extra: Record<string, unknown> = {}) => tool("create_link", { target_url, ...extra });

describe("search", () => {
  beforeEach(async () => {
    await make("https://lviv.example/concert", { code: "lviv", title: "Lviv concert" });
    await make("https://kyiv.example/talk", { code: "kyiv" });
    await make("https://example.com/100%_off", { code: "sale" });
  });
  const codes = async (q: string) => (await (await v1(`/links?q=${encodeURIComponent(q)}`)).json()).data.map((l: { code: string }) => l.code);

  test.each([
    ["the title", "concert", ["lviv"]],
    ["the code, ignoring case", "KYIV", ["kyiv"]],
    ["the target", "kyiv.example", ["kyiv"]],
    ["LIKE wildcards literally", "100%_", ["sale"]],
    ["nothing", "nope", []],
    ["empty means everything", "", ["sale", "kyiv", "lviv"]],
  ])("GET /v1/links?q matches %s", async (_, q, expected) => {
    expect(await codes(q)).toEqual(expected);
  });

  test("a q over 200 characters is 400", async () => {
    expect((await v1(`/links?q=${"a".repeat(201)}`)).status).toBe(400);
  });

  test("list_links takes q", async () => {
    const result = await tool("list_links", { q: "concert" });
    expect(result.structuredContent.data.map((l: { code: string }) => l.code)).toEqual(["lviv"]);
  });
});

describe("get_qr", () => {
  let id: string;
  beforeEach(async () => {
    id = (await make("https://example.com/qr", { code: "qr1" })).structuredContent.id;
  });

  test("returns the QR as a PNG image and the short URL", async () => {
    const result = await tool("get_qr", { id, fg: "#112233", bg: "#ffeecc" });
    const image = result.content.find((c: { type: string }) => c.type === "image");
    expect(image.mimeType).toBe("image/png");
    expect(Buffer.from(image.data, "base64").subarray(1, 4).toString()).toBe("PNG");
    expect(JSON.stringify(result.content)).toContain(`${ORIGIN}/qr1`);
  });

  test.each([
    ["no id", {}],
    ["an unknown id", { id: "00000000-0000-0000-0000-000000000000" }],
    ["a bad colour", { fg: "red" }],
    ["too little contrast", { fg: "#eeeeee" }],
    ["a caption (SVG only)", { caption: "Scan me" }],
  ])("%s is a tool error", async (_, args) => {
    expect((await tool("get_qr", { id, ...args, ...(_ === "no id" ? { id: undefined } : {}) })).isError).toBe(true);
  });
});

describe("create_links", () => {
  test("creates each valid link and reports each failure by position", async () => {
    const result = await tool("create_links", {
      links: [{ target_url: "https://example.com/a", code: "aa" }, { target_url: "ftp://bad" }, { target_url: "https://example.com/c" }],
    });
    const items = result.structuredContent.results;
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ index: 0, ok: true, link: { code: "aa" } });
    expect(items[1]).toMatchObject({ index: 1, ok: false });
    expect(items[1].error).toContain("target_rejected");
    expect(items[2]).toMatchObject({ index: 2, ok: true });
    expect(await sql`select 1 from links`).toHaveLength(2);
  });

  test.each([
    ["an empty list", []],
    ["more than 20 links", Array.from({ length: 21 }, (_, i) => ({ target_url: `https://example.com/${i}` }))],
    ["not a list", "https://example.com/"],
  ])("%s is a tool error and creates nothing", async (_, links) => {
    expect((await tool("create_links", { links })).isError).toBe(true);
    expect(await sql`select 1 from links`).toHaveLength(0);
  });
});

describe("bio page tools", () => {
  test("get_bio is empty at first; update_bio publishes; get_bio returns it", async () => {
    expect((await tool("get_bio")).structuredContent).toEqual({ page: null });
    const { id } = (await make("https://example.com/gig", { code: "gig", title: "Concert" })).structuredContent;
    const saved = await tool("update_bio", { handle: "ann", title: "Ann's links", link_ids: [id] });
    expect(saved.isError).toBeFalsy();
    expect(saved.structuredContent.page).toMatchObject({ handle: "ann", url: `${ORIGIN}/@ann`, link_ids: [id] });
    expect(await (await app.request(`${ORIGIN}/@ann`)).text()).toContain('href="https://yoy.fyi/gig"');
    expect((await tool("get_bio")).structuredContent.page.handle).toBe("ann");
  });

  test.each([
    ["a bad handle", { handle: "a b" }],
    ["an empty handle", { handle: "" }],
    ["a reserved handle", { handle: "admin" }],
    ["an unknown link", { handle: "ann", link_ids: ["00000000-0000-0000-0000-000000000000"] }],
    ["link_ids that is not a list", { handle: "ann", link_ids: "x" }],
  ])("%s is a tool error", async (_, args) => {
    expect((await tool("update_bio", args)).isError).toBe(true);
  });

  test("a service without a personal account has no bio page", async () => {
    expect((await tool("get_bio", {}, serviceKey)).isError).toBe(true);
    expect((await tool("update_bio", { handle: "svc" }, serviceKey)).isError).toBe(true);
  });
});

test("initialize carries instructions for the model", async () => {
  const { result } = await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  expect(result.instructions).toContain("create_link");
  expect(result.instructions).toContain("get_qr");
});
