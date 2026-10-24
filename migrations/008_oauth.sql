-- OAuth 2.1 for agent clients (ADR-0003). Tokens and codes are stored only as sha256 hashes.

-- Client ID Metadata Documents, cached after fetching.
create table oauth_clients (
  client_id     text primary key,
  name          text not null,
  redirect_uris text[] not null,
  fetched_at    timestamptz not null
);

-- Authorize requests waiting for sign-in or consent. Single use.
create table oauth_pending (
  id             uuid primary key,
  client_id      text not null,
  redirect_uri   text not null,
  state          text,
  code_challenge text not null,
  scopes         text[] not null,
  resource       text not null,
  expires_at     timestamptz not null
);

create table oauth_codes (
  code_hash      text primary key,
  client_id      text not null,
  service_id     uuid not null references services (id),
  scopes         text[] not null,
  redirect_uri   text not null,
  code_challenge text not null,
  resource       text not null,
  expires_at     timestamptz not null,
  used_at        timestamptz
);

-- One row per connection. Refresh rotates both tokens; the previous refresh hash is kept so a
-- replayed refresh token can be detected and the whole grant revoked.
create table oauth_grants (
  id                 uuid primary key,
  client_id          text not null,
  service_id         uuid not null references services (id),
  scopes             text[] not null,
  access_hash        text not null unique,
  access_expires_at  timestamptz not null,
  refresh_hash       text not null unique,
  prev_refresh_hash  text unique,
  refresh_expires_at timestamptz not null,
  created_at         timestamptz not null default now(),
  last_used_at       timestamptz,
  revoked_at         timestamptz
);

-- A sign-in started from an authorize request returns to it.
alter table admin_login_tokens add column pending_id uuid;
