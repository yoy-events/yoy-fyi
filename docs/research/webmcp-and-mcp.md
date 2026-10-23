# Exposing yoy.fyi to AI agents: WebMCP, Claude connectors, ChatGPT

- Status: research, not a decision. Nothing here changes ADR-0001 until Roman accepts it.
- Date: 2026-10-23. All sources were read on 2026-10-23 (list in section 8).
- Inputs read: `docs/adr/0001-architecture.md`, `openapi.yaml` (1.0.0-draft).

## 1. Summary

Build one remote MCP server at `https://yoy.fyi/mcp` inside the existing Hono process. It calls the same service layer as `/v1`, so target validation, tenant filtering and rate limits are shared rather than copied. It exposes eight tools: five read tools (links and analytics) and three write tools (create, update, disable link). It never exposes keys or webhooks.

Ship it in two steps:

- **Phase 1 (about 3 days):** `/mcp` accepts the existing `yfi_` keys as bearer tokens. That covers Claude Code, the Claude API MCP connector and agent SDKs.
- **Phase 2 (about 4–6 days):** a small OAuth 2.1 authorization server in the same app. claude.ai, Claude Desktop/mobile and ChatGPT cannot use a static API key (ChatGPT does not support one; on claude.ai it is a beta limited to some organizations), so this step is needed only if those clients matter. Roman logs in with the existing magic link, then a consent page chooses one service and its scopes. The token that comes out carries the same `(service_id, scopes)` as an API key.
- **Deferred:** directory listings, MCP Apps UI and WebMCP. They add review work and churn for a single-operator service and give little back today.

## 2. WebMCP

**What it is.** WebMCP is a browser API. A web page registers JavaScript functions as "tools", and an agent running in the browser can call them. The page and the user's session do the work, so no backend MCP server is involved.

**Status**

| Item | State | Source |
|---|---|---|
| Spec | Draft Community Group Report, Web Machine Learning CG, dated **20 Oct 2026**. "Not a W3C Standard nor on the Standards Track." Editors are from Microsoft (Walderman, Dallstream) and Google (Sagar, Farolino). | [S1] |
| Repo | `webmachinelearning/webmcp`, marked experimental. First published 13 Aug 2025 and "evolved significantly" since. About 124 open issues. | [S2] |
| Chrome | Origin trial from **Chrome 149**. For local testing, use `chrome://flags/#enable-webmcp-testing`. Overview page last updated 7 Oct 2026. | [S3], [S4] |
| Edge | Origin trial from Edge 150 | [S4] |
| Firefox, Safari | Only standards-position issues. No implementation. | [S4] |
| Tool consumers | ChatGPT Desktop (its built-in browser), Brave Leo (experimental), Meta Ray-Ban Display (coming soon). Chrome's docs name only test extensions (Model Context Tool Inspector, an example agent extension) and state that these are separate from Gemini in Chrome. | [S3], [S4] |
| Trial end and ship date | **Unclear.** Blink-dev approved an experiment for M149–156. A third-party post claims an extension to M162 and an intended Intent to Ship. I could not confirm that from a Chrome source. | [S5], [S6] (blog, unverified) |

**The API changed recently.** Older tutorials and the original explainer use `navigator.modelContext` and `provideContext()`. The current spec has `document.modelContext` only [S1]. Third-party posts say Chrome 150 deprecated the old spelling [S6]. The spec does not define `requestUserInteraction()`, although Chrome's security page still mentions it as a draft idea [S7]. Build only against the current spec.

**API shape (spec, 20 Oct 2026) [S1]**

- `document.modelContext.registerTool(tool, { signal, exposedTo })`. Aborting the signal unregisters the tool. `exposedTo` lists other origins that may see it. By default only the same origin can.
- Fields on `tool`:
  - `name`: 1–128 characters from `[A-Za-z0-9_.-]`.
  - `title`: optional.
  - `description`.
  - `inputSchema`: JSON Schema.
  - `execute(input, { signal })`: returns a Promise.
  - `annotations { readOnlyHint, untrustedContentHint, consequentialHint, debugging }`: each defaults to false.
