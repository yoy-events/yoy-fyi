# ADR-0001: yoy.fyi architecture

- Status: accepted (2026-10-23)
- Date: 2026-10-23
- Decider: Roman

## Context

yoy.fyi becomes a standalone short-link and click-analytics service again, used by YOY, Diduny, mnfaktr-lms and future apps. Lessons from the original `shorty-links` are binding: no `head_code`, validated targets, authenticated and rate-limited creation, host config in `fly.toml [env]`, one config value for every absolute URL.

Settled with Roman on 2026-10-23:

| Question | Decision |
|---|---|
| Short host | `yoy.fyi/{code}`. `a.yoy.fyi/*` answers 301 to the same path on `yoy.fyi`. |
| Database hosting | Same as mnfaktr-lms: Postgres and the app on one Fly machine with one volume. No Supabase, no Managed Postgres. `docker-compose.yml` runs Postgres locally and in CI. |
| Admin login | Magic link to one allowlisted email |
| Raw click retention | 13 months raw; rollups kept forever |
| YOY import | After v1 |

## Decision

### Runtime

One Bun + TypeScript + Hono process and one Postgres 17 cluster in a single image (`postgres:17` base with the Bun binary copied in), on one Fly machine in `arn`:

- Volume `yoy_fyi_data` mounted at `/data`. `PGDATA=/data/pgdata`.
- Postgres listens on `127.0.0.1` only. The entrypoint initialises the cluster, runs migrations, then starts the server. There is no `release_command`, because it runs on a separate machine that cannot reach this Postgres.
- `auto_stop_machines = false` and `min_machines_running = 1` in production. Stopping the machine stops the database.
- Background work (rollups, outbox delivery, partition maintenance, backups) runs as `setInterval` loops inside the same process, guarded by `pg_try_advisory_lock`. No separate worker, queue or Redis.
- `PUBLIC_ORIGIN = "https://yoy.fyi"` in `fly.toml [env]` is the only domain literal. Short URLs, QR payloads, admin magic links and the self-loop check all derive from it. `fly.test.toml` sets `PUBLIC_ORIGIN = "https://yoy-fyi-test.fly.dev"`.

Sizing and cost (arn, Oct 2026 list prices, approximate):

| Item | Production | Test app (`yoy-fyi-test`) |
|---|---|---|
| Machine | shared-cpu-1x, 512 MB, ~$3.5/mo | same, `auto_stop_machines = "stop"`, ~$1/mo |
| Volume | 3 GB, ~$0.5/mo | 1 GB |
| Snapshots | daily, 5-day retention (Fly default) | default |
| Off-machine dump | daily `pg_dump -Fc` to a Tigris bucket via `Bun.s3`, 30 days, < $0.1/mo | none |

Total about $5/mo plus Resend (existing account, free tier).

Trade-offs of the single machine, accepted for v1:

- **Every deploy is a redirect outage** of roughly 10–30 s while the machine restarts. A single volume cannot be shared across machines, so there are no rolling deploys.
- No failover. A host failure means restoring the volume from a snapshot (up to 24 h of loss) or the latest `pg_dump`.
- Volume snapshots are crash-consistent only. Links and clicks cannot be rebuilt from git the way LMS content can, so the daily logical dump to Tigris is mandatory, not optional.

Exit condition: when deploy downtime or a 24 h RPO becomes unacceptable, move Postgres to its own Fly machine (or Managed Postgres) and run two app machines. The code needs only a different `DATABASE_URL`.

### Data model

All ids are UUIDv7 (`Bun.randomUUIDv7()`), so they sort by creation time.

```
services        id, slug unique, name, created_at, disabled_at
api_keys        id, service_id, prefix unique, secret_hash, scopes text[],
                name, created_at, last_used_at, revoked_at
links           id, service_id, code unique, target_url, title, tags text[],
                utm_defaults jsonb, pass_click_id bool, expires_at,
                ext_service, ext_entity_type, ext_entity_id,
                idempotency_key, created_at, updated_at, disabled_at
                unique (service_id, idempotency_key)
                unique (service_id, ext_service, ext_entity_type, ext_entity_id)
clicks          id, link_id, service_id, clicked_at, referer_host, referer,
                ua_device, ua_browser, ua_os, is_bot, bot_name, country,
                visitor_hash, utm_source, utm_medium, utm_campaign,
                utm_term, utm_content, fbclid, gclid, fbc, fbp
                PARTITION BY RANGE (clicked_at), one partition per month
link_stats_hourly   link_id, service_id, hour, is_bot, clicks, uniques
link_dims_daily     link_id, service_id, day, dim, value, is_bot, clicks
webhooks        id, service_id, url, secret_enc, events text[],
                created_at, disabled_at
webhook_deliveries  id, webhook_id, click_id, payload jsonb, attempts,
                    next_attempt_at, last_status, last_error, delivered_at
outbox_cursor   name primary key, last_click_id
admin_login_tokens  token_hash, expires_at, used_at
```

