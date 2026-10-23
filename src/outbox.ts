import type { SQL } from "bun";
import { openSecret } from "./secretbox";
import { webhookUrlRejection } from "./webhooks";
import { checkTarget } from "./target-policy";

const BATCH = 500;
const SETTLE_MS = 5_000;

type ClickRow = {
  id: string;
  service_id: string;
  clicked_at: Date;
  is_bot: boolean;
  bot_name: string | null;
  country: string | null;
  ua_device: string | null;
  ua_browser: string | null;
  ua_os: string | null;
  referer_host: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_term: string | null;
  utm_content: string | null;
  fbclid: string | null;
  gclid: string | null;
  fbc: string | null;
  fbp: string | null;
  link_id: string;
  code: string;
  tags: string[];
  ext_service: string | null;
  ext_entity_type: string | null;
  ext_entity_id: string | null;
};

// The payload never carries the IP (not stored) or the visitor hash.
function clickedEvent(c: ClickRow, publicOrigin: string) {
  return {
    id: c.id,
    type: "link.clicked",
    created_at: c.clicked_at,
    data: {
      link: {
        id: c.link_id,
        code: c.code,
        short_url: `${publicOrigin}/${c.code}`,
        tags: c.tags,
        external_ref: c.ext_service
          ? { service: c.ext_service, entity_type: c.ext_entity_type, entity_id: c.ext_entity_id }
          : null,
      },
      click: {
        id: c.id,
        clicked_at: c.clicked_at,
        is_bot: c.is_bot,
        bot_name: c.bot_name,
        country: c.country,
        device: c.ua_device,
        browser: c.ua_browser,
        os: c.ua_os,
        referer_host: c.referer_host,
        utm_source: c.utm_source,
        utm_medium: c.utm_medium,
        utm_campaign: c.utm_campaign,
        utm_term: c.utm_term,
        utm_content: c.utm_content,
        fbclid: c.fbclid,
        gclid: c.gclid,
        fbc: c.fbc,
        fbp: c.fbp,
      },
    },
  };
}

// The clicks table is the outbox: the redirect writes one row and nothing else. This pass
// turns clicks past the cursor into one delivery per matching webhook, then moves the cursor.
// Click ids are UUIDv7 stamped at request time; clicks younger than `settledBefore` (default
// now - 5 s) wait, so a slow insert with a smaller id cannot be skipped. Returns deliveries made.
export async function fanOut(
  sql: SQL,
  publicOrigin: string,
  settledBefore = new Date(Date.now() - SETTLE_MS),
): Promise<number> {
  return sql.begin(async (tx) => {
    const [cursor] = await tx`select * from outbox_cursor where name = 'webhooks' for update`;
    const clicks: ClickRow[] = await tx`
      select c.*, l.code, l.tags, l.ext_service, l.ext_entity_type, l.ext_entity_id
      from clicks c join links l on l.id = c.link_id
      where c.clicked_at >= ${cursor.last_clicked_at}::timestamptz - interval '1 minute'
        and c.id > ${cursor.last_click_id}
        and c.clicked_at < ${settledBefore}
      order by c.id
      limit ${BATCH}`;
    if (clicks.length === 0) return 0;

    const serviceIds = [...new Set(clicks.map((c) => c.service_id))];
    const webhooks: { id: string; service_id: string; include_bots: boolean; created_at: Date }[] = await tx`
      select id, service_id, include_bots, created_at from webhooks
      where disabled_at is null and 'link.clicked' = any(events)
        and service_id in ${tx(serviceIds)}`;

    const rows = clicks.flatMap((c) =>
      webhooks
        .filter((w) => w.service_id === c.service_id && (w.include_bots || !c.is_bot) && w.created_at <= c.clicked_at)
        .map((w) => ({ id: Bun.randomUUIDv7(), webhook_id: w.id, click_id: c.id, payload: clickedEvent(c, publicOrigin) })),
    );
    if (rows.length) await tx`insert into webhook_deliveries ${tx(rows)} on conflict (webhook_id, click_id) do nothing`;

    const last = clicks.at(-1)!;
    await tx`update outbox_cursor set last_click_id = ${last.id}, last_clicked_at = ${last.clicked_at}
             where name = 'webhooks'`;
    return rows.length;
  });
}

