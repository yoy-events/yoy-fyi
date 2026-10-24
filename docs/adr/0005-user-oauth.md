# ADR-0005: Any user can connect claude.ai or ChatGPT

- Status: accepted (2026-10-24)
- Decider: Roman
- Changes ADR-0003 and ADR-0004: OAuth for MCP is no longer admin-only.

## Context

ADR-0004 kept OAuth consent admin-only, so a regular user could reach `/mcp` only with a `yfi_` key. claude.ai and ChatGPT connectors sign in with OAuth, not with a pasted key, so in practice nobody but Roman could work with yoy.fyi from a chat. Roman wants that first among the next features.

## Decision

- **Who can approve:** the admin (as before) or any signed-in, not blocked user. If both sessions are present, the admin's wins.
- **What a user can grant:** only their own personal service. The consent page lists nothing else, and a POST naming another service is refused.
- **Signing in from the consent flow:** the authorize page offers Sign in with Google (the user flow from ADR-0004). After Google, the user returns to the same pending request. The admin email link stays under "Admin sign-in".
- **Scopes:** unchanged (`links:read`, `analytics:read`, `links:write`; writing starts unticked).
- **Revoking:** a user sees and revokes their own connections at `/account/apps`. The admin still sees all of them under Connected apps.
- **Blocking:** blocking a user disables their personal service, so their OAuth tokens stop working at once (the token check already requires an active service).

## Consequences

- Chat agents can create links for anyone with a Google account, so the abuse controls from ADR-0004 (target policy, per-service create limit, blocking) now cover MCP too. MCP has its own per-caller rate limit.
- No new tables: grants already belong to a service.
