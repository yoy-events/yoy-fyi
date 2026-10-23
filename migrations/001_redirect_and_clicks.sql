create table services (
  id          uuid primary key,
  slug        text not null unique,
  name        text not null,
  created_at  timestamptz not null default now(),
  disabled_at timestamptz
);

create table links (
  id            uuid primary key,
  service_id    uuid not null references services(id),
  code          text not null unique,
  target_url    text not null,
  utm_defaults  jsonb,
  pass_click_id boolean not null default false,
  expires_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  disabled_at   timestamptz
);

-- Append-only and partitioned by month. No foreign key to links: links are never
-- hard-deleted, and the redirect path should pay for one index write, not two.
create table clicks (
  id           uuid not null,
  link_id      uuid not null,
  service_id   uuid not null,
  clicked_at   timestamptz not null,
  referer      text,
  referer_host text,
  ua_device    text,
  ua_browser   text,
  ua_os        text,
  is_bot       boolean not null,
  bot_name     text,
  country      text,
  visitor_hash text,
  utm_source   text,
  utm_medium   text,
  utm_campaign text,
  utm_term     text,
  utm_content  text,
  fbclid       text,
  gclid        text,
  fbc          text,
  fbp          text,
  primary key (id, clicked_at)
) partition by range (clicked_at);

create index clicks_link_id_clicked_at_idx on clicks (link_id, clicked_at);

-- Creates the monthly partitions from the current month to `months_ahead` months out.
create function ensure_click_partitions(months_ahead int) returns void
language plpgsql as $$
declare
  m date := date_trunc('month', now() at time zone 'utc')::date;
begin
  for i in 0..months_ahead loop
    execute format(
      'create table if not exists %I partition of clicks for values from (%L) to (%L)',
      'clicks_' || to_char(m, 'YYYY_MM'),
      m::timestamp at time zone 'utc', (m + interval '1 month')::timestamp at time zone 'utc'
    );
    m := (m + interval '1 month')::date;
  end loop;
end $$;

select ensure_click_partitions(2);

-- One random salt per UTC day for visitor hashes. Rows older than yesterday are
-- deleted when a new day's salt is created, so a hash cannot be recomputed later.
create table daily_salts (
  day  date primary key,
  salt bytea not null
);