- `getTools({ fromOrigins })` and `executeTool(tool, input, { signal })` serve the consumer side. Events: `toolchange`, `toolactivated`, `toolcancel`.
- The Permissions Policy feature `tools` defaults to `'self'`. Cross-origin iframes need `allow="tools"`. `Permissions-Policy: tools=()` turns the API off for a document.
- **Declarative API** (Chrome docs, updated 25 Sep 2026) [S8]:
  - Add `toolname` and `tooldescription` to a `<form>`. `toolparamdescription` on fields is optional.
  - The agent fills the form and the form stays visible. **Without `toolautosubmit`, the user must click Submit.**
  - `SubmitEvent.agentInvoked` and `respondWith()` return a result to the agent.

**Security guidance**

- **Spec §6, non-normative [S1].** It lists these threats:
  - prompt injection through descriptions, outputs and the tool implementation
  - misrepresented intent
  - privacy leakage from over-parameterised tools
  - same-origin violations
  - private browsing

  Its mitigations are the `tools=()` policy, input length limits, shared attack evals, `untrustedContentHint`, `consequentialHint` (clients may require user confirmation), and agent-side guardrails. The spec also warns that sites can omit hints or state them wrongly.
- **Chrome "WebMCP tool security" (updated 1 Sep 2026) [S7]:**
  - Mark irreversible actions `consequentialHint: true`.
  - Mark user-generated output `untrustedContentHint`.
  - Keep tools same-origin unless you trust the other origin.
  - Extensions with host permissions can call tools anyway.
  - Budgets: description under 500 characters, parameter description under 150, names under 30, output under about 1.5K.
- **What WebMCP does not do.** Tools run with the user's logged-in session in the page. WebMCP adds no authentication of its own, and Chrome's page gives no guidance on auth, CSP or third-party scripts [S7].

## 3. Claude: remote MCP servers and the Connectors Directory

Sources: Anthropic's connector docs at claude.com/docs (current pages; none carries a date) [S9]–[S12], and Claude Code docs [S13].

**Transport.** Use Streamable HTTP. Claude still supports legacy HTTP+SSE, but that transport is being deprecated [S9]. Claude Code's docs call SSE deprecated [S13].

**Protocol and auth spec versions.** Claude follows the **2025-03-26, 2025-06-18 and 2025-11-25** authorization specs [S9]. The docs do not mention 2026-07-28; see section 5.

**Supported auth types [S10]**

| Type | Availability |
|---|---|
| `oauth_dcr` (RFC 7591) | Default |
| `oauth_cimd` (Client ID Metadata Document) | Default |
| `oauth_anthropic_creds` (you give Anthropic a confidential client) | Via the developer portal |
| `custom_connection` (client entered at connect time) | On request |
| `static_headers` (API key in a header, entered by an org Owner) | **Beta, limited set of organizations** |
| `none` | Default; "lazy auth" allows mixed open and protected tools |

A machine-to-machine `client_credentials` grant is **not supported** [S10].

Claude Code can add an HTTP server with a static header, for example `claude mcp add --transport http … --header "Authorization: Bearer …"` [S13]. The Claude API MCP connector also takes a bearer token.

**Where Claude's OAuth client is stricter than the spec [S10]**

- A `401` with `WWW-Authenticate: Bearer resource_metadata="…"` is required to start sign-in. Claude ignores `WWW-Authenticate` on a 200.
- The protected resource metadata `resource` must equal the server URL **exactly**, including the path.
- Only the **first** entry of `authorization_servers` is used.
- CIMD is used only if AS metadata has `client_id_metadata_document_supported: true` **and** `"none"` in `token_endpoint_auth_methods_supported`. Otherwise Claude falls back to DCR. Claude registers a new DCR client on every fresh connection, so prefer CIMD.
- PKCE is always S256. Advertise `code_challenge_methods_supported: ["S256"]`.
- Scopes come from `scope` in the 401 challenge, or else from PRM `scopes_supported`. Claude appends `offline_access` if the AS lists it.
- Redirect URIs:
  - `https://claude.ai/api/mcp/auth_callback` for web, Desktop, mobile and Cowork.
  - For Claude Code, loopback `http://localhost:*/callback` and `http://127.0.0.1:*/callback`, matched **port-agnostic**.
- The token endpoint must accept `application/x-www-form-urlencoded`. Return `invalid_grant` for a dead refresh token. Rotate refresh tokens for public clients. Claude refreshes on 401 and up to 5 minutes before expiry.
- Timeouts: 10 s for discovery, registration and token endpoints; 30 s for refresh.
- Egress comes from `160.79.104.0/21`.

**Features and limits [S9]**

