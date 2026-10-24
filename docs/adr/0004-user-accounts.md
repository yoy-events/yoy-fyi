# ADR-0004: User accounts on yoy.fyi

- Status: accepted (2026-10-24)
- Decider: Roman
- Changes ADR-0001: yoy.fyi is no longer admin-only. Anyone with a Google account can sign in and create their own short links, as the original Shorty could (YOY repo, commit `81999ad4`).

## Context

The first version of yoy.fyi had a home page where a signed-in person saw "My Links", created links and downloaded QR codes. The rebuild made yoy.fyi a service-to-service API with one admin, so `/` showed a 404. Roman wants the personal home page back, plus API access for each person with keys they create themselves.

## Decision

### Identity

- **Sign-in:** Sign in with Google only, using the existing `yoy-fyi` Google client. A user is identified by Google's `sub`. Only `email_verified` accounts are accepted.
- **Users table:** `users (id, google_sub unique, email, name, created_at, last_seen_at, disabled_at)`.
- **Session:** a signed `__Host-yfi_user` cookie holding the user id and an expiry, valid for 30 days.
- **The admin is separate:** the `/admin` session is still the admin cookie (emailed link, or Google with `ADMIN_EMAIL`). A signed-in user is not an admin.

### Ownership

- **A personal service per user:** each user gets one, created on first sign-in: `services.owner_user_id`, with slug `u-<10 random characters>`.
- **Same code path as `/v1`:** links, QR codes, analytics, webhooks and API keys all hang off that service. A user's API key and the home page therefore see the same links, under the same rules.
- **`created_via`:** gains `web` for links created on the home page.

### Pages (outside `/admin`)

- **`/`:** signed out, it describes yoy.fyi and offers Sign in with Google. Signed in, it shows the creation form, then the user's links with their clicks over the last 7 days. With no links yet, it says so and offers to create the first one.
- **`/links/{id}`:** the short URL, QR codes (SVG and PNG downloads), 30 days of daily clicks, top referrers, countries and devices, and a disable button. Later additions: a Copy button (one same-origin script), editing the target, title, tags and expiry, and re-enabling a disabled link after the target is checked again.
- **`/account/keys`:** API keys for the user's own service. Users can grant `links:read`, `links:write`, `analytics:read` and `webhooks:manage`, never `keys:manage`. A secret is shown once.
- **`/privacy` and `/terms`:** required by Google to publish the consent screen.
- **New reserved codes:** `links`, `account`, `login`, `logout`, `privacy` and `terms`.

### Abuse

- **Target policy:** every target goes through the existing policy (http(s) only, no credentials, no private addresses, not yoy.fyi itself).
- **Rate limits:** per user, 20 creates per hour from the web form. The `/v1` limit of 60 per minute now counts per service instead of per key, and a personal account holds at most 10 active keys, so minting keys cannot multiply the limit.
- **Blocking:** the admin can block a user. A blocked user can't sign in, their keys stop working (key checks require the owning user not to be blocked), and their links answer 410.

## Consequences

- **Google consent screen:** it must be published, out of testing mode, with a home page, a privacy policy and terms on yoy.fyi.
- **Open sign-up invites phishing links.** The mitigations are the target policy, rate limits, blocking, and `created_via`/owner for bulk disable.
- **MCP and OAuth stay admin-only for now.** Users reach `/mcp` with their own `yfi_` keys. OAuth consent for any user is a separate step (done in ADR-0005).
