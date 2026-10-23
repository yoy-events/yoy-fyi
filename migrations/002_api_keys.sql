create table api_keys (
  id           uuid primary key,
  service_id   uuid not null references services(id),
  prefix       text not null unique,
  secret_hash  text not null,
  scopes       text[] not null,
  name         text not null,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

create index api_keys_service_id_idx on api_keys (service_id, id desc);
