-- People who sign in with Google and own a personal service (ADR-0004).
create table users (
  id           uuid primary key,
  google_sub   text not null unique,
  email        text not null,
  name         text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz,
  disabled_at  timestamptz
);

alter table services add column owner_user_id uuid unique references users (id);

alter table links drop constraint links_created_via_check;
alter table links add constraint links_created_via_check check (created_via in ('api', 'admin', 'mcp', 'web'));
