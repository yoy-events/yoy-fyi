-- Use through AI assistants: every MCP tool call, and the OAuth client that created a link.
alter table links add column created_by_client text;

create table mcp_calls (
  id         uuid primary key,
  at         timestamptz not null,
  service_id uuid not null,
  client     text, -- the OAuth client_id; null for an API key
  tool       text not null,
  ok         boolean not null,
  ms         integer not null
);
create index mcp_calls_at_idx on mcp_calls (at);
