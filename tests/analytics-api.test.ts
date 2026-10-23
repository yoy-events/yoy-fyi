import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { createApp } from "../src/app";
import { issueKey } from "../src/keys";
import { rollupDays } from "../src/rollup";
import { addClick, createLink, reset, testDb } from "./helpers";

let sql: SQL;
let app: ReturnType<typeof createApp>;
let token: string;
let serviceId: string;
let fall: string; // tagged "fall"
let plain: string;
let foreign: string;

beforeAll(async () => {
  sql = await testDb();
  app = createApp({ sql, publicOrigin: "https://yoy.fyi", countryOf: () => null });
});

beforeEach(async () => {
  await reset(sql);
  const issued = await issueKey(sql, { serviceSlug: "yoy", name: "a", scopes: ["analytics:read"] });
  token = issued.token;
  [{ id: serviceId }] = await sql`select id from services where slug = 'yoy'`;
  fall = await createLink(sql, serviceId, { code: "fall", target_url: "https://example.com/" });
  await sql`update links set tags = '{fall}' where id = ${fall}`;
  plain = await createLink(sql, serviceId, { code: "plain", target_url: "https://example.com/" });
  await issueKey(sql, { serviceSlug: "other", name: "o", scopes: ["analytics:read"] });
  const [{ id: otherId }] = await sql`select id from services where slug = 'other'`;
  foreign = await createLink(sql, otherId, { code: "foreign", target_url: "https://example.com/" });
});

const click = (link: string, clicked_at: string, extra: Record<string, unknown> = {}) =>
  sql`select service_id from links where id = ${link}`.then(([l]: { service_id: string }[]) =>
    addClick(sql, { link_id: link, service_id: l!.service_id, clicked_at, ...extra }),
  );

const get = (path: string, key = token) =>
  app.request(`https://yoy.fyi${path}`, { headers: { authorization: `Bearer ${key}` } });

const series = async (query: string) => {
  const res = await get(`/v1/analytics/timeseries?${query}`);
  expect(res.status).toBe(200);
  return res.json();
};

describe("GET /v1/analytics/timeseries", () => {
  beforeEach(async () => {
    await click(fall, "2026-03-10T09:05:00Z", { visitor_hash: "a" });
    await click(fall, "2026-03-10T09:40:00Z", { visitor_hash: "a" });
    await click(fall, "2026-03-10T11:10:00Z", { visitor_hash: "b" });
    await click(fall, "2026-03-10T11:20:00Z", { visitor_hash: "bot", is_bot: true });
    await click(fall, "2026-03-11T08:00:00Z", { visitor_hash: "a" });
    await click(plain, "2026-03-10T09:15:00Z", { visitor_hash: "c" });
    await click(foreign, "2026-03-10T09:15:00Z", { visitor_hash: "d" });
    await rollupDays(sql, "2026-03-10", "2026-03-11");
  });

  test("hourly buckets for one link, zero-filled, rounded out to whole hours, bots excluded", async () => {
    const body = await series(`link_id=${fall}&interval=hour&from=2026-03-10T08:30:00Z&to=2026-03-10T11:30:00Z`);

    expect(body).toEqual({
      interval: "hour",
      from: "2026-03-10T08:00:00.000Z",
      to: "2026-03-10T12:00:00.000Z",
      bots: "exclude",
      totals: { clicks: 3, uniques_upper_bound: 2, bot_clicks: 1 },
      points: [
        { t: "2026-03-10T08:00:00.000Z", clicks: 0, uniques: 0 },
        { t: "2026-03-10T09:00:00.000Z", clicks: 2, uniques: 1 },
        { t: "2026-03-10T10:00:00.000Z", clicks: 0, uniques: 0 },
        { t: "2026-03-10T11:00:00.000Z", clicks: 1, uniques: 1 },
      ],
    });
  });

  test("bots=include adds bot clicks and bots=only shows just them", async () => {
    const range = `link_id=${fall}&interval=hour&from=2026-03-10T11:00:00Z&to=2026-03-10T12:00:00Z`;

    const include = await series(`${range}&bots=include`);
    const only = await series(`${range}&bots=only`);

    expect(include.points[0].clicks).toBe(2);
    expect(only.points[0].clicks).toBe(1);
    expect(only.totals.bot_clicks).toBe(1);
  });

  test("daily buckets; uniques across days are a sum of daily uniques", async () => {
    const body = await series(`link_id=${fall}&interval=day&from=2026-03-10T00:00:00Z&to=2026-03-12T00:00:00Z`);

    expect(body.points).toEqual([
      { t: "2026-03-10T00:00:00.000Z", clicks: 3, uniques: 2 },
      { t: "2026-03-11T00:00:00.000Z", clicks: 1, uniques: 1 },
    ]);
    expect(body.totals).toEqual({ clicks: 4, uniques_upper_bound: 3, bot_clicks: 1 });
  });

  test("without link_id it covers the whole service and nothing else", async () => {
    const body = await series("interval=day&from=2026-03-10T00:00:00Z&to=2026-03-11T00:00:00Z");

    expect(body.totals.clicks).toBe(4);
  });

  test("tag narrows to tagged links", async () => {
    const body = await series("tag=fall&interval=day&from=2026-03-10T00:00:00Z&to=2026-03-11T00:00:00Z");

    expect(body.totals.clicks).toBe(3);
  });

  test("another service's link_id is 404; a malformed one is 400", async () => {
    const range = "interval=day&from=2026-03-10T00:00:00Z&to=2026-03-11T00:00:00Z";

    expect((await get(`/v1/analytics/timeseries?link_id=${foreign}&${range}`)).status).toBe(404);
    expect((await get(`/v1/analytics/timeseries?link_id=nope&${range}`)).status).toBe(400);
  });

  test.each([
    "interval=day&to=2026-03-11T00:00:00Z",
    "interval=week&from=2026-03-10T00:00:00Z&to=2026-03-11T00:00:00Z",
    "from=2026-03-10T00:00:00Z&to=2026-03-11T00:00:00Z",
    "interval=day&from=2026-03-11T00:00:00Z&to=2026-03-10T00:00:00Z",
    "interval=day&from=2026-03-10&to=2026-03-11T00:00:00Z",
    "interval=day&bots=maybe&from=2026-03-10T00:00:00Z&to=2026-03-11T00:00:00Z",
  ])("rejects %s with 400", async (query) => {
    const res = await get(`/v1/analytics/timeseries?${query}`);

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_request");
  });

  test.each([
    "interval=hour&from=2026-01-01T00:00:00Z&to=2026-02-01T01:00:00Z",
    "interval=day&from=2025-01-01T00:00:00Z&to=2026-02-06T00:00:00Z",
  ])("rejects an oversized range %s with 422", async (query) => {
    const res = await get(`/v1/analytics/timeseries?${query}`);

    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("range_too_large");
  });

  test("requires analytics:read", async () => {
    const { token: links } = await issueKey(sql, { serviceSlug: "yoy", name: "l", scopes: ["links:read"] });

    const res = await get("/v1/analytics/timeseries?interval=day&from=2026-03-10T00:00:00Z&to=2026-03-11T00:00:00Z", links);

    expect(res.status).toBe(403);
  });
});

