-- A conversion: a service reports that a click (identified by the yoy_sid it was given) led to a
-- sign-up, a purchase or any other event. Attributed to the click's link.
create table conversions (
  id          uuid primary key,
  service_id  uuid not null references services (id),
  link_id     uuid not null references links (id),
  click_id    uuid not null,
  event       text not null check (event ~ '^[a-z0-9][a-z0-9_.:-]{0,63}$'),
  value       numeric(14, 2) check (value >= 0),
  currency    char(3) check (currency ~ '^[A-Z]{3}$'),
  external_id text,
  occurred_at timestamptz not null,
  created_at  timestamptz not null default now(),
  check ((value is null) = (currency is null))
);
-- The service's own id for the event (an order number) makes a retry harmless.
create unique index conversions_external_idx on conversions (service_id, external_id) where external_id is not null;
create index conversions_link_idx on conversions (link_id, occurred_at);
create index conversions_service_idx on conversions (service_id, occurred_at);
