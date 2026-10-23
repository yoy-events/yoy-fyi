import type { SQL } from "bun";

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
