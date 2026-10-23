# ADR-0002: Host yoy.fyi on Roman's Windows machine

- Status: accepted (2026-10-23)
- Date: 2026-10-23
- Decider: Roman
- Supersedes in ADR-0001: Runtime (machine, sizing, cost, backups), Delivery (deploy targets), where config and secrets live, the trusted client-IP header.

## Context

Hosting must cost nothing. Roman's Windows Pro machine runs around the clock. Fly would cost about $5/mo. Tailscale Funnel only serves `*.ts.net` names, so it cannot serve `yoy.fyi`. `yoy.fyi` is registered at ukraine.com.ua; today its zone there points `@`, `a`, `admin` and `app` at a Fly IP (66.241.124.134).

## Decision

### Host

- Hyper-V Gen2 VM, Debian 13 minimal, 2 vCPU, 2 GB RAM, 40 GB disk. Automatic start action: always start. Windows Update reboots bring it back without anyone logging in.
- The VM needs outbound network only (Default Switch). No port is opened on the router or on Windows.
- Docker Engine with the compose plugin, enabled at boot. Every service uses `restart: unless-stopped`.
- Tailscale on the VM for SSH and database access from Roman's Mac. Password SSH is off.

### Runtime

`compose.prod.yml`, run as project `yoy-fyi`:

- `postgres`: `postgres:17`, data in a named volume, no published port.
- `app`: the image built from the repo's `Dockerfile` (Bun, DB-IP Lite fetched at build time). It migrates on boot, as it does now. No published port.
- `cloudflared`: Cloudflare Tunnel, the only way in. It routes `yoy.fyi` and `a.yoy.fyi` to `app:3000`.

The test app is the same file run as project `yoy-fyi-test`, with its own database volume, served at `test.yoy.fyi` through a second rule on the same tunnel.

A deploy recreates only the `app` container. Postgres keeps running, so the redirect gap is a few seconds instead of a machine restart.

### Public access and DNS

- `yoy.fyi` nameservers move from ukraine.com.ua to Cloudflare (free plan). ukraine.com.ua stays the registrar.
- Every existing record is recreated in Cloudflare first, including MX and SPF, and the Resend records for `MAIL_FROM`.
- Cloudflare terminates TLS. Redirects already send `Cache-Control: no-store`, so Cloudflare does not cache them.
- Cloudflare sees visitor IPs in transit. We still never store an IP.

### Client IP

`CLIENT_IP_HEADER` names the header set by the proxy in front of the app: `cf-connecting-ip` in production and test. The app is reachable only from `cloudflared` on the compose network, so that header can be trusted. Without the setting the app uses the socket address, as in local dev. The hard-coded `Fly-Client-IP` goes away.

### Config and secrets

- Non-secret config lives in `compose.prod.yml` per project, in git: `PUBLIC_ORIGIN`, `ADMIN_EMAIL`, `MAIL_FROM`, `CLIENT_IP_HEADER`. `PUBLIC_ORIGIN` stays the only domain literal.
- Secrets live only on the VM, in `/etc/yoy-fyi/prod.env` and `/etc/yoy-fyi/test.env` (mode 0640, readable by the runner user): `DATABASE_URL` password, `SESSION_SECRET`, `WEBHOOK_ENC_KEY`, `RESEND_API_KEY`, and the tunnel token. They are not in GitHub.
- Resend: Roman's existing paid account.

### Delivery

- Private GitHub repo `yoy-events/yoy-fyi`. Creating it needs Roman's go-ahead.
- Every PR runs Biome, `tsc --noEmit`, `bun test` and Playwright on GitHub-hosted runners.
- Deploys run on a GitHub Actions self-hosted runner inside the VM, as a dedicated user in the `docker` group. The runner polls GitHub, so nothing inbound is needed.
  - A green PR from a branch of this repo deploys to `yoy-fyi-test`; the latest PR wins. PRs from forks never reach the self-hosted runner.
  - A merge to `main` deploys to `yoy-fyi`.
  - Deploy steps: check out the commit, `docker compose build`, `docker compose up -d`, wait for `/health`, then smoke `/health` and one known redirect through the public URL.
- Deploys never run from a laptop.

### Backups

None for now; a separate decision later.

## Consequences

- Hosting costs $0 beyond the electricity and internet already paid for.
- Every short link, including printed QR codes, is down whenever the machine, its power or its internet is down. A UPS for the PC and router reduces this.
- No backups: losing the VM disk loses every link and click. This is accepted for now.
- `docker` group membership is root-equivalent on the VM; the runner must only run this repo's workflows, which is why the repo is private and forks are excluded.
- Moving the zone to Cloudflare touches records the current Fly app uses.
- If the residential plan forbids servers, or uptime becomes a problem, the same compose file runs on any Linux VM; only the tunnel token changes.

## Open items

1. What serves `yoy.fyi`, `admin.yoy.fyi` and `app.yoy.fyi` on Fly today, and the cutover order. `admin` and `app` probably keep pointing at Fly, unproxied, after the zone moves.
2. Whether the existing ukraine.com.ua MX (`mx.services.`) is in use for `@yoy.fyi` mail.
