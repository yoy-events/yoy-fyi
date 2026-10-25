# ADR-0003: Agent access over MCP, with OAuth for claude.ai and ChatGPT

- Status: accepted (2026-10-24)
- Date: 2026-10-24
- Decider: Roman
- Input: [research report](../research/webmcp-and-mcp.md), 2026-10-23
- Changes ADR-0001: reserved paths, auth model (a second credential type), data model, rate limits, logging, admin pages.

## Context

Agents should be able to create short links and read their analytics. Roman wants this to work in claude.ai and ChatGPT chat, not only in Claude Code. Neither chat client accepts a static API key, so they need an OAuth 2.1 authorization server. WebMCP is a Chromium-only origin trial, and its only consumers are a few in-browser agents.

## Decision

### Endpoint

- `POST /mcp` in the same Hono app, using Streamable HTTP, **stateless**: JSON responses, no SSE, no session ids. `GET` and `DELETE` on `/mcp` answer 405.
- The resource URI is `PUBLIC_ORIGIN + "/mcp"`. The test app gets `https://test.yoy.fyi/mcp` without a new domain literal.
- **A small hand-written JSON-RPC handler, not the MCP SDK.** Stateless tools-only MCP needs four methods (`initialize`, `notifications/initialized`, `tools/list`, `tools/call`) plus `ping`. The SDK's v1/v2 split and its Hono support are unconfirmed (research §5), and the brief prefers minimal code over a new dependency. `initialize` answers protocol versions `2025-06-18` and `2025-11-25`. 2026-07-28 support follows once a real client sends it.
- If an `Origin` header is present and is not `PUBLIC_ORIGIN`, the request is rejected (403). Server-side clients send none.
- No resources, prompts, sampling, elicitation or subscriptions.

### Tools

Tools dispatch in-process through the `/v1` router with the caller's own credential: an in-memory `request`, not a network call. Target validation, the 404-not-403 tenant rule, idempotency, scopes and rate limits are therefore identical by construction. `created_via: "mcp"` travels as a router binding, which a client request cannot set. (The first draft said "the same functions"; dispatching through the router needs no refactor and cannot drift.)

| Tool | Scope | readOnly | destructive | idempotent |
|---|---|---|---|---|
| `whoami` | any | true | false | true |
| `list_links` (limit default 20, max 50) | links:read | true | false | true |
| `get_link` (by id or code) | links:read | true | false | true |
| `get_click_timeseries` (hourly ≤ 7 days) | analytics:read | true | false | true |
| `get_click_breakdown` (limit default 10) | analytics:read | true | false | true |
| `create_link` (optional `idempotency_key`, `external_ref`) | links:write | false | false | true |
| `update_link` | links:write | false | true | true |
| `disable_link` | links:write | false | true | true |

- **Annotations and output.** Every tool has a `title`, all four hints as explicit booleans, and `openWorldHint: false`. Each returns `structuredContent` plus a short JSON text and declares an `outputSchema`.
- **Descriptions.** These state what the tool does and nothing more. No instructions to the model.
- **Never exposed to agents:** API keys, webhooks, raw clicks, visitor hashes and IPs. Agents see rollups only, as `/v1` does.

### Credentials

- `/mcp` accepts both an existing `yfi_` API key and a new OAuth access token `yfo_<43 random base64url>` (refresh tokens are `yfr_…`). Both resolve to `(service_id, scopes)`. OAuth tokens are stored only as sha256 hashes and looked up by hash.
- `/v1` never accepts `yfo_` tokens: their audience is `/mcp`. Tools reach `/v1` in-process with the resolved caller as a router binding.
- OAuth can grant only `links:read`, `links:write` and `analytics:read`. `keys:manage` and `webhooks:manage` are never grantable through OAuth.
- A call with no token gets 401 with `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp"`. A call missing a scope gets 403 `insufficient_scope`, listing every required scope in one challenge.

### OAuth 2.1 authorization server (issuer `PUBLIC_ORIGIN`)

- **Discovery.**
  - `/.well-known/oauth-protected-resource/mcp` contains `resource` (exact), one `authorization_servers` entry, and `scopes_supported` with the three scopes above.
  - `/.well-known/oauth-authorization-server` contains `S256` only, `token_endpoint_auth_methods_supported: ["none"]`, `client_id_metadata_document_supported: true` and `authorization_response_iss_parameter_supported: true`.
- **Client registration.** Client ID Metadata Documents only; no dynamic registration.
  - The `client_id` URL is fetched through the webhook SSRF guard: https on port 443, public addresses only, 5 s timeout and a 64 KB cap. The result is cached in `oauth_clients`.
  - The `client_id` host must be on an allowlist of registrable domains: `claude.ai`, `claude.com`, `anthropic.com`, `chatgpt.com`, `openai.com`. A refused host is logged, so a new legitimate one shows up before it is added.
  - Only redirect URIs the document declares are accepted, compared exactly. Loopback redirects (`localhost`, `127.0.0.1`) match on any port, for Claude Code. Expected: `https://claude.ai/api/mcp/auth_callback` and `https://chatgpt.com/connector_platform_oauth_redirect`.
- **`GET /oauth/authorize`.**
  - Requires the admin session. Without one, the request is stored server-side and the magic-link login resumes it after sign-in.
  - The consent page shows the client name and the redirect host. Roman picks **one service** and ticks scopes; `links:write` starts unticked.
  - The code lasts 60 s, is single use, stored hashed, and bound to the client, redirect URI, PKCE challenge, `resource` and the chosen scopes.
  - Every response, errors included, carries `code`/`error`, `state` and `iss`.
