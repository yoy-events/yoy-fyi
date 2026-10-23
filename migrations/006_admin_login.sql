-- Single-use admin sign-in links. Only a sha256 of the token is stored.
create table admin_login_tokens (
  token_hash text primary key,
  expires_at timestamptz not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);
