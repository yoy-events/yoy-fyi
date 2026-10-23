import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { createApp } from "../src/app";
import { createLink, createService, reset, testDb } from "./helpers";

let sql: SQL;
let app: ReturnType<typeof createApp>;
let serviceId: string;

beforeAll(async () => {
  sql = await testDb();
  app = createApp({ sql, publicOrigin: "https://yoy.fyi" });
});

beforeEach(async () => {
  await reset(sql);
  serviceId = await createService(sql);
});

const get = (path: string, headers: Record<string, string> = {}) =>
  app.request(`https://yoy.fyi${path}`, { headers });

describe("GET /{code}", () => {
  test("redirects an active link with 302 and no caching", async () => {
    await createLink(sql, serviceId, { code: "abc", target_url: "https://example.com/page" });

    const res = await get("/abc");

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://example.com/page");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("codes are case-sensitive", async () => {
    await createLink(sql, serviceId, { code: "Abc", target_url: "https://example.com/" });

    expect((await get("/abc")).status).toBe(404);
  });

  test("unknown code returns a 404 HTML page", async () => {
    const res = await get("/nope");

    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  test("a path outside the code alphabet returns 404 without a lookup", async () => {
    expect((await get("/a.b")).status).toBe(404);
    expect((await get("/a/b")).status).toBe(404);
  });

  test("disabled link returns 410", async () => {
    await createLink(sql, serviceId, { code: "off", target_url: "https://example.com/", disabled_at: new Date() });

    const res = await get("/off");

    expect(res.status).toBe(410);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  test("expired link returns 410", async () => {
    await createLink(sql, serviceId, {
      code: "old",
      target_url: "https://example.com/",
      expires_at: new Date(Date.now() - 1000),
    });

    expect((await get("/old")).status).toBe(410);
  });

  test("a link expiring in the future still redirects", async () => {
    await createLink(sql, serviceId, {
      code: "soon",
      target_url: "https://example.com/",
      expires_at: new Date(Date.now() + 60_000),
    });

    expect((await get("/soon")).status).toBe(302);
  });
});

test("GET /health is not treated as a code", async () => {
  await createLink(sql, serviceId, { code: "health", target_url: "https://example.com/" });

  const res = await get("/health");

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});
