import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { fanOut } from "../src/outbox";
import { loadSecretKey, sealSecret } from "../src/secretbox";
import { addClick, createLink, createService, reset, testDb, testWebhookKey } from "./helpers";

let sql: SQL;
let key: CryptoKey;
let serviceId: string;
let linkId: string;
const SETTLED = new Date("2026-04-01T00:00:00Z");

beforeAll(async () => {
  sql = await testDb();
  key = await loadSecretKey(testWebhookKey());
});

beforeEach(async () => {
  await reset(sql);
  serviceId = await createService(sql);
  linkId = await createLink(sql, serviceId, { code: "hook", target_url: "https://example.com/" });
  await sql`update links set tags = '{fall}', ext_service = 'yoy', ext_entity_type = 'event', ext_entity_id = 'e1'
            where id = ${linkId}`;
});

const addWebhook = async (opts: { service?: string; include_bots?: boolean; created_at?: string; disabled?: boolean } = {}) => {
  const id = Bun.randomUUIDv7();
  await sql`insert into webhooks (id, service_id, url, secret_enc, events, include_bots, created_at, disabled_at)
            values (${id}, ${opts.service ?? serviceId}, 'https://hooks.example.com/', ${await sealSecret(key, "whsec_x")},
                    '{link.clicked}', ${opts.include_bots ?? false}, ${opts.created_at ?? "2026-01-01Z"},
                    ${opts.disabled ? new Date() : null})`;
  return id;
};
const click = (clicked_at: string, extra: Record<string, unknown> = {}) =>
  addClick(sql, { link_id: linkId, service_id: serviceId, clicked_at, ...extra });
const deliveries = () => sql`select * from webhook_deliveries order by id`;

describe("fanOut", () => {
  test("creates one pending delivery per click with the link.clicked payload", async () => {
    const webhookId = await addWebhook();
    await click("2026-03-10T09:00:00Z", {
      referer_host: "t.co",
      country: "UA",
      ua_device: "mobile",
      ua_browser: "Safari",
      ua_os: "iOS",
      utm_source: "ig",
      visitor_hash: "secret-hash",
    });

    expect(await fanOut(sql, "https://yoy.fyi", SETTLED)).toBe(1);

    const [d] = await deliveries();
    const [c] = await sql`select id from clicks`;
    expect(d).toMatchObject({ webhook_id: webhookId, click_id: c.id, status: "pending", attempts: 0 });
    expect(d.payload).toEqual({
      id: c.id,
      type: "link.clicked",
      created_at: "2026-03-10T09:00:00.000Z",
      data: {
        link: {
          id: linkId,
          code: "hook",
          short_url: "https://yoy.fyi/hook",
          tags: ["fall"],
          external_ref: { service: "yoy", entity_type: "event", entity_id: "e1" },
        },
        click: {
          id: c.id,
          clicked_at: "2026-03-10T09:00:00.000Z",
          is_bot: false,
          bot_name: null,
          country: "UA",
          device: "mobile",
          browser: "Safari",
          os: "iOS",
          referer_host: "t.co",
          utm_source: "ig",
          utm_medium: null,
          utm_campaign: null,
          utm_term: null,
          utm_content: null,
          fbclid: null,
          gclid: null,
          fbc: null,
          fbp: null,
        },
      },
    });
    expect(JSON.stringify(d.payload)).not.toContain("secret-hash");
  });

  test("advances its cursor, so a rerun creates nothing new", async () => {
    await addWebhook();
    await click("2026-03-10T09:00:00Z");
    await fanOut(sql, "https://yoy.fyi", SETTLED);

    expect(await fanOut(sql, "https://yoy.fyi", SETTLED)).toBe(0);
    await click("2026-03-10T09:01:00Z");
    expect(await fanOut(sql, "https://yoy.fyi", SETTLED)).toBe(1);
    expect(await deliveries()).toHaveLength(2);
  });

  test("waits for clicks newer than the settle cutoff", async () => {
    await addWebhook();
    await click("2026-03-10T09:00:00Z");

    expect(await fanOut(sql, "https://yoy.fyi", new Date("2026-03-10T08:59:00Z"))).toBe(0);
    expect(await fanOut(sql, "https://yoy.fyi", SETTLED)).toBe(1);
  });

  test("bot clicks go only to webhooks with include_bots", async () => {
    await addWebhook();
    const withBots = await addWebhook({ include_bots: true });
    await click("2026-03-10T09:00:00Z", { is_bot: true });

    await fanOut(sql, "https://yoy.fyi", SETTLED);

    expect((await deliveries()).map((d: { webhook_id: string }) => d.webhook_id)).toEqual([withBots]);
  });

  test("skips disabled webhooks, other services and clicks from before the webhook existed", async () => {
    const otherService = await createService(sql, "other");
    await addWebhook({ disabled: true });
    await addWebhook({ service: otherService });
    await addWebhook({ created_at: "2026-03-10T10:00:00Z" });
    await click("2026-03-10T09:00:00Z");

    expect(await fanOut(sql, "https://yoy.fyi", SETTLED)).toBe(0);
  });

  test("fans one click out to every matching webhook", async () => {
    await addWebhook();
    await addWebhook();
    await click("2026-03-10T09:00:00Z");

    expect(await fanOut(sql, "https://yoy.fyi", SETTLED)).toBe(2);
  });
});
