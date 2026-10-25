-- OAuth clients registered through Dynamic Client Registration (RFC 7591), next to the ones read
-- from Client ID Metadata Documents.
alter table oauth_clients add column kind text not null default 'cimd' check (kind in ('cimd', 'dcr'));
alter table oauth_clients add column created_at timestamptz not null default now();
