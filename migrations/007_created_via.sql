-- Where a link was created, so agent-created links can be found and disabled together (ADR-0003).
alter table links add column created_via text not null default 'api'
  check (created_via in ('api', 'admin', 'mcp'));
