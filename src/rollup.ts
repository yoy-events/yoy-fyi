import type { SQL } from "bun";

// Dimension name -> raw clicks column.
export const DIMENSIONS = {
  referer_host: "referer_host",
  utm_source: "utm_source",
  utm_medium: "utm_medium",
  utm_campaign: "utm_campaign",
  country: "country",
  device: "ua_device",
  browser: "ua_browser",
  os: "ua_os",
} as const;
export type Dimension = keyof typeof DIMENSIONS;

const dimsUnion = Object.entries(DIMENSIONS)
  .map(([dim, column]) => `select '${dim}' as dim, ${column} as value, link_id, service_id, bucket, is_bot from day_clicks`)
  .join(" union all ");

// Recomputes every rollup for the UTC days firstDay..lastDay (inclusive, YYYY-MM-DD) from raw
// clicks, replacing what was there. Idempotent, so it is safe to rerun for any range.
export async function rollupDays(sql: SQL, firstDay: string, lastDay: string): Promise<void> {
  const from = `${firstDay}T00:00:00Z`;
  const to = new Date(Date.parse(`${lastDay}T00:00:00Z`) + 86_400_000).toISOString();
  await sql.begin(async (tx) => {
    for (const table of ["link_stats_hourly", "link_stats_daily", "link_dims_daily"]) {
      await tx`delete from ${tx.unsafe(table)} where bucket >= ${from}::timestamptz and bucket < ${to}::timestamptz`;
    }
    for (const [table, unit] of [
      ["link_stats_hourly", "hour"],
      ["link_stats_daily", "day"],
    ] as const) {
      await tx`
        insert into ${tx.unsafe(table)} (link_id, service_id, bucket, is_bot, clicks, uniques)
        select link_id, service_id, date_trunc(${unit}, clicked_at, 'UTC'), is_bot, count(*), count(distinct visitor_hash)
        from clicks
        where clicked_at >= ${from}::timestamptz and clicked_at < ${to}::timestamptz
        group by 1, 2, 3, 4`;
    }
    await tx`
      with day_clicks as (
        select *, date_trunc('day', clicked_at, 'UTC') as bucket from clicks
        where clicked_at >= ${from}::timestamptz and clicked_at < ${to}::timestamptz
      )
      insert into link_dims_daily (link_id, service_id, bucket, dim, value, is_bot, clicks)
      select link_id, service_id, bucket, dim, value, is_bot, count(*)
      from (${tx.unsafe(dimsUnion)}) d
      group by link_id, service_id, bucket, dim, value, is_bot`;
  });
}

// The scheduled pass: yesterday and today. Clicks are stamped at insert time, so nothing
// older can still arrive, and yesterday covers clicks committed just after midnight.
export async function rollupRecent(sql: SQL, now = new Date()): Promise<void> {
  const today = now.toISOString().slice(0, 10);
  const yesterday = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
  await rollupDays(sql, yesterday, today);
}