const CLAIM = 20;
const TIMEOUT_MS = 5_000;
const LEASE_MS = 60_000;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 6 * 3_600_000;
// 30 s doubling, capped at 6 h: the 14th attempt lands about 24 h after the first.
const MAX_ATTEMPTS = 14;

type PostRequest = { body: string; headers: Record<string, string> };

// POSTs a webhook without following redirects. TLS is verified against the URL's hostname
// before anything is sent. The host was re-checked just before (deliverDue), but DNS could
// still change in between: Bun cannot pin the checked IP and verify the hostname first (its
// IP-URL requests skip the name check, and checkServerIdentity runs after the request is
// written). Webhook URLs are limited to https on 443, and nothing internal listens on 443,
// so a rebinding attempt by an authenticated service reaches nothing. Resolves to the status.
export async function postWebhook(url: string, req: PostRequest, timeoutMs = TIMEOUT_MS): Promise<number> {
  const res = await fetch(url, {
    method: "POST",
    body: req.body,
    headers: req.headers,
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
  await res.body?.cancel();
  return res.status;
}

type DeliverDeps = {
  key: CryptoKey;
  ownHost: string;
  post?: (url: string, req: PostRequest) => Promise<number>;
  resolveHost?: (host: string) => Promise<string[]>;
  now?: () => Date;
  random?: () => number;
};

export function sign(secret: string, timestamp: number, body: string): string {
  const mac = new Bun.CryptoHasher("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${mac}`;
}

// Claims due deliveries with a one-minute lease (so a crash only delays them), POSTs each,
// and records the outcome. Returns how many deliveries were attempted.
export async function deliverDue(sql: SQL, deps: DeliverDeps): Promise<number> {
  const { key, ownHost, post = postWebhook, resolveHost, now = () => new Date(), random = Math.random } = deps;
  const at = now();
  const claimed: { id: string; payload: unknown; attempts: number; url: string; secret_enc: string }[] = await sql`
    with due as (
      select d.id from webhook_deliveries d join webhooks w on w.id = d.webhook_id
      where d.status = 'pending' and d.next_attempt_at <= ${at} and w.disabled_at is null
      order by d.next_attempt_at
      limit ${CLAIM}
      for update of d skip locked
    )
    update webhook_deliveries d set next_attempt_at = ${new Date(at.getTime() + LEASE_MS)}
    from due, webhooks w
    where d.id = due.id and w.id = d.webhook_id
    returning d.id, d.payload, d.attempts, w.url, w.secret_enc`;

  await Promise.all(
    claimed.map(async (d) => {
      let status: number | null = null;
      let error: string | null = null;
      // Re-checked on every attempt: the host may resolve somewhere else than at registration.
      const rejection = webhookUrlRejection(d.url) ?? (await checkTarget(d.url, { ownHost, resolve: resolveHost }));
      if (rejection) {
        error = `target_rejected: ${rejection}`;
      } else {
        const body = JSON.stringify(d.payload);
        try {
          status = await post(d.url, {
            body,
            headers: {
              "Content-Type": "application/json",
              "Yoy-Event": "link.clicked",
              "Yoy-Delivery": d.id,
              "Yoy-Signature": sign(await openSecret(key, d.secret_enc), Math.floor(at.getTime() / 1000), body),
            },
          });
          if (status < 200 || status >= 300) error = `HTTP ${status}`;
        } catch (err) {
          error = (err instanceof Error ? err.message : String(err)).slice(0, 300);
        }
      }

      const attempts = d.attempts + 1;
      if (!error) {
        await sql`update webhook_deliveries set status = 'delivered', attempts = ${attempts}, last_status = ${status},
                    last_error = null, next_attempt_at = null, delivered_at = ${at} where id = ${d.id}`;
      } else if (attempts >= MAX_ATTEMPTS) {
        await sql`update webhook_deliveries set status = 'dead', attempts = ${attempts}, last_status = ${status},
                    last_error = ${error}, next_attempt_at = null where id = ${d.id}`;
      } else {
        const backoff = Math.min(BASE_BACKOFF_MS * 2 ** (attempts - 1), MAX_BACKOFF_MS) * (0.8 + 0.4 * random());
        await sql`update webhook_deliveries set attempts = ${attempts}, last_status = ${status}, last_error = ${error},
                    next_attempt_at = ${new Date(at.getTime() + backoff)} where id = ${d.id}`;
      }
    }),
  );
  return claimed.length;
}