- Claude supports tools, prompts, resources, and text and image results.
- It does **not** support resource subscriptions, sampling, or "advanced or draft capabilities".
- Maximum tool result: about **150,000 characters** on claude.ai and Desktop. Claude Code defaults to **25,000 tokens** (`MAX_MCP_OUTPUT_TOKENS`), warns above 10k tokens, and spills results over 50k characters to a file [S13].
- Tool call timeout: **240 s**.

**Tool design and review [S11], [S12]**

- Every tool needs a `title` and `readOnlyHint: true` or `destructiveHint: true`. These drive auto-permission: read-only tools can run without confirmation, and destructive tools always prompt.
- Read and write must be separate tools. A catch-all `api_request` tool with a `method` parameter is rejected.
- Tool names must be 64 characters or fewer. Descriptions must be narrow and accurate.
- Descriptions must not contain prompt-injection patterns: telling Claude how to behave, steering it toward other tools, or hidden instructions.
- Tools must return actionable errors, keep responses sized to the task, and collect no conversation data beyond what the tool needs.
- The API must be first-party, and the domain should match the service.
- No money-movement connectors.
- Submission:
  - Done through `claude.ai/directory/manage` on any paid plan.
  - Needs documentation URL, privacy policy URL, support contact, icon, and **test credentials for a fully populated account**.
  - Has seven compliance acknowledgements.
  - An automated scan then lists the connector as **Community**. Some listings are escalated to a **Verified** review.
- A custom connector (the user pastes the URL) needs **no review** [S9].

**MCP Apps.** Claude renders MCP Apps (interactive UI through `_meta.ui.resourceUri` and `ui://` resources). It is optional. Directory submissions that use it need 3–5 carousel screenshots [S9], [S11].

## 4. ChatGPT: Apps SDK, plugins and custom MCP

OpenAI's docs now say **"plugins"** throughout, covering ChatGPT and Codex. Older pages and URLs say "apps" or "connectors" [S14]–[S18]. None of the pages I read shows a date.

**Adding a server [S16]**

- Go to Plugins → "+" → "Add custom MCP server". Developer Mode no longer has to be switched on first [S19].
- Transports: SSE and streaming HTTP.
- Auth: OAuth, none, or "OAuth or none" (mixed).
- Tools **without `readOnlyHint` are treated as writes and need confirmation**. The user can remember an approval for the rest of the conversation.
- Server `instructions`: the first 512 characters matter.
- **Which plans can use this is unconfirmed.** The help-center article returned 403 to my fetch, and older forum posts disagree.

**Auth [S15]**

- OAuth 2.1 authorization code with PKCE. **S256 must be advertised**, or the server is unsupported.
- Needs PRM (`/.well-known/oauth-protected-resource` or the 401 pointer) and RFC 8414 or OIDC AS metadata.
- ChatGPT sends `resource`. Bind it to the token audience.
- Client registration:
  - **CIMD preferred**, with `none` or `private_key_jwt`.
  - DCR supported; ChatGPT registers once per connection.
  - Predefined clients are also possible.
- **No API keys:** "ChatGPT doesn't support … custom API keys". Machine-to-machine grants are not supported either. User auth must be OAuth.
- Redirect URI:
  - `https://chatgpt.com/connector_platform_oauth_redirect` **if** the AS supports RFC 9207. That means advertising `authorization_response_iss_parameter_supported: true` and returning `iss` in every response, errors included.
  - Otherwise, a per-connector URL `https://chatgpt.com/connector/oauth/{callback_id}`.
- Per-tool `securitySchemes` (`noauth` and/or `oauth2` with scopes). For a missing token, return an error result with `_meta["mcp/www_authenticate"]`. The account-linking UI appears only when both the metadata and this runtime challenge are present.
- Optional client identification: an OpenAI mTLS client certificate, or published egress IPs.

**Tools [S14], [S17]**

- `readOnlyHint`, `destructiveHint` and `openWorldHint` must **all be explicit booleans**:
  - `destructiveHint: true` for delete, overwrite, cancel, revoke and irreversible sends. "Undoable" does not justify `false`.
  - `openWorldHint: false` for a bounded private account.
- Names should be verb-based. Descriptions must state purpose, when to use the tool, its limits and its side effects.
- No generic executor tools.
- Responses: `structuredContent` (concise, stable ids) plus `content` text. Omit internal ids and diagnostics. Make tools safe to retry, or say clearly when they are not.

**Deep research and company knowledge [S18]**