Rules:

- Links are never hard-deleted. "Disable" sets `disabled_at`. Codes are never reused.
- Clicks are append-only. The only path that removes raw clicks is the retention job, which drops whole monthly partitions older than 13 months. Rollups keep their counts forever.
- `service_id` is denormalised onto `clicks` and the rollups so per-service analytics never join through `links`.

### Redirect path

`GET /{code}`:

1. Validate the code against `[A-Za-z0-9_-]{1,64}`. Reserved paths (`v1`, `admin`, `health`, `qr`, `robots.txt`, `favicon.ico`, `openapi.json`, `static`) are routed before this handler and can never be link codes.
2. Look up the link by its unique `code` index over loopback. No in-process cache until a measurement shows the need.
3. Unknown code → 404 HTML. Disabled or expired → 410 HTML.
4. Build the target: merge `utm_defaults` without overwriting params already present; append `yoy_sid=<click id>` if `pass_click_id`.
5. `INSERT` one row into `clicks` and respond 302. The insert is the only database write on the request path. Nothing else waits on it: no aggregation, no webhook fan-out.

Target: p95 under 50 ms server time, measured as a `Server-Timing` header plus a histogram exposed at `/health/metrics` (admin-only).

Click fields:

- Visitor hash = `sha256(daily_salt || client_ip || user_agent)`. The salt is random, generated per UTC day, kept in memory and in a one-row table, and deleted after 48 h. The raw IP is never stored or logged.
- Country: looked up in memory from `Fly-Client-IP` against the DB-IP Lite country database (CC BY 4.0, ~7 MB `.mmdb`, refreshed at image build time). Fly sets no country header, and `Fly-Region` is the edge, not the visitor. Only the ISO country code is stored.
- User agent: `isbot` classifies bots and link-preview crawlers (Telegram, Slack, Facebook, WhatsApp, Discord, X, LinkedIn, Google). `bowser` parses device/browser/OS families. Both are MIT and small, and they replace a regex list we would otherwise have to maintain. Bots are stored with `is_bot = true`, never dropped.

### Auth model

Services:

- Key format: `yfi_<prefix 8>_<secret 32>`, base62, about 190 bits of entropy. The full key is shown once, at creation.
- Stored: `prefix` (lookup) and `sha256(secret)`, compared in constant time. A slow hash adds nothing for random keys of this length.
- Scopes: `links:write`, `links:read`, `analytics:read`. Revocation sets `revoked_at` and takes effect on the next request. `last_used_at` is written at most once a minute per key.
- Every query is filtered by the key's `service_id`. A link owned by another service returns 404, not 403, so codes don't leak across tenants.

Admin:

- `ADMIN_EMAIL` lives in `fly.toml [env]`. `POST /admin/login` always answers the same way, and sends a Resend email only when the address matches.
- The token is 32 random bytes, stored as a sha256 hash, valid for 15 minutes, single use. The session is an HMAC-signed cookie (`__Host-`, HttpOnly, Secure, SameSite=Lax, 7 days). Admin form posts must carry an `Origin` header matching `PUBLIC_ORIGIN` (Hono `csrf`), which replaces a per-form CSRF token. Opening the emailed link only shows a confirm button, so mail scanners that prefetch links cannot use the token up.

Secrets (Fly secrets, never in `[env]`, never logged): `SESSION_SECRET`, `WEBHOOK_ENC_KEY`, `RESEND_API_KEY`, Tigris credentials. Request logging redacts `Authorization` and any `yfi_` substring.

### Target URL validation

Checked on create and update:

- Scheme must be `http` or `https`. No userinfo. Length ≤ 2048.
- The host must not be an own host (`PUBLIC_ORIGIN` host or any subdomain of it) and must not be `localhost`, `*.internal` or `*.local`.
- Literal IPs and the host's resolved A/AAAA records must not be loopback, private, link-local, CGNAT, or ULA ranges. DNS can change later; that is accepted, because the browser follows the redirect, not our server.

### Rate limits

In-memory token buckets. Correct for one machine; they move to Postgres when there is more than one.

- Link create: 60/min per API key, burst 20.
- Redirects: 120/min per client IP, burst 60. The IP is a key in process memory only, never persisted or logged. When exceeded, return 429 and record nothing.
- Admin login: 5 per 15 min per IP.

### Analytics storage

Raw clicks go into monthly partitions. A partition-maintenance loop creates the next two months ahead and drops partitions older than 13 months.

The rollup loop runs every 5 minutes. For each `(link, day)` touched since its last cursor, it recomputes that day's rows in `link_stats_hourly` and `link_dims_daily` from raw with `DELETE` + `INSERT … SELECT` in one transaction, so recomputation is idempotent. Analytics queries read rollups only, which makes them at most 5 minutes stale.

