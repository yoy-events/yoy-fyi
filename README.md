# yoy.fyi

Short links and click analytics for YOY, Diduny, mnfaktr and other services. `https://yoy.fyi/{code}` redirects and records the click. Services create links and read analytics through `/v1`. Webhooks report each click, and `/admin` is a small dashboard.

Anyone can sign in at <https://yoy.fyi> with Google to create their own short links, download QR codes, see clicks, and create API keys for their links under **API keys** ([ADR-0004](docs/adr/0004-user-accounts.md)).

- Contract: [`openapi.yaml`](openapi.yaml), also served at <https://yoy.fyi/v1/openapi.json>
- Architecture: [ADR-0001](docs/adr/0001-architecture.md) and [ADR-0002](docs/adr/0002-home-hosting.md) (hosting)
- Operations: [runbook](docs/runbook.md)

## Use it from a service

Ask Roman for an API key for your service. Keys can be created in `/admin`. Then copy [`client/yoy-fyi.ts`](client/yoy-fyi.ts) into your project. It is one file with no dependencies.

```ts
import { createClient, verifyWebhook } from "./yoy-fyi";

const yoy = createClient({ apiKey: process.env.YOY_FYI_KEY! });

// external_ref or an Idempotency-Key makes retries return the same link.
const link = await yoy.links.create(
  { target_url: "https://yoy.events/e/123", tags: ["event"], external_ref: { service: "yoy", entity_type: "event", entity_id: "123" } },
  { idempotencyKey: "event-123" },
);
console.log(link.short_url); // https://yoy.fyi/aB3dE7x

const week = await yoy.analytics.timeseries({ link_id: link.id, interval: "day", from: "2026-10-01T00:00:00Z", to: "2026-10-08T00:00:00Z" });

// In your webhook handler: verify against the raw body before parsing it.
const ok = await verifyWebhook(process.env.YOY_FYI_WEBHOOK_SECRET!, req.headers.get("yoy-signature")!, rawBody);
```

Errors throw `YoyFyiError` with `status`, `code` and `details`, as described in the contract.

### Conversions: which link brought the sign-ups and the money

Create the link with `pass_click_id: true`. The redirect then appends `yoy_sid=<click id>` to the target URL. Keep that value from the landing page through sign-up or checkout (a cookie, or a hidden field), and report it when the event happens. The key needs the `conversions:write` scope.

```ts
await yoy.conversions.create({ click_id: sid, event: "purchase", value: 450, currency: "UAH", external_id: `order-${order.id}` });

const totals = await yoy.analytics.conversions({ link_id: link.id, from: "2026-10-01T00:00:00Z", to: "2026-11-01T00:00:00Z" });
// { events: [{ event: "purchase", count: 12, values: [{ currency: "UAH", total: 5400 }] }, ...] }
```

`external_id` makes a retry harmless: the same id with the same body returns the existing conversion, with a different body it is a `conversion_conflict`. Values are summed per currency, never across currencies. The link's page on yoy.fyi shows the last 30 days, and `get_conversions` shows them to an AI assistant.

## Use it from an AI agent (MCP)

`https://yoy.fyi/mcp` is a remote MCP server with thirteen tools: `whoami`, `list_links` (with text search), `get_link`, `create_link`, `create_links` (up to 20), `update_link`, `disable_link`, `get_qr` (a PNG image), `get_click_timeseries`, `get_click_breakdown`, `get_conversions`, and `get_bio` / `update_bio` for the yoy.fyi/@handle page of a personal account. They act for the service of the key you connect with. Links created this way are marked `created_via: "mcp"`.

In Claude Code, using a key with the scopes you want the agent to have:

```bash
claude mcp add --transport http yoy-fyi https://yoy.fyi/mcp --header "Authorization: Bearer $YOY_FYI_KEY"
```

In claude.ai or ChatGPT, add a custom connector with the URL `https://yoy.fyi/mcp`. The app sends you to yoy.fyi to sign in with Google. You grant access to your own links and choose the permissions: creating, changing and disabling links starts unticked. Your connections are listed at `/account/apps`, where each can be revoked; the admin sees all of them under **Connected apps** in `/admin` and can grant any service. See [ADR-0003](docs/adr/0003-agent-access.md) and [ADR-0005](docs/adr/0005-user-oauth.md).

### In the browser (WebMCP)

Signed in at yoy.fyi, browsers with WebMCP (experimental in Chrome) see four tools on the page: `create_link`, `list_links`, `get_link` and `disable_link`. A browser's built-in agent can use them with your session, no connector needed. Links made this way are marked `created_via: "webmcp"`.

## Run it locally

Requires Bun 1.3 and Docker.

```bash
docker compose up -d          # Postgres 17 on 127.0.0.1:55433
cp .env.example .env          # then fill WEBHOOK_ENC_KEY and SESSION_SECRET (commands are in the file)
bun install
bun run geoip:fetch           # DB-IP Lite country database into data/
bun run dev                   # http://localhost:3000
bun run key:issue yoy local links:write links:read analytics:read
```

Signing in to `/admin` sends an email through Resend, so locally it needs a real `RESEND_API_KEY` and an `ADMIN_EMAIL` you can read.

## Checks

```bash
bun run lint
bun run typecheck
bun run test                  # unit and integration, against Postgres in Docker
bun run test:e2e              # Playwright at 375 px against a seeded database
```

## Delivery

Delivery goes only through pull requests: never deploy from a laptop.

- Every PR runs lint, typecheck, tests and Playwright on GitHub's runners.
- A green PR from this repository deploys to <https://test.yoy.fyi>.
- A merge to `main` deploys to <https://yoy.fyi>.

Deploys run on the self-hosted runner inside the production VM. Workflow runs from outside contributors' fork PRs wait for approval. See [ADR-0002](docs/adr/0002-home-hosting.md) for why.

## Data and privacy

- Raw IP addresses are never stored. Clicks keep a daily-salted visitor hash and an ISO country code.
- Raw clicks are kept for 13 months. Daily and hourly rollups are kept forever.
- Country data: [DB-IP Lite](https://db-ip.com), CC BY 4.0.
