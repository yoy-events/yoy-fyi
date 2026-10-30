-- Links created by a browser's built-in agent through WebMCP (/static/webmcp.js).
alter table links drop constraint links_created_via_check;
alter table links add constraint links_created_via_check check (created_via in ('api', 'admin', 'mcp', 'web', 'telegram', 'webmcp'));