- These need two read-only tools named exactly `search(query)` → `{results:[{id,title,url}]}` and `fetch(id)` → `{id,title,text,url,metadata?}`.
- Return them as `structuredContent` and also as a JSON string in `content`.
- This is still current for those two features. Ordinary chat use does not need it.

**UI.** ChatGPT "implements the open MCP Apps standard" (`_meta.ui.resourceUri`, `ui/*` bridge). `openai/outputTemplate` and `window.openai` remain as compatibility aliases [S20]. Embedded pages must come from the server's own registrable domain [S17].

**Submission [S17], [S21]**

- Submitter: an organization owner, or a member with Apps Management Write.
- Requires:
  - individual or business verification
  - a domain challenge at `/.well-known/openai-apps-challenge`
  - website, support, privacy and ToS URLs
  - icons
  - 5 positive and 3 negative test cases
  - a demo video
- The portal does not support API-key, Basic or custom-header auth.
- **Test accounts must work without MFA, email or SMS codes, or magic links.**
- Content rules: no ads, users 13+, a privacy policy with retention details, data minimisation, no covert tracking.

## 5. Where they agree and where they conflict

| Topic | MCP spec 2026-07-28 | Claude | ChatGPT | WebMCP |
|---|---|---|---|---|
| Transport | Streamable HTTP. **Stateless**: no `initialize`, no `Mcp-Session-Id`, no GET stream; `Mcp-Method`/`Mcp-Name` headers required; HTTP+SSE deprecated [S22], [S23] | Streamable HTTP; SSE still accepted | SSE and streaming HTTP | In-page JS; no network protocol |
| Spec version cited | 2026-07-28 (latest) | Auth specs 2025-03-26 to **2025-11-25** | Links 2025-11-25, plus 2026-07-28 for `iss` | n/a |
| Client registration | **CIMD SHOULD; DCR deprecated** (kept for compatibility) [S24] | CIMD (if both flags are set), else DCR, or Anthropic-held client | CIMD preferred, DCR, predefined | n/a |
| Static API key | Not covered; tokens only from the server's AS, and they must be audience-bound | Claude Code: yes. claude.ai: beta, limited orgs | **No** | Uses the page's own session |
| PKCE / `resource` / `iss` | S256; `resource` MUST; AS SHOULD send `iss` | S256 required | S256 required; `iss` gives the stable redirect URI | n/a |
| Redirect URI | n/a | `claude.ai/api/mcp/auth_callback` + loopback on any port | `chatgpt.com/connector_platform_oauth_redirect` (with `iss`) | n/a |
| Annotations | `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` are hints and untrusted | `title` + read-only or destructive hint **required** | All three booleans **required and explicit** | Different names: `readOnlyHint`, `consequentialHint`, `untrustedContentHint` |
| Result size | n/a | ~150k chars (web); 25k tokens (Claude Code) | No number published | About 1.5K chars recommended |
| UI | MCP Apps extension | MCP Apps | MCP Apps (plus legacy `openai/*`) | The page itself is the UI |
| Directory test account | n/a | Fully populated account | Must **not** need magic links or MFA | n/a |
| Prompt-injection rules for descriptions | Hints are untrusted | Explicit rejection list | Explicit rules (no steering, no broad triggering) | Threat model in §6 |

They agree on:

- Streamable HTTP
- OAuth 2.1 with PKCE S256 and protected resource metadata
- CIMD as the preferred way to register clients
- separate read and write tools, each annotated
- narrow, honest descriptions
- small, relevant responses

They conflict, or are unclear, on three points:

1. **API keys.** They work in Claude Code and on the API, are beta on claude.ai, and are unsupported in ChatGPT. Any browser-chat client needs OAuth.
2. **Protocol version.** The latest MCP spec dropped sessions and `initialize`, but Claude's docs still cite 2025-xx auth specs. I could not confirm which wire version claude.ai and ChatGPT send today. The server must therefore speak the legacy shape (an `initialize`-based 2025-06-18/2025-11-25 Streamable HTTP, run statelessly). Ideally it also speaks 2026-07-28 ("dual-era" in the spec [S25]). The official TypeScript SDK v2 targets 2026-07-28 and reportedly has a Hono adapter and serves v1 clients. Its stability and backward compatibility are **unconfirmed**; secondary sources disagree [S26].
3. **Annotation vocabulary.** Set all four MCP hints explicitly on every tool. That satisfies both Claude and OpenAI. WebMCP uses different names.

## 6. Recommendation for yoy.fyi

### 6.1 Shape

