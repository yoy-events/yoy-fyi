import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { rollupDays, rollupRecent } from "../src/rollup";
import { addClick, createLink, createService, reset, testDb } from "./helpers";

let sql: SQL;
let serviceId: string;
let linkId: string;

beforeAll(async () => {
  sql = await testDb();
});

beforeEach(async () => {
  await reset(sql);
  serviceId = await createService(sql);
  linkId = await createLink(sql, serviceId, { code: "r", target_url: "https://example.com/" });
});

const click = (clicked_at: string, extra: Record<string, unknown> = {}) =>
  addClick(sql, { link_id: linkId, service_id: serviceId, clicked_at, ...extra });

const hourly = () =>
  sql`select to_char(bucket at time zone 'UTC', 'YYYY-MM-DD"T"HH24') as hour, is_bot, clicks, uniques
      from link_stats_hourly order by bucket, is_bot`;
const daily = () =>
  sql`select to_char(bucket at time zone 'UTC', 'YYYY-MM-DD') as day, is_bot, clicks, uniques
      from link_stats_daily order by bucket, is_bot`;

describe("rollupDays", () => {
  test("aggregates clicks per hour and per day, with uniques and bots apart", async () => {
    await click("2026-03-10T09:05:00Z", { visitor_hash: "a" });
    await click("2026-03-10T09:40:00Z", { visitor_hash: "a" });
    await click("2026-03-10T10:10:00Z", { visitor_hash: "a" });
    await click("2026-03-10T10:20:00Z", { visitor_hash: "b" });
    await click("2026-03-10T10:30:00Z", { visitor_hash: "c", is_bot: true });

    await rollupDays(sql, "2026-03-10", "2026-03-10");

    expect(await hourly()).toEqual([
      { hour: "2026-03-10T09", is_bot: false, clicks: 2, uniques: 1 },
      { hour: "2026-03-10T10", is_bot: false, clicks: 2, uniques: 2 },
      { hour: "2026-03-10T10", is_bot: true, clicks: 1, uniques: 1 },
    ]);
    expect(await daily()).toEqual([
      { day: "2026-03-10", is_bot: false, clicks: 4, uniques: 2 },
      { day: "2026-03-10", is_bot: true, clicks: 1, uniques: 1 },
    ]);
  });

  test("buckets by UTC day", async () => {
    await click("2026-03-10T23:59:59Z");
    await click("2026-03-11T00:00:00Z");

    await rollupDays(sql, "2026-03-10", "2026-03-11");

    expect((await daily()).map((r: { day: string }) => r.day)).toEqual(["2026-03-10", "2026-03-11"]);
  });

  test("breaks each day down by every dimension, keeping nulls", async () => {
    await click("2026-03-10T09:00:00Z", {
      referer_host: "t.co",
      country: "UA",
      ua_device: "mobile",
      ua_browser: "Safari",
      ua_os: "iOS",
      utm_source: "ig",
      utm_medium: "story",
      utm_campaign: "fall",
    });
    await click("2026-03-10T10:00:00Z", { country: "UA" });

    await rollupDays(sql, "2026-03-10", "2026-03-10");

    const rows = await sql`select dim, value, clicks from link_dims_daily where not is_bot order by dim, value nulls last`;
    expect(rows).toEqual([
      { dim: "browser", value: "Safari", clicks: 1 },
      { dim: "browser", value: null, clicks: 1 },
      { dim: "country", value: "UA", clicks: 2 },
      { dim: "device", value: "mobile", clicks: 1 },
      { dim: "device", value: null, clicks: 1 },
      { dim: "os", value: "iOS", clicks: 1 },
      { dim: "os", value: null, clicks: 1 },
      { dim: "referer_host", value: "t.co", clicks: 1 },
      { dim: "referer_host", value: null, clicks: 1 },
      { dim: "utm_campaign", value: "fall", clicks: 1 },
      { dim: "utm_campaign", value: null, clicks: 1 },
      { dim: "utm_medium", value: "story", clicks: 1 },
      { dim: "utm_medium", value: null, clicks: 1 },
      { dim: "utm_source", value: "ig", clicks: 1 },
      { dim: "utm_source", value: null, clicks: 1 },
    ]);
  });

  test("recomputing a day replaces its rows instead of adding to them", async () => {
    await click("2026-03-10T09:00:00Z");
    await rollupDays(sql, "2026-03-10", "2026-03-10");
    await click("2026-03-10T09:30:00Z");

    await rollupDays(sql, "2026-03-10", "2026-03-10");

    expect(await daily()).toEqual([{ day: "2026-03-10", is_bot: false, clicks: 2, uniques: 0 }]);
  });

  test("leaves days outside the range alone", async () => {
    await click("2026-03-09T09:00:00Z");
    await rollupDays(sql, "2026-03-09", "2026-03-09");
    await click("2026-03-09T10:00:00Z");

    await rollupDays(sql, "2026-03-10", "2026-03-10");

    expect(await daily()).toEqual([{ day: "2026-03-09", is_bot: false, clicks: 1, uniques: 0 }]);
  });
});

test("rollupRecent recomputes yesterday and today in UTC", async () => {
  await click("2026-03-08T12:00:00Z");
  await click("2026-03-09T12:00:00Z");
  await click("2026-03-10T00:30:00Z");

  await rollupRecent(sql, new Date("2026-03-10T01:00:00Z"));

  expect((await daily()).map((r: { day: string }) => r.day)).toEqual(["2026-03-09", "2026-03-10"]);
});
