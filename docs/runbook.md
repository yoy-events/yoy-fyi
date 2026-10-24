# yoy.fyi runbook

How production is wired and how to change it. The decisions behind it are in [ADR-0002](adr/0002-home-hosting.md).

## Topology

| Piece | Where |
|---|---|
| Domain registration | ukraine.com.ua (adm.tools). Renewal is paid there. |
| DNS | Cloudflare, free plan. The registrar delegates to `collins.ns.cloudflare.com` and `leonard.ns.cloudflare.com`. |
| Public entry | Cloudflare Tunnel `yoy-fyi` (`yoy.fyi`) and `yoy-fyi-test` (`test.yoy.fyi`). No open ports anywhere. |
| Server | Hyper-V VM `yoy-fyi` (Debian 13, 2 vCPU, 1.5 GiB fixed) on Roman's Windows machine. It starts with Windows. |
| Stacks | `docker compose -p yoy-fyi` and `-p yoy-fyi-test`, each running Postgres 17, the app and `cloudflared` from [`compose.prod.yml`](../compose.prod.yml). |
| Deploys | GitHub Actions self-hosted runner `yoy-fyi`, a systemd service on the VM, run as user `runner`. |
| Email | Resend, sending from `login@yoy.fyi`. |
| Admin access | Tailscale: SSH to the VM as `ops`, key on Roman's Mac. Password login is off. |

## Everyday checks

```bash
curl -s https://yoy.fyi/health
ssh yoy-fyi-vm 'sudo docker ps --format "{{.Names}} {{.Status}}"'
ssh yoy-fyi-vm 'sudo docker logs --tail 50 yoy-fyi-app-1'
```

`yoy-fyi-vm` is the SSH alias on Roman's Mac, pointing at the VM's Tailscale address.

## Deploy and roll back

- Deploy: merge a PR into `main`. CI builds the image on the VM, starts it with `--wait`, and checks `/health` plus a 404 through the public URL.
- Roll back: revert the merge in a new PR and merge that. Never deploy by hand on the VM.
- A deploy recreates only the `app` container, so redirects pause for a few seconds and Postgres keeps running.
- Migrations run when the app boots. A migration that fails keeps the new app unhealthy, and `--wait` fails the deploy.

## Settings and secrets

| Kind | Location |
|---|---|
| Non-secret settings | [`deploy/prod.env`](../deploy/prod.env) and [`deploy/test.env`](../deploy/test.env), in git |
| Secrets | `/etc/yoy-fyi/<stage>/` on the VM only: `db.env` (Postgres password), `app.env` (`DATABASE_URL`, `SESSION_SECRET`, `WEBHOOK_ENC_KEY`, `RESEND_API_KEY`), `tunnel.env` (`TUNNEL_TOKEN`). Mode `0640`, owner `root:runner`. |

To change a secret without it appearing in the terminal or shell history:

```bash
ssh -t yoy-fyi-vm 'read -rsp "value: " V; echo; sudo sed -i "s|^RESEND_API_KEY=.*|RESEND_API_KEY=$V|" /etc/yoy-fyi/prod/app.env'
```

Then redeploy by merging any PR, or restart the stack once over SSH. Do not rotate `WEBHOOK_ENC_KEY` in place: it decrypts the stored webhook secrets.

## DNS

Records in Cloudflare:

| Name | Type | Points to | Proxy |
|---|---|---|---|
| `yoy.fyi` | CNAME | tunnel `yoy-fyi` | proxied |
| `test.yoy.fyi` | CNAME | tunnel `yoy-fyi-test` | proxied |
| `admin`, `app`, `a` | A | the old Fly app | DNS only |
| `resend._domainkey` | TXT | Resend DKIM key | |
| `send`, `rsend` | CNAME | Resend (`send.forge.rmta.net`, `rsend-euw1.forge.rmta.net`) | DNS only |
| `_dmarc` | TXT | `v=DMARC1; p=none;` | |
| `@` | MX, TXT (SPF) | ukraine.com.ua mail | |

Nameservers can only be changed in the adm.tools web UI. The adm.tools API no longer has an endpoint for them, so the ukraine.com.ua MCP can't do it. The ukraine.com.ua zone still exists, but nothing reads it while the delegation points to Cloudflare.

## Tunnels

Created with `cloudflared` from Roman's Mac (`cloudflared tunnel login` authorizes the `yoy.fyi` zone):

```bash
cloudflared tunnel create yoy-fyi
cloudflared tunnel route dns yoy-fyi yoy.fyi
# Write the token straight to the VM; it is never printed.
cloudflared tunnel token yoy-fyi | ssh yoy-fyi-vm 'read -r T; sudo sed -i "s|^TUNNEL_TOKEN=.*|TUNNEL_TOKEN=$T|" /etc/yoy-fyi/prod/tunnel.env'
```

`cloudflared` runs with `--url http://app:3000`, so every hostname routed to a tunnel reaches its stack's app. `route dns` refuses to replace an existing A or AAAA record. Delete that record in the dashboard first.

## Runner

```bash
ssh yoy-fyi-vm 'systemctl status actions.runner.yoy-events-yoy-fyi.yoy-fyi.service'
```

The runner has the single label `yoy-fyi`. To re-register it, get a registration token from `gh api -X POST repos/yoy-events/yoy-fyi/actions/runners/registration-token`, then run `./config.sh remove` and `./config.sh` as `runner` in `~runner/actions-runner`. The repo requires approval for every outside contributor's fork-PR workflow. Read the PR's code before approving its run, because it executes next to production.

## Restarts and outages

- Windows restarts: the VM starts automatically, Docker starts at boot, and every container uses `restart: unless-stopped`.
- The VM's local IP changes on every boot (Hyper-V Default Switch). Use the Tailscale address.
- Power or internet loss takes every short link down until it returns. There is no failover.

## Backups

None yet. This is accepted in ADR-0002 as a separate decision for later. Losing the VM disk loses every link and click.

## Known gaps

- `admin`, `app` and `a` have no AAAA records in Cloudflare, so they are reachable over IPv4 only.
- Tailscale node keys expire after 180 days unless key expiry is disabled for `yoy-fyi` in the Tailscale console.