- **Endpoint:** `POST https://yoy.fyi/mcp`, in the same Hono app and process. The resource URI is `PUBLIC_ORIGIN + "/mcp"`, so the test app gets `https://yoy-fyi-test.fly.dev/mcp` with no new domain literal.
- **Transport:** Streamable HTTP, **stateless**.
  - JSON responses, no SSE (no tool is long-running).
  - No session ids. GET and DELETE on `/mcp` return 405.
  - Answer the legacy `initialize` so current Claude and ChatGPT clients work.
  - Add 2026-07-28 support (`server/discover`, `_meta` versioning, header checks) when the SDK version in use supports it.
  - Do not implement the deprecated HTTP+SSE transport.
- **Origin check:** reject any request whose `Origin` header is present and is not on an allowlist (spec MUST [S23]). Server-side clients usually send no `Origin`.
- **Implementation:**
  - Tools call the **service functions** behind `/v1`, not HTTP loopback. Target URL validation, the 404-not-403 tenant rule, idempotency and rate limits are then identical by construction.
  - Every result returns `structuredContent` plus a short JSON text `content`, and declares an `outputSchema`.
- **No resources, prompts, sampling, elicitation or subscriptions in v1.** Claude does not support some of them anyway [S9].

### 6.2 Tools

All tools have `openWorldHint: false`. They act on one service's bounded data. The short link is public, but that is the product, not an open-ended target. This is a judgment call; OpenAI's definition fits `false`.

| Tool | Maps to | Scope | readOnly | destructive | idempotent | Notes |
|---|---|---|---|---|---|---|
| `whoami` | `getMe` | any | true | false | true | Service name and scopes, so the agent knows what it can do |
| `list_links` | `listLinks` | links:read | true | false | true | Default `limit` 20, max 50 for MCP. Supports all `/v1` filters |
| `get_link` | `getLink` (by id **or** code) | links:read | true | false | true | Accepting a code saves a list call |
| `get_click_timeseries` | `getTimeseries` | analytics:read | true | false | true | Caps output: hourly ≤ 7 days via MCP (31 in `/v1`) to stay far under 25k tokens |
| `get_click_breakdown` | `getBreakdown` | analytics:read | true | false | true | Default `limit` 10 |
| `create_link` | `createLink` | links:write | false | false | true | Optional `idempotency_key` and `external_ref` args. The description says repeats with the same key return the same link |
| `update_link` | `updateLink` | links:write | false | **true** | true | Changing `target_url` overwrites where an existing, possibly printed link goes |
| `disable_link` | `disableLink` | links:write | false | **true** | true | Codes are never reused, so treat it as irreversible |

Every tool also gets a `title`, for example "List short links".

**Not exposed over MCP:**

- **`keys:*`:** the tool would hand a secret to the model. OpenAI also forbids collecting credentials [S17].
- **`webhooks:*`:** registering a URL that receives every click is an exfiltration and SSRF lever if an injected agent controls it.
- **QR codes:** these could come later as image content. `/v1` already serves them.
- **Raw clicks:** MCP sees rollups only, as `/v1` does. No visitor hash, IP or per-click rows, which keeps it inside the ADR's PII rule.

Do not add `search`/`fetch` unless Roman wants ChatGPT deep research over links. Nothing in `/v1` supports free-text search today.

### 6.3 Auth

**Phase 1: API keys on `/mcp`**

- `Authorization: Bearer yfi_…` resolves through the same lookup as `/v1`. That gives the service and scopes.
- Tools whose scope is missing return an MCP tool error naming the missing scope.
- Calls with no token return `401` with `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp"`.
- PRM is served even in phase 1, so phase 2 needs no client-visible change.
- Clients this covers:
  - Claude Code (`claude mcp add --transport http yoy https://yoy.fyi/mcp --header "Authorization: Bearer $YFI_KEY"`)
  - the Claude API MCP connector
  - Agent SDK and any MCP client in Roman's own apps
- Spec reading: yoy.fyi issues both the keys and the resource, so this is not token passthrough. The audience is the service by construction. An org Owner on claude.ai could also use `static_headers` once that beta is available to them.

**Phase 2: a minimal OAuth 2.1 AS (issuer `PUBLIC_ORIGIN`)**

This is needed only for claude.ai, Desktop, mobile and ChatGPT.

