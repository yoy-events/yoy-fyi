import type { SQL } from "bun";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { type AdminConfig, adminRoutes } from "./admin";
import { analyticsRoutes } from "./analytics";
import { requireKey } from "./auth";
import { type Click, describeUserAgent, insertClick, queryFields, refererHost } from "./click";
import { type RateLimit, createRateLimiter, rateLimitKey } from "./ratelimit";
import { keyRoutes } from "./keys";
import { type Preview, linkRoutes } from "./links";
import { mcpRoutes } from "./mcp";
import { webRoutes } from "./web";
import { type FetchClientMetadata, fetchClientMetadata, oauthRoutes } from "./oauth";
import type { UnsafeUrls } from "./safe-browsing";
import { createSaltSource, visitorHash } from "./salt";
import { buildTarget } from "./target";
import { webhookRoutes } from "./webhooks";

export type AppDeps = {
  sql: SQL;
  publicOrigin: string;
  countryOf: (ip: string) => string | null;
  recordClick?: (click: Click) => Promise<void>;
  now?: () => Date;
  redirectLimit?: RateLimit;
  resolveHost?: (host: string) => Promise<string[]>;
  // Google Safe Browsing check for link targets; without it targets are not checked.
  unsafeUrls?: UnsafeUrls;
  createLimit?: RateLimit;
  webhookKey?: CryptoKey;
  admin?: AdminConfig;
  mcpLimit?: RateLimit;
  clientMetadata?: FetchClientMetadata;
};

// The server resolves the visitor's IP once (see client-ip.ts) and passes it as `ip`.
type Env = { Bindings: { ip?: string } };

const CODE = /^[A-Za-z0-9_-]{1,64}$/;
const spec = Bun.YAML.parse(await Bun.file(new URL("../openapi.yaml", import.meta.url).pathname).text());

type LinkRow = {
  id: string;
  service_id: string;
  target_url: string;
  utm_defaults: Record<string, string> | null;
  preview: Preview | null;
  pass_click_id: boolean;
  gone: boolean;
};

// Link-preview fetchers of chat apps and social networks. They get the link's own preview.
const PREVIEW_BOTS = /TelegramBot|facebookexternalhit|Facebot|Twitterbot|LinkedInBot|Slackbot|WhatsApp|Discordbot|Viber|SkypeUriPreview|redditbot|Pinterest|vkShare/i;

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

const previewPage = (preview: Preview, shortUrl: string, location: string) => {
  const meta = (property: string, content: string | undefined) =>
    content === undefined ? "" : `<meta property="${property}" content="${escapeHtml(content)}">`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(preview.title)}</title>${meta("og:title", preview.title)}${meta("og:description", preview.description)}${meta("og:image", preview.image)}${meta("og:url", shortUrl)}<meta name="twitter:card" content="${preview.image ? "summary_large_image" : "summary"}"><meta http-equiv="refresh" content="0;url=${escapeHtml(location)}"></head><body><a href="${escapeHtml(location)}">${escapeHtml(preview.title)}</a></body></html>`;
};

const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body><h1>${title}</h1><p>${body}</p></body></html>`;