Uniques: the salt rotates daily by design, so a visitor cannot be recognised across days. Uniques are exact per hour and per day. A multi-day range returns the sum of daily uniques and labels it `uniques_upper_bound`. That is the honest approximation the privacy rule allows.

Dimensions in `link_dims_daily`: `referer_host`, `utm_source`, `utm_medium`, `utm_campaign`, `country`, `device`, `browser`, `os`.

#### Ceiling

Assumptions: about 350 bytes per raw click row plus indexes, 13-month retention, shared-cpu-1x.

| Clicks/day | Raw storage at 13 months | Status |
|---|---|---|
| 10k | ~1.5 GB | comfortable |
| 100k | ~15 GB | **design ceiling**; volume grows to ~20 GB, ~$3/mo |
| 1M | ~150 GB | out of range |

Move raw clicks to ClickHouse (or similar) when any of these holds for 7 consecutive days:

- sustained volume above 300k clicks/day, or
- a 5-minute rollup pass takes longer than 60 s, or
- redirect p95 server time goes above 50 ms with the insert as the dominant span, or
- the raw partitions exceed 40 GB.

Each is observable from `/health/metrics` and `pg_total_relation_size`.

### Webhooks and outbox

The `clicks` table is the outbox. Redirects never write a second row.

1. Fan-out loop (every 2 s): read clicks with `id > outbox_cursor.last_click_id` whose service has an active webhook. Insert one `webhook_deliveries` row per (webhook, click) and advance the cursor, all in one transaction. UUIDv7 ordering makes the cursor monotonic.
2. Delivery loop: pick due rows with `FOR UPDATE SKIP LOCKED` and POST with a 5 s timeout. Any 2xx counts as delivered.
3. Retries back off exponentially (30 s × 2ⁿ with jitter, capped at 6 h) for up to 14 attempts, about 24 h (12 attempts would only reach about 14.5 h). After that the row is marked dead and shown in admin.
4. Signature: header `Yoy-Signature: t=<unix>,v1=<hex hmac-sha256(secret, t + "." + body)>`. Receivers reject timestamps older than 5 minutes.
5. Webhook secrets are encrypted at rest with AES-GCM under `WEBHOOK_ENC_KEY`, because signing needs the plaintext. The secret is shown once, at registration.
6. Webhook URLs get the same validation as targets, and the private-range check is repeated at each delivery against the resolved IP (SSRF).
7. The payload carries the link id, code, `ext_*`, click id, timestamp, country, device/browser/OS, `is_bot`, utm/fbclid/gclid/fbc/fbp, and referer host. It never carries the IP or the visitor hash.

### API and admin surface

- `/v1` JSON API, with the contract in `openapi.yaml` (deliverable 2) and served at `/v1/openapi.json`. Errors follow one shape: `{ error: { code, message } }`.
- Create idempotency: the same `Idempotency-Key` with the same body returns the existing link (200). The same key with a different body returns 422 `idempotency_key_reused`. The same `external_ref` returns the existing link (200) regardless of body. A new link returns 201.
- Generated codes are 7 base62 characters (3.5 × 10¹² space), retried on unique violation.
- QR: `GET /v1/links/{id}/qr.svg|.png` via the `qrcode` package (MIT), encoding `PUBLIC_ORIGIN/{code}`.
- Admin: server-rendered HTML via Hono JSX, without a client framework. Charts are inline SVG rendered on the server. HTML pages send a strict CSP (`default-src 'self'`, no inline script), HSTS, `X-Frame-Options: DENY`, and `Referrer-Policy: strict-origin-when-cross-origin`.
- Client: `client/yoy-fyi.ts`, a single file built on `fetch`, with types matching the OpenAPI spec.

### Delivery

- GitHub repo `yoy-events/yoy-fyi`, matching YOY and mnfaktr-lms. Creating it needs Roman's go-ahead.
- GitHub Actions on every PR: Biome lint, `tsc --noEmit`, `bun test` against a Postgres service container, and Playwright against the built image. A PR deploys to `yoy-fyi-test` (one shared test app; the latest PR wins). A merge to `main` deploys to `yoy-fyi`. Deploys never run from a laptop.
- A post-deploy smoke step in CI hits `/health` and one known redirect on the deployed app.

## Consequences

- About $5/mo, and there is one thing to operate.
- Deploys cause short redirect outages until the exit condition is met.
- Off-machine backups are part of v1 scope.
- Country accuracy depends on a monthly-refreshed IP database that ships in the image.
- Cross-day uniques are an upper bound by design.

## Open items (not blocking the OpenAPI draft)

1. DNS for `yoy.fyi`: where the zone is hosted now and whether the old Fly certs on `shorty-links` still exist. The runbook needs this.
2. Whether the redirect outage during deploys is acceptable for links already printed or shared. If it is not, the exit condition applies from day one, at roughly +$3–4/mo for a second machine plus a separate DB machine.
