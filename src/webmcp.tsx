// WebMCP: a browser's built-in agent (Chrome's document.modelContext) gets tools from
// /static/webmcp.js while the user is signed in on yoy.fyi, and those tools call these JSON
// endpoints with the user's own session. They sit under /account/, so the session, same-origin
// and form-limit rules of the site apply; errors are in English, like the MCP server's.
import type { SQL } from "bun";
import { type Context, Hono } from "hono";
import { breakdown, timeseries } from "./analytics";
import { isUuid, readJsonObject } from "./http";
import { type LinkRow, createLink, toLink } from "./links";
import { MESSAGES } from "./messages";
import { qrPng } from "./qr";
import type { createRateLimiter } from "./ratelimit";
import type { UnsafeUrls } from "./safe-browsing";
import type { User } from "./users";

const DAY = 86_400_000;
const T = MESSAGES.en;

type Deps = {
  sql: SQL;
  publicOrigin: string;
  now: () => Date;
  resolveHost?: (host: string) => Promise<string[]>;
  unsafeUrls?: UnsafeUrls;
  // The create form's per-user limiter, shared so the agent can't add to it.
  limitCreate: ReturnType<typeof createRateLimiter>;
};
type Env = { Variables: { user: User } };

export function agentRoutes({ sql, publicOrigin, now, resolveHost, unsafeUrls, limitCreate }: Deps) {
  const app = new Hono<Env>();
  const ownHost = new URL(publicOrigin).hostname;

  const qr = async (shortUrl: string) =>
    `data:image/png;base64,${Buffer.from(await qrPng(shortUrl, { fg: "#000000", bg: "#ffffff", caption: null }, 256)).toString("base64")}`;
  const ownLink = async (u: User, id: string) =>
    isUuid(id) ? ((await sql`select * from links where id = ${id} and service_id = ${u.serviceId}`)[0] as LinkRow | undefined) : undefined;

  // Every call is logged next to MCP calls, so /admin/ai shows browser agents too.
  const logged = (tool: string, handler: (c: Context<Env>) => Promise<Response>) => async (c: Context<Env>) => {
    const started = performance.now();
    const res = await handler(c);
    await sql`
      insert into mcp_calls (id, at, service_id, client, tool, ok, ms)
      values (${Bun.randomUUIDv7()}, ${now()}, ${c.get("user").serviceId}, 'webmcp', ${tool}, ${res.ok}, ${Math.round(performance.now() - started)})`.catch((err) =>
      console.error("webmcp call not logged", String(err)),
    );
    return res;
  };

  app.post(
    "/account/agent/links",
    logged("create_link", async (c) => {
      const u = c.get("user");
      const body = await readJsonObject(c);
      if (!body) return c.json({ error: "Send a JSON object." }, 400);
      if (!limitCreate(u.id).ok) return c.json({ error: T.home.tooMany }, 429);
      const result = await createLink(sql, { ownHost, resolveHost, unsafeUrls }, u.serviceId, body, null, "webmcp");
      if (result.kind === "error") {
        const fields = Object.entries((result.details?.fields ?? {}) as Record<string, string>).map(([k, v]) => `${k}: ${v}`);
        const reason = result.details?.reason ? ` (${T.reasons[String(result.details.reason)] ?? result.details.reason})` : "";
        return c.json({ error: fields.length ? fields.join("; ") : `${result.message}${reason}` }, result.status === 409 ? 409 : 422);
      }
      const link = toLink(result.row, publicOrigin, now());
      return c.json({ ...link, qr_png: await qr(link.short_url) }, 201);
    }),
  );

  app.get(
    "/account/agent/links",
    logged("list_links", async (c) => {
      const u = c.get("user");
      const q = (c.req.query("q") ?? "").trim().slice(0, 200);
      const tag = (c.req.query("tag") ?? "").trim().slice(0, 50);
      const pattern = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
      const rows: LinkRow[] = await sql`
        select * from links
        where service_id = ${u.serviceId}
          and (${q} = '' or code ilike ${pattern} or title ilike ${pattern} or target_url ilike ${pattern})
          and (${tag} = '' or ${tag} = any(tags))
        order by id desc limit 50`;
      return c.json({ links: rows.map((r) => toLink(r, publicOrigin, now())) });
    }),
  );

  app.get(
    "/account/agent/links/:id",
    logged("get_link", async (c) => {
      const u = c.get("user");
      const row = await ownLink(u, c.req.param("id") ?? "");
      if (!row) return c.json({ error: "Link not found." }, 404);
      const link = toLink(row, publicOrigin, now());
      const dayEnd = Math.floor(now().getTime() / DAY) * DAY + DAY;
      const scope = { serviceId: u.serviceId, linkId: row.id, tag: null, from: new Date(dayEnd - 30 * DAY), to: new Date(dayEnd), bots: "exclude" as const };
      const [daily, sources, countries] = await Promise.all([
        timeseries(sql, scope, "day"),
        breakdown(sql, scope, "referer_host", 5),
        breakdown(sql, scope, "country", 5),
      ]);
      return c.json({ ...link, clicks_30d: daily.totals.clicks, top_sources: sources.items, top_countries: countries.items, qr_png: await qr(link.short_url) });
    }),
  );

  app.post(
    "/account/agent/links/:id/disable",
    logged("disable_link", async (c) => {
      const u = c.get("user");
      const row = await ownLink(u, c.req.param("id") ?? "");
      if (!row) return c.json({ error: "Link not found." }, 404);
      const [updated] = await sql`
        update links set disabled_at = coalesce(disabled_at, ${now()}),
                         disabled_by = case when disabled_at is null then 'owner' else disabled_by end,
                         updated_at = ${now()}
        where id = ${row.id} and service_id = ${u.serviceId} returning *`;
      return c.json(toLink(updated as LinkRow, publicOrigin, now()));
    }),
  );

  return app;
}
