// Google Safe Browsing: unsafe targets are refused at create and update, and a daily rescan
// disables active links whose target turned unsafe later.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { createApp } from "../src/app";
import { issueKey } from "../src/keys";
import { type UnsafeUrls, rescanLinks, safeBrowsing } from "../src/safe-browsing";
import { createLink, reset, testDb } from "./helpers";

const BAD = "https://phish.example/login";
const GOOD = "https://example.com/page";

let sql: SQL;
let token: string;
let serviceId: string;
let flagged: Set<string>;
let asked: string[][];

const unsafeUrls: UnsafeUrls = async (urls) => {
  asked.push(urls);
  return new Set(urls.filter((u) => flagged.has(u)));
};
const appWith = (check: UnsafeUrls | null = unsafeUrls) =>
  createApp({ sql, publicOrigin: "https://yoy.fyi", countryOf: () => null, resolveHost: async () => ["93.184.215.14"], unsafeUrls: check ?? undefined });

beforeAll(async () => {
  sql = await testDb();
});

beforeEach(async () => {
  await reset(sql);
  flagged = new Set([BAD]);
  asked = [];
  ({ token } = await issueKey(sql, { serviceSlug: "yoy", name: "k", scopes: ["links:write", "links:read"] }));
  serviceId = (await sql`select id from services where slug = 'yoy'`)[0].id;
});

const call = (app: ReturnType<typeof createApp>, method: string, path: string, body: unknown) =>
  app.request(`https://yoy.fyi${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("create and update", () => {
  test("an unsafe target is refused with target_rejected / unsafe", async () => {
    const res = await call(appWith(), "POST", "/v1/links", { target_url: BAD });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatchObject({ code: "target_rejected", details: { reason: "unsafe" } });
    expect(await sql`select 1 from links`).toHaveLength(0);
  });

  test("a safe target is created", async () => {
    expect((await call(appWith(), "POST", "/v1/links", { target_url: GOOD })).status).toBe(201);
    expect(asked).toEqual([[GOOD]]);
  });

  test("changing the target to an unsafe one is refused; a safe one is accepted", async () => {
    const app = appWith();
    const { id } = await (await call(app, "POST", "/v1/links", { target_url: GOOD })).json();
    const bad = await call(app, "PATCH", `/v1/links/${id}`, { target_url: BAD });
    expect(bad.status).toBe(422);
    expect((await bad.json()).error.details.reason).toBe("unsafe");
    expect((await call(app, "PATCH", `/v1/links/${id}`, { target_url: "https://example.org/" })).status).toBe(200);
  });

  test("without a Safe Browsing key, links are created unchecked", async () => {
    expect((await call(appWith(null), "POST", "/v1/links", { target_url: BAD })).status).toBe(201);
  });
});

describe("rescanLinks", () => {
  test("disables active links with unsafe targets, leaves safe, disabled and expired ones alone", async () => {
    const bad = await createLink(sql, serviceId, { code: "bad", target_url: BAD });
    const good = await createLink(sql, serviceId, { code: "good", target_url: GOOD });
    await createLink(sql, serviceId, { code: "off", target_url: "https://off.example/", disabled_at: new Date() });
    await createLink(sql, serviceId, { code: "old", target_url: "https://old.example/", expires_at: new Date(Date.now() - 1000) });

    expect(await rescanLinks(sql, unsafeUrls, new Date())).toBe(1);

    expect(asked.flat().sort()).toEqual([GOOD, BAD].sort());
    const rows = await sql`select id, disabled_at, disabled_by from links where id in (${bad}, ${good}) order by code`;
    expect(rows.find((r: { id: string }) => r.id === bad).disabled_at).not.toBeNull();
    expect(rows.find((r: { id: string }) => r.id === bad).disabled_by).toBe("safe_browsing");
    expect(rows.find((r: { id: string }) => r.id === good).disabled_at).toBeNull();
  });

  test("an unsafe link its owner disabled becomes a Safe Browsing takedown", async () => {
    const bad = await createLink(sql, serviceId, { code: "bad", target_url: BAD, disabled_at: new Date() });
    await sql`update links set disabled_by = 'owner' where id = ${bad}`;
    expect(await rescanLinks(sql, unsafeUrls, new Date())).toBe(1);
    expect((await sql`select disabled_by from links where id = ${bad}`)[0].disabled_by).toBe("safe_browsing");
  });

  test("an unsafe preview image takes the link down too, even with a safe target", async () => {
    const id = await createLink(sql, serviceId, { code: "pic", target_url: GOOD });
    await sql`update links set preview = ${{ title: "T", image: BAD }} where id = ${id}`;
    expect(await rescanLinks(sql, unsafeUrls, new Date())).toBe(1);
    expect(asked.flat()).toContain(BAD);
    expect((await sql`select disabled_by from links where id = ${id}`)[0].disabled_by).toBe("safe_browsing");
  });

  test("with no links, asks nothing", async () => {
    expect(await rescanLinks(sql, unsafeUrls, new Date())).toBe(0);
    expect(asked).toEqual([]);
  });
});

describe("safeBrowsing client", () => {
  type Sent = { url: string; body: { threatInfo: { threatEntries: { url: string }[] } } };
  const client = (reply: (sent: Sent) => Response | Promise<Response>, sent: Sent[] = []) =>
    safeBrowsing("KEY", async (url, init) => {
      const one = { url: String(url), body: JSON.parse(String(init?.body)) };
      sent.push(one);
      return reply(one);
    });

  test("asks the v4 Lookup API with the key and returns the matched URLs", async () => {
    const sent: Sent[] = [];
    const check = client(() => Response.json({ matches: [{ threat: { url: BAD } }] }), sent);
    expect(await check([GOOD, BAD])).toEqual(new Set([BAD]));
    expect(sent[0]!.url).toBe("https://safebrowsing.googleapis.com/v4/threatMatches:find?key=KEY");
    expect(sent[0]!.body.threatInfo.threatEntries).toEqual([{ url: GOOD }, { url: BAD }]);
  });

  test("an empty answer means nothing matched", async () => {
    expect(await client(() => Response.json({}))([GOOD])).toEqual(new Set());
  });

  test("an empty list sends no request", async () => {
    const sent: Sent[] = [];
    expect(await client(() => Response.json({}), sent)([])).toEqual(new Set());
    expect(sent).toHaveLength(0);
  });

  test("splits more than 500 URLs into several requests", async () => {
    const sent: Sent[] = [];
    await client(() => Response.json({}), sent)(Array.from({ length: 501 }, (_, i) => `https://e.example/${i}`));
    expect(sent.map((s) => s.body.threatInfo.threatEntries.length)).toEqual([500, 1]);
  });

  test("an API error fails open: nothing is flagged", async () => {
    expect(await client(() => new Response("quota", { status: 429 }))([BAD])).toEqual(new Set());
    expect(await client(() => Promise.reject(new Error("down")))([BAD])).toEqual(new Set());
  });
});
