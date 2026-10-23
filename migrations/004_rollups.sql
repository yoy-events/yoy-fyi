-- Rollups are recomputed per UTC day from raw clicks (src/rollup.ts) and kept forever.
-- `bucket` is the start of the UTC hour or day.
create table link_stats_hourly (
  link_id    uuid not null,
  service_id uuid not null,
  bucket     timestamptz not null,
  is_bot     boolean not null,
  clicks     int not null,
  uniques    int not null,
  primary key (link_id, bucket, is_bot)
);
create index link_stats_hourly_service_idx on link_stats_hourly (service_id, bucket);

create table link_stats_daily (like link_stats_hourly including all);
create index link_stats_daily_service_idx on link_stats_daily (service_id, bucket);

create table link_dims_daily (
  link_id    uuid not null,
  service_id uuid not null,
  bucket     timestamptz not null,
  dim        text not null,
  value      text,
  is_bot     boolean not null,
  clicks     int not null
);
create index link_dims_daily_link_idx on link_dims_daily (link_id, dim, bucket);
create index link_dims_daily_service_idx on link_dims_daily (service_id, dim, bucket);

-- Creates the partition holding `at`, for backfills and imports of past clicks.
create function create_click_partition(at timestamptz) returns void
language plpgsql as $$
declare
  m date := date_trunc('month', at at time zone 'utc')::date;
begin
  execute format(
    'create table if not exists %I partition of clicks for values from (%L) to (%L)',
    'clicks_' || to_char(m, 'YYYY_MM'),
    m::timestamp at time zone 'utc', (m + interval '1 month')::timestamp at time zone 'utc'
  );
end $$;
