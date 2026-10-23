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

const RAW_RETENTION_MONTHS = 13;

// Drops monthly click partitions that ended before the start of the month 13 months back,
// so at least 13 full months of raw clicks stay. This is the only path that removes raw
// clicks (ADR-0001); rollups keep the counts. Returns the dropped partition names.
export async function dropExpiredClicks(sql: SQL, now = new Date()): Promise<string[]> {
  const cutoff = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - RAW_RETENTION_MONTHS, 1);
  const rows = await sql`
    select c.relname from pg_inherits i join pg_class c on c.oid = i.inhrelid
    where i.inhparent = 'clicks'::regclass order by c.relname`;
  const dropped: string[] = [];
  for (const { relname } of rows as { relname: string }[]) {
    const match = /^clicks_(\d{4})_(\d{2})$/.exec(relname);
    if (!match) continue;
    const end = Date.UTC(Number(match[1]), Number(match[2]), 1); // month index is 0-based: this is the next month
    if (end > cutoff) continue;
    await sql`drop table ${sql.unsafe(relname)}`;
    console.log("dropped expired click partition", relname);
    dropped.push(relname);
  }
  return dropped;
}