1. **Discovery.**
   - `/.well-known/oauth-protected-resource/mcp` contains `resource: "<origin>/mcp"` (exact), `authorization_servers: ["<origin>"]` (one entry) and `scopes_supported: ["links:read","analytics:read","links:write"]`.
   - `/.well-known/oauth-authorization-server` contains `code_challenge_methods_supported: ["S256"]`, `token_endpoint_auth_methods_supported: ["none"]`, `client_id_metadata_document_supported: true` and `authorization_response_iss_parameter_supported: true`.
   - Do not list `offline_access` in PRM [S24].
2. **Client registration: CIMD only, no DCR.**
   - Claude (hosted and Claude Code) and ChatGPT both use CIMD when both flags are advertised [S10], [S15]. DCR is deprecated in the spec [S22].
   - Fetching a `client_id` URL is an outbound request chosen by the caller. Run it through the **same SSRF guard as webhook URLs**: HTTPS only, resolved IP not private, 5 s timeout, small size cap. Cache the result.
   - Also keep an **allowlist of client-id hosts** (`claude.ai`, `chatgpt.com`/OpenAI's CIMD host — confirm the exact hosts on the first real connect) to fit a single-operator service.
   - Accept only the redirect URIs the document declares: the Claude callback, loopback on any port for `localhost`/`127.0.0.1`, and the ChatGPT stable callback.
3. **`GET /oauth/authorize`.**
   - Requires the admin session cookie. If it is missing, store the pending request server-side and send the magic link. After login, resume the stored request.
   - The consent page shows the client name and the redirect host (a spec requirement). It lets Roman **pick one service** and tick scopes. `links:write` is unticked by default.
   - It issues a one-time code (60 s, hashed, bound to client, redirect URI, PKCE challenge and `resource`). It returns `code`, `state` and `iss`.
4. **`POST /oauth/token`.**
   - Form-urlencoded. Supports `authorization_code` with PKCE and `refresh_token`.
   - Rejects a `resource` that is not `<origin>/mcp`.
   - Access tokens are opaque, like `yfo_<prefix>_<secret>`, last about 1 h and are stored hashed, the same way as API keys.
   - Refresh tokens rotate on every use and live 30–90 days. Reuse of an old refresh token revokes the grant. A dead token returns `invalid_grant`.
   - Respond well under 10 s.
5. **Resource side.**
   - `/mcp` accepts `yfi_` keys and `yfo_` tokens. Both resolve to `(service_id, scopes)`.
   - Insufficient scope returns 403 `insufficient_scope` with every required scope in one challenge [S24].
   - For ChatGPT, also add tool-level `securitySchemes: [{type:"oauth2", scopes:[…]}]` and `_meta["mcp/www_authenticate"]` on auth errors [S15].
6. **Admin.** Add a "Connected apps" page that lists grants (client, service, scopes, last used) with Revoke.

The OAuth "user" is always Roman, and a grant is per service. This adds no users table and keeps the ADR's model of "a credential belongs to one service".

**A simpler alternative.** Skip phase 2 and use only Claude Code and SDK clients with API keys. Do this if claude.ai and ChatGPT chat access is not a real need. Section 7 asks this question.

### 6.4 Security rules carried over

- **Open redirect / phishing via agents.** Agent-created links pass the same target validation, and `create_link` is a write tool, so Claude and ChatGPT confirm it by default.
- **Rate limits.** `create_link` uses the existing link-create bucket (60/min per credential, burst 20).
- **Audit column.** Add a `created_via` column so links created by agents can be found and disabled in bulk if a prompt injection ever slips through.
- **Rate limits on `/mcp` overall:** 120/min per credential. `/oauth/token`: 20/min per IP. `/oauth/authorize`: 30/min per IP.
- **Logging.** Extend redaction to `yfo_` tokens and to the `code`, `code_verifier`, `refresh_token` and `client_assertion` fields. Never log tool arguments wholesale. They can contain target URLs with UTM data, so log the tool name, service and outcome.
- **CSP.** The consent page uses the admin CSP. Do **not** add `form-action 'self'`: Chrome applies `form-action` to the redirect after the consent POST, which would block the hop to `claude.ai`/`chatgpt.com`. Either omit `form-action` or list exactly those origins.
- **Descriptions.** Write tool descriptions as plain statements of what the tool does. No behavioural instructions, which both directories reject [S11], [S17].

### 6.5 WebMCP in the admin UI

**Not now.** The reasons:

- It is an origin trial in Chromium only, and the API changed this year.
- Its consumers are a few in-browser agents.
- The admin has one user, who will already have the remote MCP server.

If Roman wants to try it later, the cheap version is the **declarative API**: add `toolname`/`tooldescription` to the existing "create link" and "disable link" forms.

- It needs no JavaScript, so it fits `default-src 'self'` with no inline script.
- Without `toolautosubmit`, Roman still clicks Submit, which is a sound consent model.
- The CSRF token is already in the form.
- Production needs an origin-trial token in a header. Budget about half a day.

Until then nothing is needed. The admin has no third-party scripts, and `X-Frame-Options: DENY` already prevents cross-origin embedding.

### 6.6 Defer

- Directory listings (Claude, ChatGPT). See section 7, Q3.
- MCP Apps UI (an inline analytics chart). Both Claude and ChatGPT support the standard, so it is portable later.
- `search`/`fetch` for ChatGPT deep research.
- QR tools.
- Tasks extension, elicitation and subscriptions.

### 6.7 Effort (one developer)

| Work | Estimate |
|---|---|
| MCP endpoint (SDK wiring in Hono, stateless legacy + 2026-07-28 if the SDK supports it), 8 tools on the service layer, output caps, Origin check | 1.5–2 d |
| Phase 1 auth (API key, 401 + PRM), rate limits, log redaction | 0.5 d |
| Tests: `bun test` per tool (scope, tenant 404, validation errors, size caps); MCP Inspector; Claude Code connect | 1 d |
| **Phase 1 total** | **≈ 3 d** |
| OAuth AS: metadata, authorize + consent + magic-link resume, token + PKCE + refresh rotation + `iss`, CIMD fetch with SSRF guard and allowlist, 3 tables, admin "Connected apps" | 3–4 d |
| End-to-end on claude.ai custom connector, Claude Code OAuth, ChatGPT custom MCP; Playwright for consent page | 1–2 d |
| **Phase 2 total** | **≈ 4–6 d** |

### 6.8 Changes needed in ADR-0001 and contracts

**ADR-0001**

- **Reserved paths:** add `mcp`, `oauth` and `.well-known`. `.well-known` cannot match the code regex, but route it explicitly.
- **New section "Agent access (MCP)":**
  - endpoint, transport and protocol versions
  - the tool list and annotations from §6.2
  - "MCP exposes rollups only"
  - "keys and webhooks are not exposed to agents"
- **Auth model:**
  - A second credential type, the OAuth access token `yfo_…`, with the same `(service_id, scopes)` semantics as `yfi_` keys.
  - OAuth scopes reuse `links:read`, `links:write` and `analytics:read`. `keys:manage` and `webhooks:manage` can never be granted through OAuth.
  - Fix in passing: the ADR lists three scopes, but `openapi.yaml` also has `keys:manage` and `webhooks:manage`.
- **Data model** (phase 2):
  - `oauth_clients` (CIMD cache: client_id URL, name, redirect_uris, fetched_at)
  - `oauth_codes` (code_hash, client_id, service_id, scopes, redirect_uri, code_challenge, resource, expires_at, used_at)
  - `oauth_grants` (id, client_id, service_id, scopes, access_hash, access_expires_at, refresh_hash, refresh_expires_at, created_at, last_used_at, revoked_at)
  - Phase 1 adds `links.created_via text` (`api` | `mcp` | `admin`), with the credential id if wanted.
- **Rate limits:** add `/mcp`, `/oauth/token` and `/oauth/authorize`.
- **Secrets and logging:** add `yfo_` and the OAuth form fields to redaction.
- **Admin:**
  - The consent page and the "Connected apps" page.
  - The CSP note about `form-action`.
  - The magic-link login must resume a pending authorize request.
- **Delivery:** the CI smoke step also calls `tools/list` on `/mcp` with a test key.

**`openapi.yaml`**

- No change to `/v1` operations.
- Optional: add `created_via` to `Link` (read-only).
- Document `/mcp` and the OAuth endpoints in prose (`info.description` or a separate `docs/mcp.md`). They are not REST resources.

## 7. Open questions for Roman

1. **Which agent clients must work?** If only Claude Code and SDK clients in Roman's own apps, phase 1 is enough and no OAuth server gets built. If claude.ai or ChatGPT chat is required, phase 2 is required.
2. **Who is the OAuth "user"?** The proposal assumes only Roman ever signs in, with the admin magic link, and picks a service on the consent screen. If owners of other services (YOY, Diduny, mnfaktr-lms) should connect on their own, yoy.fyi needs user accounts. That is a different data model.
3. **Will yoy.fyi ever be listed in the Claude or ChatGPT directories?** Listing implies:
   - a public product with sign-up
   - a privacy policy and ToS
   - test accounts populated with data
   - for ChatGPT, a login that is **not** magic-link-only
   - OpenAI org and domain verification

   The proposal assumes **no listing**: custom connectors only.
4. **Should agents be able to write?** The alternative is read-only analytics first, with `create_link`/`update_link`/`disable_link` added later. This changes the scopes the consent page offers and the tool list.
5. **Accept the audit column?** Adding `links.created_via` (and possibly `created_by_credential_id`) changes the data model and, optionally, the `Link` schema.

## 8. Sources (all accessed 2026-10-23)

- [S1] WebMCP spec, Draft CG Report 20 Oct 2026 — https://webmachinelearning.github.io/webmcp/
- [S2] WebMCP repo README — https://github.com/webmachinelearning/webmcp
- [S3] Chrome for Developers, "WebMCP" (published 18 May 2026, updated 7 Oct 2026) — https://developer.chrome.com/docs/ai/webmcp
- [S4] WebMCP implementation status — https://github.com/webmachinelearning/webmcp/blob/main/implementation-status.md
- [S5] Blink-dev "Intent to Experiment: WebMCP" — https://groups.google.com/a/chromium.org/g/blink-dev/c/gmYffo5WOE8/m/OJxuQRP3AAAJ
- [S6] Third-party, unverified: "WebMCP in 2026: The API moved…" — https://mcpplaygroundonline.com/blog/what-is-webmcp ; Towards AI article — https://pub.towardsai.net/webmcp-takes-27-lines-securing-it-means-auditing-every-script-on-your-page-eca9c0ab9f27
- [S7] Chrome for Developers, "WebMCP tool security" (published 9 Jun 2026, updated 1 Sep 2026) — https://developer.chrome.com/docs/ai/webmcp/secure-tools
- [S8] Chrome for Developers, "Declarative API" (updated 25 Sep 2026) — https://developer.chrome.com/docs/ai/webmcp/declarative-api
- [S9] Claude, "Build an MCP server for Claude" — https://claude.com/docs/connectors/building
- [S10] Claude, "Authentication for connectors" — https://claude.com/docs/connectors/building/authentication
- [S11] Claude, "Submit a connector to the directory" — https://claude.com/docs/connectors/building/submission
- [S12] Claude, "Connector pre-submission checklist" (review criteria) — https://claude.com/docs/connectors/building/review-criteria
- [S13] Claude Code, "MCP" — https://code.claude.com/docs/en/mcp
- [S14] OpenAI, "Build an MCP server" (Apps SDK / plugins) — https://developers.openai.com/apps-sdk/build/mcp-server
- [S15] OpenAI, "Authentication" — https://developers.openai.com/apps-sdk/build/auth and https://developers.openai.com/plugins/build/auth
- [S16] OpenAI, "Add custom MCP server" — https://developers.openai.com/api/docs/guides/custom-mcp-server
- [S17] OpenAI, "Plugin guidelines" (submission guidelines) — https://developers.openai.com/apps-sdk/app-submission-guidelines
- [S18] OpenAI, "Building MCP servers for plugins and API integrations" (search/fetch) — https://developers.openai.com/api/docs/mcp
- [S19] OpenAI Help, "Connecting custom MCP servers in ChatGPT" — https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt (403 to direct fetch; content seen only through a search summary)
- [S20] OpenAI, "ChatGPT UI" (MCP Apps in ChatGPT) — https://developers.openai.com/apps-sdk/build/chatgpt-ui
- [S21] OpenAI, "Upload and submit your plugin" — https://developers.openai.com/apps-sdk/deploy/submission (also /plugins/deploy/submission)
- [S22] MCP spec 2026-07-28, Key changes — https://modelcontextprotocol.io/specification/2026-07-28/changelog
- [S23] MCP spec 2026-07-28, Streamable HTTP — https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
- [S24] MCP spec 2026-07-28, Authorization — https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization
- [S25] MCP spec 2026-07-28, Versioning and compatibility — https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning
- [S26] Secondary: TypeScript SDK v2 notes — https://newreleases.io/project/github/modelcontextprotocol/typescript-sdk/release/v2.0.0-beta.1 ; check https://github.com/modelcontextprotocol/typescript-sdk before choosing a version
- MCP Apps extension overview — https://modelcontextprotocol.io/extensions/apps/overview
