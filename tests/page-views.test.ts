// Counting visits to public pages: sources, crawlers, and what is never counted.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { createApp } from "../src/app";
import { crawlerName, sourceOf } from "../src/page-views";
import { adminGet, adminSession } from "./admin-helpers";
import { reset, testAdmin, testDb } from "./helpers";

const ORIGIN = "https://yoy.fyi";
let sql: SQL;
let app: ReturnType<typeof createApp>;
let mail: ReturnType<typeof testAdmin>;

beforeAll(async () => {
  sql = await testDb();
});
beforeEach(async () => {
  await reset(sql);
  mail = testAdmin();
  app = createApp({ sql, publicOrigin: ORIGIN, countryOf: () => null, admin: mail.admin });
});

const visit = (path: string, headers: Record<string, string> = {}) => app.request(`${ORIGIN}${path}`, { headers });
const views = () => sql`select path, referer_host, source, bot_name from page_views order by id`;
const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

describe("classification", () => {
  test.each([
    [null, "direct"],
    ["chatgpt.com", "ai_chat"],
    ["www.perplexity.ai", "ai_chat"],
    ["www.google.com.ua", "search"],
    ["duckduckgo.com", "search"],
    ["t.me", "social"],
    ["l.instagram.com", "social"],
    ["yoy.fyi", "internal"],
    ["example.org", "other"],
  ])("%p is %s", (host, source) => {
    expect(sourceOf(host, "yoy.fyi")).toBe(source);
  });

  test.each([
    ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)", "GPTBot"],
    ["Mozilla/5.0 (compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot)", "OAI-SearchBot"],
    ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)", "ClaudeBot"],
    ["Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)", "PerplexityBot"],
    ["Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", "Googlebot"],
    ["Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)", "Bingbot"],
    [CHROME, null],
    [null, null],
  ])("%p is crawler %p", (ua, name) => {
    expect(crawlerName(ua)).toBe(name);
  });
});

describe("counting", () => {
  test("a person reaching a blog post from ChatGPT is counted as ai_chat", async () => {
    await visit("/blog/uk", { referer: "https://chatgpt.com/c/123", "user-agent": CHROME });
    expect(await views()).toEqual([{ path: "/blog/uk", referer_host: "chatgpt.com", source: "ai_chat", bot_name: null }]);
  });

  test("a crawler reading llms.txt is counted with its name", async () => {
    await visit("/llms.txt", { "user-agent": "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)" });
    expect(await views()).toEqual([{ path: "/llms.txt", referer_host: null, source: "direct", bot_name: "GPTBot" }]);
  });

  test("an unknown bio page (404) is not counted", async () => {
    await sql`insert into users (id, google_sub, email) values (${Bun.randomUUIDv7()}, 'g', 'a@example.com')`;
    await visit("/@nobody");
    expect(await views()).toEqual([]);
  });

  test.each(["/admin/login", "/links/import", "/account/keys", "/v1/openapi.json", "/somecode", "/blog/de", "/health"])("%s is not counted", async (path) => {
    await visit(path, { "user-agent": CHROME });
    expect(await views()).toEqual([]);
  });

  // /blog only redirects to /blog/<lang>, which is counted when the browser follows it.
  test("a redirect is not counted, so /blog then /blog/uk is one view", async () => {
    expect((await visit("/blog", { "user-agent": CHROME })).status).toBe(302);
    await visit("/blog/uk", { "user-agent": CHROME });
    expect((await views()).map((v) => v.path)).toEqual(["/blog/uk"]);
  });

  test("POSTs are not counted", async () => {
    await app.request(`${ORIGIN}/`, { method: "POST" });
    expect(await views()).toEqual([]);
  });

  test("the admin AI page shows sources, crawlers and pages", async () => {
    await visit("/", { referer: "https://www.perplexity.ai/search", "user-agent": CHROME });
    await visit("/sitemap.xml", { "user-agent": "Mozilla/5.0 (compatible; ClaudeBot/1.0)" });
    const html = await (await adminGet(app, "/admin/ai", await adminSession(app, mail))).text();
    for (const text of [">ai_chat<", ">www.perplexity.ai<", ">ClaudeBot<", ">/<"]) expect(html).toContain(text);
  });
});
