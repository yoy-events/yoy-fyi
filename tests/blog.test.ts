// The blog, robots.txt, sitemap.xml and llms.txt, plus rules every post in content/blog must meet.
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { SQL } from "bun";
import { createApp } from "../src/app";
import { LANGS, loadPosts } from "../src/blog";
import { testDb } from "./helpers";

const ORIGIN = "https://yoy.fyi";
const DIR = new URL("../content/blog", import.meta.url).pathname;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  const sql: SQL = await testDb();
  app = createApp({ sql, publicOrigin: ORIGIN, countryOf: () => null });
});

const get = (path: string, headers: Record<string, string> = {}) => app.request(`${ORIGIN}${path}`, { headers });
const posts = loadPosts(DIR);
const slugs = [...new Set(posts.map((p) => p.slug))];

describe("content rules", () => {
  test("there are posts, each in every language", () => {
    expect(slugs.length).toBeGreaterThan(0);
    for (const slug of slugs) expect(readdirSync(`${DIR}/${slug}`).sort()).toEqual(LANGS.map((l) => `${l}.md`).sort());
  });

  test.each(posts.map((p) => [`${p.slug}/${p.lang}`, p] as const))("%s: no em or en dashes, a title and a description of search-friendly length", (_, p) => {
    const text = readFileSync(`${DIR}/${p.slug}/${p.lang}.md`, "utf8");
    expect(text).not.toMatch(/[—–]/);
    expect(p.title.length).toBeLessThanOrEqual(100);
    expect(p.description.length).toBeGreaterThanOrEqual(50);
    expect(p.description.length).toBeLessThanOrEqual(170);
  });
});

describe("blog pages", () => {
  test("/blog sends the visitor to their language, Ukrainian by default", async () => {
    expect((await get("/blog", { "accept-language": "fr-FR,fr;q=0.9" })).headers.get("location")).toBe("/blog/fr");
    expect((await get("/blog", { "accept-language": "de-DE" })).headers.get("location")).toBe("/blog/uk");
    expect((await get("/blog")).headers.get("location")).toBe("/blog/uk");
  });

  test.each([...LANGS])("the %s index lists that language's posts with hreflang alternates", async (lang) => {
    const res = await get(`/blog/${lang}`);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain(`<html lang="${lang}">`);
    for (const p of posts.filter((x) => x.lang === lang)) expect(html).toContain(`href="/blog/${lang}/${p.slug}"`);
    for (const l of LANGS) expect(html).toContain(`hreflang="${l}" href="${ORIGIN}/blog/${l}"`);
  });

  test("a post has its canonical URL, alternates, OG tags and BlogPosting JSON-LD", async () => {
    const p = posts.find((x) => x.lang === "en")!;
    const html = await (await get(`/blog/en/${p.slug}`)).text();
    expect(html).toContain(`<link rel="canonical" href="${ORIGIN}/blog/en/${p.slug}"/>`);
    expect(html).toContain(`hreflang="x-default" href="${ORIGIN}/blog/en/${p.slug}"`);
    expect(html).toContain('<meta property="og:title"');
    const ld = JSON.parse(/<script type="application\/ld\+json">(.*?)<\/script>/.exec(html)![1]!);
    expect(ld).toMatchObject({ "@type": "BlogPosting", headline: p.title, inLanguage: "en" });
  });

  test("the blog pages may load the stylesheet", async () => {
    expect((await get("/blog/uk")).headers.get("content-security-policy")).toContain("style-src 'self'");
  });

  test.each(["/blog/de", "/blog/uk/no-such-post", "/blog/de/whatever", "/blog/uk/rss.xml/x"])("%s is 404", async (path) => {
    expect((await get(path)).status).toBe(404);
  });

  test("each language has an RSS feed", async () => {
    const res = await get("/blog/es/rss.xml");
    expect(res.headers.get("content-type")).toStartWith("application/rss+xml");
    expect(await res.text()).toContain("<language>es</language>");
  });
});

describe("files for crawlers", () => {
  test("robots.txt allows crawling, keeps private areas out and names the sitemap", async () => {
    const text = await (await get("/robots.txt")).text();
    expect(text).toContain("User-agent: *\nAllow: /");
    for (const path of ["/admin", "/account", "/links", "/oauth"]) expect(text).toContain(`Disallow: ${path}`);
    expect(text).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`);
  });

  test("outside production, robots.txt disallows everything and responses say noindex", async () => {
    const sql: SQL = await testDb();
    const test = createApp({ sql, publicOrigin: "https://test.yoy.fyi", countryOf: () => null, indexable: false });
    const res = await test.request("https://test.yoy.fyi/robots.txt");
    expect(await res.text()).toBe("User-agent: *\nDisallow: /\n");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect((await test.request("https://test.yoy.fyi/blog/uk")).headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect((await get("/blog/uk")).headers.get("x-robots-tag")).toBeNull();
  });

  test("sitemap.xml lists the home page and every post in every language", async () => {
    const res = await get("/sitemap.xml");
    const text = await res.text();
    expect(res.headers.get("content-type")).toStartWith("application/xml");
    expect(text).toContain(`<loc>${ORIGIN}/</loc>`);
    for (const p of posts) expect(text).toContain(`<loc>${ORIGIN}/blog/${p.lang}/${p.slug}</loc>`);
  });

  test("llms.txt describes the service, the MCP address and the English posts", async () => {
    const text = await (await get("/llms.txt")).text();
    expect(text).toStartWith("# yoy.fyi");
    expect(text).toContain(`${ORIGIN}/mcp`);
    for (const p of posts.filter((x) => x.lang === "en")) expect(text).toContain(`${ORIGIN}/blog/en/${p.slug}`);
  });

  test("blog is a reserved short-link code", async () => {
    expect((await get("/blog")).status).toBe(302);
  });
});

describe("loadPosts", () => {
  test("a post missing a language fails loudly", () => {
    const dir = `${import.meta.dir}/../test-results/blog-missing`;
    mkdirSync(`${dir}/only-uk`, { recursive: true });
    writeFileSync(`${dir}/only-uk/uk.md`, "---\ntitle: T\ndescription: D\ndate: 2026-10-25\n---\nBody");
    expect(() => loadPosts(dir)).toThrow();
  });
});

describe("icon and domain verification", () => {
  test.each([
    ["/static/icon.svg", "image/svg+xml"],
    ["/static/icon-512.png", "image/png"],
    ["/static/icon-192.png", "image/png"],
    ["/favicon.ico", "image/png"],
  ])("%s is served as %s", async (path, type) => {
    const res = await get(path);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(type);
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(100);
  });

  test("pages link the icon", async () => {
    expect(await (await get("/blog/uk")).text()).toContain('rel="icon" href="/static/icon.svg"');
  });

  test("the OpenAI challenge is served only when configured", async () => {
    expect((await get("/.well-known/openai-apps-challenge")).status).toBe(404);
    const sql: SQL = await testDb();
    const withToken = createApp({ sql, publicOrigin: ORIGIN, countryOf: () => null, openaiAppsChallenge: "tok_123" });
    const res = await withToken.request(`${ORIGIN}/.well-known/openai-apps-challenge`);
    expect(res.headers.get("content-type")).toStartWith("text/plain");
    expect(await res.text()).toBe("tok_123");
  });
});
