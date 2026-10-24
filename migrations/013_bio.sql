-- Link-in-bio pages at yoy.fyi/@handle: one per user, listing chosen short links in order.
create table bio_pages (
  user_id     uuid primary key references users (id),
  handle      text not null unique check (handle ~ '^[a-z0-9][a-z0-9_.-]{2,29}$'),
  title       text,
  description text,
  link_ids    uuid[] not null default '{}',
  updated_at  timestamptz not null default now()
);