- **`POST /oauth/token`.**
  - Form-encoded, with `authorization_code` plus PKCE and `refresh_token` grants. Any `resource` other than `<origin>/mcp` is rejected.
  - Access tokens live 1 h. Refresh tokens rotate on every use and live 60 days. Reusing an old refresh token revokes the whole grant. A dead refresh token gets `invalid_grant`.
- **The OAuth user is always Roman.** He signs in with the existing admin magic link. A grant belongs to one service. No users table is added.
- **Admin page "Connected apps".** It lists grants (client, service, scopes, last used) with a Revoke button.
- **Consent page CSP.** It drops `form-action 'self'`, because Chrome applies `form-action` to the redirect after the POST, which would block the hop to claude.ai or chatgpt.com. Its CSP otherwise matches the admin pages.

### Data model

```text
links.created_via   text not null default 'api'   -- api | admin | mcp
oauth_clients       client_id (url) pk, name, redirect_uris text[], fetched_at
oauth_codes         code_hash pk, client_id, service_id, scopes text[], redirect_uri,
                    code_challenge, resource, expires_at, used_at
oauth_grants        id, client_id, service_id, scopes text[], access_prefix unique,
                    access_hash, access_expires_at, refresh_hash, refresh_expires_at,
                    created_at, last_used_at, revoked_at
oauth_pending       id pk, request jsonb, expires_at   -- authorize requests waiting for login
```

`created_via` lets every agent-created link be found and disabled at once if a prompt injection slips through. The `Link` schema gains a read-only `created_via`.

### Rate limits and logging

- `/mcp`: 120/min per credential. `create_link` also uses the existing link-create bucket.
- `/oauth/authorize`: 30/min per IP. `/oauth/token`: 20/min per IP.
- Logs redact `yfo_` tokens and the `code`, `code_verifier` and `refresh_token` fields. Tool calls log the tool name, service and outcome, never the arguments.

### Reserved paths

`mcp`, `oauth` and `.well-known` join the reserved codes. `.well-known` cannot match the code pattern anyway, but it is routed explicitly.

### Delivery

The CI smoke step checks that an unauthenticated `POST /mcp` answers with the `WWW-Authenticate` resource-metadata challenge. A `tools/list` smoke with a stage key comes with slice 2, when the test stage gets one.

### Slices

1. **`/mcp` with `yfi_` keys:** the 8 tools, a 401 pointing at the protected-resource metadata, the Origin check, `created_via`, rate limits and redaction. It works in Claude Code and the Claude API connector. About 3 days.
2. **OAuth:** metadata, CIMD fetch, authorize and consent with login resume, token with refresh rotation, the Connected apps page, then end-to-end in claude.ai, Claude Code over OAuth and ChatGPT custom MCP. About 4–6 days.

## Not now

- **Directory listings** in Claude or ChatGPT. ChatGPT test accounts may not use magic links, and listing needs a privacy policy, terms of service and verification.
- **WebMCP.** It is a Chromium origin trial. The cheap later step is the declarative `toolname` on two admin forms.
- **MCP Apps UI, ChatGPT deep-research `search`/`fetch`, and QR tools.**

## Consequences

- One process serves redirects, `/v1`, `/admin`, `/mcp` and OAuth. A bug in OAuth code sits next to the redirect path, so its tests carry the same weight.
- Agents can create links that point anywhere the target policy allows. Mitigations: write tools need client confirmation, `links:write` starts unticked, and `created_via` supports bulk disable.
- The hand-written MCP handler has to keep up with protocol changes. It is small, and the SDK remains an option if the protocol grows.

## Open questions

1. Is the OAuth user always only Roman? If owners of other services should connect themselves, yoy.fyi needs user accounts, which is a different data model.
2. Should agents write from day one (`create_link`, `update_link`, `disable_link`), or should slice 1 ship read-only tools first?

## Amendment (2026-10-25): revocation, step-up, remembered consent

- `POST /oauth/revoke` (RFC 7009, public clients): either token of a grant revokes the whole grant, only for the grant's own `client_id`; the answer is always 200.
- A tool call whose scope the OAuth grant lacks answers HTTP 403 with `WWW-Authenticate: Bearer error="insufficient_scope", scope="…"` (the held scopes plus the missing one), so the client can ask the user again. API keys keep the plain tool error, since they cannot be stepped up.
- A signed-in user who already holds an active grant for the same client with all the requested scopes, and already approved this exact https redirect URI, gets a code without the consent page. Loopback redirects always show consent, since any program on the computer can claim a client's name there. The admin always sees consent, because the admin picks a service each time.
- Refresh tokens rotate within 60 days, and a connection ends 90 days after it was approved however often it is refreshed.
- The consent page warns when the redirect goes to localhost. `/account/apps` shows each connection's calls in the last 30 days and its latest tools, and has Disconnect all.

## Amendment (2026-10-25): any MCP client

- Client ID Metadata Documents are accepted from any https host. Hosts on the known list (claude.ai, claude.com, anthropic.com, chatgpt.com, openai.com) are shown as known apps; any other host is marked on the consent page as unverified, with its domain. Claude Code uses `https://claude.ai/oauth/claude-code-client-metadata` with localhost callbacks.
- `POST /oauth/register` (RFC 7591) registers public clients without a metadata document, such as Cursor. Redirects must be https, http on localhost, or a private-use scheme (not javascript:, data:, file: and the like), without a fragment; at most 10; 10 registrations per hour per address. They get a `dcr_` client id, are always marked unverified, never get silent consent, and are deleted after a day if no connection used them.