export function createApp({
  sql,
  publicOrigin,
  resolveHost,
  unsafeUrls,
  createLimit,
  webhookKey,
  admin,
  mcpLimit,
  clientMetadata,
  countryOf,
  recordClick,
  now = () => new Date(),
  redirectLimit = { perMinute: 120, burst: 60 },
}: AppDeps) {
  const app = new Hono<Env>();
  // The old short host a.yoy.fyi keeps working by forwarding to the same path on PUBLIC_ORIGIN.
  const legacyHost = `a.${new URL(publicOrigin).host}`;
  app.use(async (c, next) => {
    const url = new URL(c.req.url);
    if (url.host === legacyHost) return c.redirect(publicOrigin + url.pathname + url.search, 301);
    await next();
  });
  const saltFor = createSaltSource(sql);
  const record = recordClick ?? ((click: Click) => insertClick(sql, click));
  const limitRedirect = createRateLimiter(redirectLimit);

  const headers = (csp: Record<string, string[]>) =>
    secureHeaders({
      contentSecurityPolicy: { defaultSrc: ["'none'"], baseUri: ["'none'"], frameAncestors: ["'none'"], ...csp },
      strictTransportSecurity: "max-age=63072000; includeSubDomains",
      xFrameOptions: "DENY",
      referrerPolicy: "strict-origin-when-cross-origin",
    });
  const publicHeaders = headers({});
  // Admin pages load their stylesheet and QR images from this origin and post forms to it.
  // The pages' only script is /static/copy.js (the Copy button); no inline script is allowed.
  const adminHeaders = headers({ styleSrc: ["'self'"], imgSrc: ["'self'"], formAction: ["'self'"], scriptSrc: ["'self'"] });
  // The OAuth consent form redirects to claude.ai or chatgpt.com after its POST, and Chrome
  // applies form-action to that redirect, so this page sets no form-action at all.
  const oauthHeaders = headers({ styleSrc: ["'self'"] });
  app.use((c, next) => {
    const path = c.req.path;
    // The personal pages (ADR-0004) load the same stylesheet and QR images and post forms like the admin.
    if (path.startsWith("/admin") || path === "/" || /^\/(links|account|privacy|terms|login|logout)(\/|$)/.test(path)) {
      return adminHeaders(c, next);
    }
    return path.startsWith("/oauth") ? oauthHeaders(c, next) : publicHeaders(c, next);
  });

  const adminCss = Bun.file(new URL("./admin/admin.css", import.meta.url).pathname);
  const copyJs = Bun.file(new URL("./admin/copy.js", import.meta.url).pathname);
  app.get("/static/copy.js", (c) =>
    c.body(copyJs.stream(), 200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=3600" }),
  );
  app.get("/static/admin.css", (c) =>
    c.body(adminCss.stream(), 200, { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "public, max-age=3600" }),
  );

  app.get("/health", (c) => c.json({ ok: true }));

  // The contract is public, so agents and generators can read it without a key.
  app.get("/v1/openapi.json", (c) => c.json(spec));

  const v1 = new Hono();
  v1.use(requireKey(sql));
  v1.route("/", keyRoutes(sql));
  v1.route("/", analyticsRoutes(sql));
  v1.route("/", webhookRoutes({ sql, publicOrigin, webhookKey, resolveHost }));
  v1.route("/", linkRoutes({ sql, publicOrigin, resolveHost, unsafeUrls, createLimit }));
  app.route("/v1", v1);

  app.post("/mcp", mcpRoutes({ sql, publicOrigin, v1, now, limit: mcpLimit }));
  if (admin) {
    app.route("/", webRoutes({ sql, publicOrigin, admin, now, resolveHost, unsafeUrls }));
    const ownHost = new URL(publicOrigin).hostname;
    const metadata = clientMetadata ?? fetchClientMetadata({ ownHost, resolveHost });
    app.route("/", oauthRoutes({ sql, publicOrigin, admin, now, clientMetadata: metadata }));
  }
  app.on(["GET", "DELETE"], "/mcp", (c) => c.json({ error: { code: "method_not_allowed", message: "POST only." } }, 405));
  if (admin) app.route("/admin", adminRoutes({ sql, publicOrigin, admin, now, resolveHost, unsafeUrls }));

  app.get("/:code", async (c) => {
    const code = c.req.param("code");
    if (!CODE.test(code)) return c.html(page("Not found", "This short link does not exist."), 404);

    // A blocked owner's service takes its links down too (ADR-0004).
    const [link]: LinkRow[] = await sql`
      select l.id, l.service_id, l.target_url, l.utm_defaults, l.preview, l.pass_click_id,
             (l.disabled_at is not null or l.expires_at <= now() or s.disabled_at is not null) as gone
      from links l join services s on s.id = l.service_id where l.code = ${code}`;
    if (!link) return c.html(page("Not found", "This short link does not exist."), 404);
    if (link.gone) return c.html(page("Link no longer available", "This short link was disabled or has expired."), 410);

    const ip = c.env?.ip ?? null;
    if (ip) {
      const limit = limitRedirect(rateLimitKey(ip));
      if (!limit.ok) {
        c.header("Retry-After", String(limit.retryAfterSeconds));
        return c.text("Too many requests", 429);
      }
    }

    const query = new URL(c.req.url).searchParams;
    const clickId = Bun.randomUUIDv7();
    const location = buildTarget(link.target_url, query, link.utm_defaults, link.pass_click_id ? clickId : null);

    if (c.req.method === "GET") {
      try {
        const clickedAt = now();
        const ua = c.req.header("user-agent") ?? null;
        const referer = c.req.header("referer") ?? null;
        await record({
          id: clickId,
          link_id: link.id,
          service_id: link.service_id,
          clicked_at: clickedAt,
          referer,
          referer_host: refererHost(referer),
          ...describeUserAgent(ua),
          country: ip ? countryOf(ip) : null,
          visitor_hash: ip ? visitorHash(await saltFor(clickedAt), ip, ua ?? "") : null,
          ...queryFields(query),
        });
      } catch (err) {
        console.error("click not recorded", { link_id: link.id, error: String(err) });
      }
    }

    c.header("Cache-Control", "no-store");
    if (link.preview && PREVIEW_BOTS.test(c.req.header("user-agent") ?? "")) {
      return c.html(previewPage(link.preview, `${publicOrigin}/${code}`, location));
    }
    return c.redirect(location, 302);
  });

  app.notFound((c) => c.html(page("Not found", "This short link does not exist."), 404));

  return app;
}
