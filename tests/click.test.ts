import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { type AppDeps, createApp } from "../src/app";
import { createLink, createService, reset, testDb } from "./helpers";

const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const TELEGRAM_BOT = "TelegramBot (like TwitterBot)";
const IP = "203.0.113.7";

let sql: SQL;
let serviceId: string;
let linkId: string;

beforeAll(async () => {
  sql = await testDb();
});

beforeEach(async () => {
  await reset(sql);
  serviceId = await createService(sql);
  linkId = await createLink(sql, serviceId, { code: "go", target_url: "https://example.com/" });
});

const appWith = (deps: Partial<AppDeps> = {}) =>
  createApp({ sql, publicOrigin: "https://yoy.fyi", countryOf: () => null, ...deps });

// `ip` stands in for the address the server resolves; every other entry is a request header.
const hit = (path: string, { ip = IP, ...headers }: Record<string, string> = {}, deps: Partial<AppDeps> = {}, method = "GET") =>
  appWith(deps).request(`https://yoy.fyi${path}`, { method, headers: { "user-agent": IPHONE_SAFARI, ...headers } }, { ip });

const clicks = () => sql`select * from clicks order by clicked_at`;

describe("click capture", () => {
  test("records one click with link, service, referer and parsed user agent", async () => {
    const res = await hit("/go", { referer: "https://t.co/xyz?a=1" });

    expect(res.status).toBe(302);
    const [click, ...rest] = await clicks();
    expect(rest).toHaveLength(0);
    expect(click).toMatchObject({
      link_id: linkId,
      service_id: serviceId,
      referer: "https://t.co/xyz?a=1",
      referer_host: "t.co",
      ua_device: "mobile",
      ua_browser: "Safari",
      ua_os: "iOS",
      is_bot: false,
      bot_name: null,
    });
  });

  test("captures UTM and ad click params from the short-link query", async () => {
    await hit("/go?utm_source=ig&utm_medium=story&utm_campaign=fall&utm_term=t&utm_content=c&fbclid=F&gclid=G&fbc=FC&fbp=FP");

    const [click] = await clicks();
    expect(click).toMatchObject({
      utm_source: "ig",
      utm_medium: "story",
      utm_campaign: "fall",
      utm_term: "t",
      utm_content: "c",
      fbclid: "F",
      gclid: "G",
      fbc: "FC",
      fbp: "FP",
    });
  });

  test("flags link-preview crawlers as bots instead of dropping them", async () => {
    const res = await hit("/go", { "user-agent": TELEGRAM_BOT });

    expect(res.status).toBe(302);
    const [click] = await clicks();
    expect(click.is_bot).toBe(true);
    expect(click.bot_name).toBeTruthy();
    expect(click.ua_device).toBe("bot");
  });

  test("stores the country from the client IP lookup, never the IP itself", async () => {
    let lookedUp = "";
    await hit("/go", {}, {
      countryOf: (ip) => {
        lookedUp = ip;
        return "UA";
      },
    });

    const [click] = await clicks();
    expect(lookedUp).toBe(IP);
    expect(click.country).toBe("UA");
    expect(click.visitor_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(click)).not.toContain(IP);
  });

  test("the visitor hash is stable within a day and differs between visitors", async () => {
    await hit("/go");
    await hit("/go");
    await hit("/go", { ip: "198.51.100.9" });

    const hashes = (await clicks()).map((c: { visitor_hash: string }) => c.visitor_hash);
    expect(hashes[0]).toBe(hashes[1]);
    expect(hashes[2]).not.toBe(hashes[0]);
  });

  test("the same visitor gets a different hash on the next UTC day", async () => {
    const day1 = new Date("2026-10-23T23:59:00Z");
    const day2 = new Date("2026-10-24T00:01:00Z");
    // Two separate apps share no in-memory salt cache, so the salt must come from the table.
    await hit("/go", {}, { now: () => day1 });
    await hit("/go", {}, { now: () => day1 });
    await hit("/go", {}, { now: () => day2 });

    const hashes = (await clicks()).map((c: { visitor_hash: string }) => c.visitor_hash);
    expect(hashes[0]).toBe(hashes[1]);
    expect(hashes[2]).not.toBe(hashes[0]);
  });

  test("salts older than yesterday are deleted when a new day starts", async () => {
    await hit("/go", {}, { now: () => new Date("2026-10-20T12:00:00Z") });
    await hit("/go", {}, { now: () => new Date("2026-10-21T12:00:00Z") });
    await hit("/go", {}, { now: () => new Date("2026-10-23T12:00:00Z") });

    const days = await sql`select to_char(day, 'YYYY-MM-DD') as day from daily_salts order by day`;
    expect(days.map((d: { day: string }) => d.day)).toEqual(["2026-10-23"]);
  });

  test("HEAD requests redirect without recording a click", async () => {
    const res = await hit("/go", {}, {}, "HEAD");

    expect(res.status).toBe(302);
    expect(await clicks()).toHaveLength(0);
  });

  test("a failed click insert still redirects", async () => {
    const res = await hit("/go", {}, {
      recordClick: async () => {
        throw new Error("db down");
      },
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://example.com/");
  });

  test("404 and 410 record nothing", async () => {
    await createLink(sql, serviceId, { code: "off", target_url: "https://example.com/", disabled_at: new Date() });

    await hit("/nope");
    await hit("/off");

    expect(await clicks()).toHaveLength(0);
  });
});

describe("target building on redirect", () => {
  test("merges UTM defaults and forwards visitor params", async () => {
    await createLink(sql, serviceId, {
      code: "utm",
      target_url: "https://example.com/?utm_source=site",
      utm_defaults: { utm_source: "ig", utm_medium: "bio" },
    });

    const res = await hit("/utm?fbclid=F");

    const params = new URL(res.headers.get("location")!).searchParams;
    expect(params.get("utm_source")).toBe("site");
    expect(params.get("utm_medium")).toBe("bio");
    expect(params.get("fbclid")).toBe("F");
  });

  test("passes the click id as yoy_sid when the link asks for it", async () => {
    await createLink(sql, serviceId, { code: "sid", target_url: "https://example.com/", pass_click_id: true });

    const res = await hit("/sid");

    const sid = new URL(res.headers.get("location")!).searchParams.get("yoy_sid");
    const [click] = await clicks();
    expect(sid).toBe(click.id);
  });

  test("does not add yoy_sid otherwise", async () => {
    const res = await hit("/go");

    expect(res.headers.get("location")).toBe("https://example.com/");
  });
});
