import type { SQL } from "bun";
import type { Context } from "hono";
import { Hono } from "hono";
import { type AuthEnv, requireScope } from "./auth";
import { apiError, isDateTime, isUuid } from "./http";
import { DIMENSIONS, type Dimension } from "./rollup";

const TAG = /^[a-z0-9][a-z0-9_:.-]{0,39}$/;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const MAX_RANGE = { hour: 31 * DAY, day: 400 * DAY };

export type Bots = "exclude" | "include" | "only";
export type Scope = { serviceId: string; linkId: string | null; tag: string | null; from: Date; to: Date; bots: Bots };

// Parses the filters every analytics endpoint shares and rounds from/to out to whole buckets.
// Returns a Response when the request is invalid.
async function parseScope(c: Context<AuthEnv>, sql: SQL, step: number, maxRange: number): Promise<Scope | Response> {
  const q = c.req.query();
  const bots = (q.bots ?? "exclude") as Bots;
  const valid =
    isDateTime(q.from ?? "") &&
    isDateTime(q.to ?? "") &&
    ["exclude", "include", "only"].includes(bots) &&
    (q.link_id === undefined || isUuid(q.link_id)) &&
    (q.tag === undefined || TAG.test(q.tag));
  if (!valid) return apiError(c, 400, "invalid_request", "Invalid or missing query parameter.");

  const from = Math.floor(Date.parse(q.from!) / step) * step;
  const to = Math.ceil(Date.parse(q.to!) / step) * step;
  if (from >= to) return apiError(c, 400, "invalid_request", "from must be before to.");
  if (to - from > maxRange) return apiError(c, 422, "range_too_large", "The requested range is too large.");

  const serviceId = c.get("caller").serviceId;
  if (q.link_id) {
    const [own] = await sql`select 1 from links where id = ${q.link_id} and service_id = ${serviceId}`;
    if (!own) return apiError(c, 404, "not_found", "Link not found.");
  }
  return { serviceId, linkId: q.link_id ?? null, tag: q.tag ?? null, from: new Date(from), to: new Date(to), bots };
}

// Rollup rows of the scope's links, without the time or bot filter.
const scopeFilter = (sql: SQL, s: Scope) => sql`
  service_id = ${s.serviceId}
  and (${s.linkId}::uuid is null or link_id = ${s.linkId}::uuid)
  and (${s.tag}::text is null or link_id in (
    select id from links where service_id = ${s.serviceId} and tags @> array[${s.tag}::text]))`;
const botFilter = (sql: SQL, bots: Bots) => sql`(${bots} = 'include' or is_bot = (${bots} = 'only'))`;

// Clicks over time for a scope whose from/to are already whole buckets of `interval`.
export async function timeseries(sql: SQL, scope: Scope, interval: "hour" | "day") {
  const step = interval === "hour" ? HOUR : DAY;
  const table = sql.unsafe(interval === "hour" ? "link_stats_hourly" : "link_stats_daily");
  const where = scopeFilter(sql, scope);
  const range = sql`bucket >= ${scope.from} and bucket < ${scope.to}`;
  const points = await sql`
    select b.t,
           coalesce(sum(r.clicks) filter (where ${botFilter(sql, scope.bots)}), 0)::int as clicks,
           coalesce(sum(r.uniques) filter (where ${botFilter(sql, scope.bots)}), 0)::int as uniques
    from generate_series(${scope.from}::timestamptz, ${scope.to}::timestamptz - ${`${step / 1000} seconds`}::interval,
                         ${`${step / 1000} seconds`}::interval) as b(t)
    left join ${table} r on r.bucket = b.t and ${where}
    group by b.t order by b.t`;
  const [totals] = await sql`
    select
      (select coalesce(sum(clicks), 0)::int from ${table} where ${where} and ${range} and is_bot) as bot_clicks,
      (select coalesce(sum(uniques), 0)::int from link_stats_daily
        where ${where} and ${botFilter(sql, scope.bots)}
          and bucket >= ${new Date(Math.floor(scope.from.getTime() / DAY) * DAY)}
          and bucket < ${scope.to}) as uniques_upper_bound`;

  return {
    interval,
    from: scope.from,
    to: scope.to,
    bots: scope.bots,
    totals: {
      clicks: points.reduce((sum: number, p: { clicks: number }) => sum + p.clicks, 0) as number,
      uniques_upper_bound: totals.uniques_upper_bound as number,
      bot_clicks: totals.bot_clicks as number,
    },
    points: points.map((p: { t: Date; clicks: number; uniques: number }) => ({ t: p.t, clicks: p.clicks, uniques: p.uniques })) as {
      t: Date;
      clicks: number;
      uniques: number;
    }[],
  };
}

// Clicks per value of one dimension for a scope whose from/to are whole days.
export async function breakdown(sql: SQL, scope: Scope, dimension: Dimension, limit: number) {
  const rows = await sql`
    select value, sum(clicks)::int as clicks
    from link_dims_daily
    where ${scopeFilter(sql, scope)} and ${botFilter(sql, scope.bots)}
      and dim = ${dimension} and bucket >= ${scope.from} and bucket < ${scope.to}
    group by value
    order by clicks desc, value asc nulls last`;
  const items: { value: string | null; clicks: number }[] = rows
    .slice(0, limit)
    .map((r: { value: string | null; clicks: number }) => ({ value: r.value, clicks: r.clicks }));
  const total: number = rows.reduce((sum: number, r: { clicks: number }) => sum + r.clicks, 0);
  const shown = items.reduce((sum, r) => sum + r.clicks, 0);

  return {
    dimension,
    from: scope.from,
    to: scope.to,
    bots: scope.bots,
    total_clicks: total,
    other_clicks: total - shown,
    items,
  };
}

export function analyticsRoutes(sql: SQL) {
  const app = new Hono<AuthEnv>();

  app.get("/analytics/timeseries", requireScope("analytics:read"), async (c) => {
    const interval = c.req.query("interval");
    if (interval !== "hour" && interval !== "day") return apiError(c, 400, "invalid_request", "interval must be hour or day.");
    const scope = await parseScope(c, sql, interval === "hour" ? HOUR : DAY, MAX_RANGE[interval]);
    if (scope instanceof Response) return scope;

    return c.json(await timeseries(sql, scope, interval));
  });

  app.get("/analytics/breakdown", requireScope("analytics:read"), async (c) => {
    const dimension = c.req.query("dimension") ?? "";
    const rawLimit = c.req.query("limit");
    const limit = rawLimit === undefined ? 20 : Number(rawLimit);
    if (!Object.hasOwn(DIMENSIONS, dimension) || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      return apiError(c, 400, "invalid_request", "Invalid dimension or limit.");
    }
    const scope = await parseScope(c, sql, DAY, MAX_RANGE.day);
    if (scope instanceof Response) return scope;

    return c.json(await breakdown(sql, scope, dimension as Dimension, limit));
  });

  return app;
}
