import type { SQL } from "bun";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { requireKey } from "./auth";
import { type Click, describeUserAgent, insertClick, queryFields, refererHost } from "./click";
import { type RateLimit, createRateLimiter, rateLimitKey } from "./ratelimit";
import { keyRoutes } from "./keys";
import { linkRoutes } from "./links";
import { createSaltSource, visitorHash } from "./salt";
import { buildTarget } from "./target";

export type AppDeps = {
  sql: SQL;
  publicOrigin: string;
  countryOf: (ip: string) => string | null;
  recordClick?: (click: Click) => Promise<void>;
  now?: () => Date;
  redirectLimit?: RateLimit;
  resolveHost?: (host: string) => Promise<string[]>;
  createLimit?: RateLimit;
};

// The server passes the socket address as `ip`. In production the app port is reachable only
// through Fly's proxy, which overwrites Fly-Client-IP, so the header can be trusted there.
type Env = { Bindings: { ip?: string } };

const CODE = /^[A-Za-z0-9_-]{1,64}$/;

type LinkRow = {
  id: string;
  service_id: string;
  target_url: string;
  utm_defaults: Record<string, string> | null;
  pass_click_id: boolean;
  gone: boolean;
};

const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body><h1>${title}</h1><p>${body}</p></body></html>`;

export function createApp({
  sql,
  publicOrigin,
  resolveHost,
  createLimit,
  countryOf,
  recordClick,
  now = () => new Date(),
  redirectLimit = { perMinute: 120, burst: 60 },
}: AppDeps) {
  const app = new Hono<Env>();
  const saltFor = createSaltSource(sql);
  const record = recordClick ?? ((click: Click) => insertClick(sql, click));
  const limitRedirect = createRateLimiter(redirectLimit);

  app.use(
    secureHeaders({
      contentSecurityPolicy: { defaultSrc: ["'none'"], baseUri: ["'none'"], frameAncestors: ["'none'"] },
      strictTransportSecurity: "max-age=63072000; includeSubDomains",
      xFrameOptions: "DENY",
      referrerPolicy: "strict-origin-when-cross-origin",
    }),
  );

  app.get("/health", (c) => c.json({ ok: true }));

  const v1 = new Hono();
  v1.use(requireKey(sql));
  v1.route("/", keyRoutes(sql));
  v1.route("/", linkRoutes({ sql, publicOrigin, resolveHost, createLimit }));
  app.route("/v1", v1);

  app.get("/:code", async (c) => {
    const code = c.req.param("code");
    if (!CODE.test(code)) return c.html(page("Not found", "This short link does not exist."), 404);

    const [link]: LinkRow[] = await sql`
      select id, service_id, target_url, utm_defaults, pass_click_id,
             (disabled_at is not null or expires_at <= now()) as gone
      from links where code = ${code}`;
    if (!link) return c.html(page("Not found", "This short link does not exist."), 404);
    if (link.gone) return c.html(page("Link no longer available", "This short link was disabled or has expired."), 410);

    const ip = c.req.header("fly-client-ip") ?? c.env?.ip ?? null;
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
    return c.redirect(location, 302);
  });

  app.notFound((c) => c.html(page("Not found", "This short link does not exist."), 404));

  return app;
}