describe("GET /v1/analytics/breakdown", () => {
  beforeEach(async () => {
    await click(fall, "2026-03-10T09:00:00Z", { referer_host: "t.co", country: "UA" });
    await click(fall, "2026-03-10T10:00:00Z", { referer_host: "t.co", country: "UA" });
    await click(fall, "2026-03-11T10:00:00Z", { referer_host: "google.com", country: "PL" });
    await click(fall, "2026-03-11T11:00:00Z", { country: "UA" });
    await click(fall, "2026-03-11T12:00:00Z", { referer_host: "t.co", is_bot: true });
    await click(plain, "2026-03-11T12:00:00Z", { referer_host: "x.com" });
    await rollupDays(sql, "2026-03-10", "2026-03-11");
  });

  const breakdown = async (query: string) => {
    const res = await get(`/v1/analytics/breakdown?${query}`);
    expect(res.status).toBe(200);
    return res.json();
  };

  test("groups clicks by a dimension, highest first, rounded out to whole days", async () => {
    const body = await breakdown(
      `link_id=${fall}&dimension=referer_host&from=2026-03-10T05:00:00Z&to=2026-03-11T23:00:00Z`,
    );

    expect(body).toEqual({
      dimension: "referer_host",
      from: "2026-03-10T00:00:00.000Z",
      to: "2026-03-12T00:00:00.000Z",
      bots: "exclude",
      total_clicks: 4,
      other_clicks: 0,
      items: [
        { value: "t.co", clicks: 2 },
        { value: "google.com", clicks: 1 },
        { value: null, clicks: 1 },
      ],
    });
  });

  test("limit keeps the top values and sums the rest into other_clicks", async () => {
    const body = await breakdown(`link_id=${fall}&dimension=country&limit=1&from=2026-03-10T00:00:00Z&to=2026-03-12T00:00:00Z`);

    expect(body.items).toEqual([{ value: "UA", clicks: 3 }]);
    expect(body.other_clicks).toBe(1);
    expect(body.total_clicks).toBe(4);
  });

  test("covers the whole service by default and respects bots", async () => {
    const all = await breakdown("dimension=referer_host&bots=include&from=2026-03-10T00:00:00Z&to=2026-03-12T00:00:00Z");

    expect(all.total_clicks).toBe(6);
    expect(all.items[0]).toEqual({ value: "t.co", clicks: 3 });
  });

  test.each([
    "from=2026-03-10T00:00:00Z&to=2026-03-12T00:00:00Z",
    "dimension=ip&from=2026-03-10T00:00:00Z&to=2026-03-12T00:00:00Z",
    "dimension=country&limit=0&from=2026-03-10T00:00:00Z&to=2026-03-12T00:00:00Z",
    "dimension=country&limit=101&from=2026-03-10T00:00:00Z&to=2026-03-12T00:00:00Z",
  ])("rejects %s with 400", async (query) => {
    expect((await get(`/v1/analytics/breakdown?${query}`)).status).toBe(400);
  });

  test("rejects more than 400 days with 422", async () => {
    const res = await get("/v1/analytics/breakdown?dimension=country&from=2025-01-01T00:00:00Z&to=2026-02-06T00:00:00Z");

    expect(res.status).toBe(422);
  });
});
