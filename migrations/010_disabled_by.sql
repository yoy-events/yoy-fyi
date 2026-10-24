-- Who disabled a link: its owner (web, API, MCP), the admin, or the Safe Browsing rescan.
-- An owner may re-enable only what an owner disabled; links disabled before this column are null.
alter table links add column disabled_by text check (disabled_by in ('owner', 'admin', 'safe_browsing'));
