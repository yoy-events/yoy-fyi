// Counting visits to the public pages, privately: the path, where the visitor came from (as a
// category and host) and, for crawlers, which one. No IP address, cookie or user agent is kept.
import type { SQL } from "bun";
import type { MiddlewareHandler } from "hono";
import { AI_REFERRERS } from "./admin/ai";
import { describeUserAgent, refererHost } from "./click";

// AI and search crawlers by the token in their user agent; matched before the generic bot check.
const CRAWLERS: [RegExp, string][] = [
  [/OAI-SearchBot/i, "OAI-SearchBot"],
  [/ChatGPT-User/i, "ChatGPT-User"],
  [/GPTBot/i, "GPTBot"],
  [/Claude-SearchBot/i, "Claude-SearchBot"],
  [/Claude-User/i, "Claude-User"],
  [/ClaudeBot/i, "ClaudeBot"],
  [/Perplexity-User/i, "Perplexity-User"],
  [/PerplexityBot/i, "PerplexityBot"],
  [/Google-CloudVertexBot|Google-Extended/i, "Google-Extended"],
  [/Googlebot/i, "Googlebot"],
  [/bingbot/i, "Bingbot"],
  [/Applebot/i, "Applebot"],
  [/DuckDuckBot/i, "DuckDuckBot"],
  [/YandexBot/i, "YandexBot"],
  [/meta-externalagent/i, "Meta-ExternalAgent"],
  [/CCBot/i, "CCBot"],
  [/Bytespider/i, "Bytespider"],
];
const SEARCH = /(^|\.)(google\.[a-z.]+|bing\.com|duckduckgo\.com|yandex\.[a-z]+|search\.brave\.com|ecosia\.org|yahoo\.com)$/;
const SOCIAL = /(^|\.)(t\.me|telegram\.org|instagram\.com|facebook\.com|fb\.com|x\.com|twitter\.com|linkedin\.com|threads\.net|youtube\.com|tiktok\.com|reddit\.com|lnkd\.in)$/;
const AI = new RegExp(AI_REFERRERS.map((h) => `(^|\\.)${h.replace(/\./g, "\\.")}$`).join("|"));

export function crawlerName(ua: string | null): string | null {
  if (!ua) return null;
  for (const [re, name] of CRAWLERS) if (re.test(ua)) return name;
  const generic = describeUserAgent(ua);
  return generic.is_bot ? (generic.bot_name ?? "bot") : null;
}

export function sourceOf(host: string | null, ownHost: string): string {
  if (!host) return "direct";
  if (host === ownHost || host.endsWith(`.${ownHost}`)) return "internal";
  if (AI.test(host)) return "ai_chat";
  if (SEARCH.test(host)) return "search";
  if (SOCIAL.test(host)) return "social";
  return "other";
}

// Bio pages are counted as one path so handles don't flood the table.
const PUBLIC = /^\/($|(en|es|fr)(\/docs\/mcp)?$|blog(\/|$)|docs(\/|$)|privacy$|terms$|@|llms\.txt$|robots\.txt$|sitemap\.xml$)/;
const normalise = (path: string) => (path.startsWith("/@") ? "/@*" : path.slice(0, 300));

export function countPageViews(sql: SQL, publicOrigin: string, now: () => Date): MiddlewareHandler {
  const ownHost = new URL(publicOrigin).hostname;
  return async (c, next) => {
    await next();
    // Redirects (/blog to /blog/<lang>) are counted at the page they lead to.
    if (c.req.method !== "GET" || c.res.status >= 300 || !PUBLIC.test(c.req.path)) return;
    const host = refererHost(c.req.header("referer") ?? null);
    await sql`
      insert into page_views (id, at, path, referer_host, source, bot_name)
      values (${Bun.randomUUIDv7()}, ${now()}, ${normalise(c.req.path)}, ${host}, ${sourceOf(host, ownHost)}, ${crawlerName(c.req.header("user-agent") ?? null)})`.catch(
      (err) => console.error("page view not counted", String(err)),
    );
  };
}
