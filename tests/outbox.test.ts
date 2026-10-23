import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { deliverDue, fanOut } from "../src/outbox";
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

describe("deliverDue", () => {
  const NOW = new Date("2026-04-01T12:00:00Z");
  type Sent = { url: string; init: RequestInit };
  let sent: Sent[];
  let respond: (s: Sent) => Promise<Response>;
  const fakeFetch = (async (url: string, init: RequestInit) => {
    const s = { url, init };
    sent.push(s);
    return respond(s);
  }) as unknown as typeof fetch;

  const run = (overrides: Partial<Parameters<typeof deliverDue>[1]> = {}) =>
    deliverDue(sql, {
      key,
      ownHost: "yoy.fyi",
      fetch: fakeFetch,
      resolveHost: async () => ["93.184.215.14"],
      now: () => NOW,
      random: () => 0.5,
      ...overrides,
    });

  const pending = async (attempts = 0) => {
    const webhookId = await addWebhook();
    await sql`update webhooks set secret_enc = ${await sealSecret(key, "whsec_test")} where id = ${webhookId}`;
    const id = Bun.randomUUIDv7();
    await sql`insert into webhook_deliveries (id, webhook_id, click_id, payload, attempts, next_attempt_at)
              values (${id}, ${webhookId}, ${Bun.randomUUIDv7()}, ${{ id: "evt", type: "link.clicked" }}, ${attempts},
                      ${new Date(NOW.getTime() - 1000)})`;
    return id;
  };
  const row = async (id: string) => (await sql`select * from webhook_deliveries where id = ${id}`)[0];

  beforeEach(() => {
    sent = [];
    respond = async () => new Response("ok", { status: 200 });
  });

  test("POSTs the signed payload and marks the delivery delivered", async () => {
    const id = await pending();

    expect(await run()).toBe(1);

    expect(sent).toHaveLength(1);
    const { url, init } = sent[0]!;
    const headers = new Headers(init.headers);
    const body = init.body as string;
    expect(url).toBe("https://hooks.example.com/");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    expect(JSON.parse(body)).toEqual({ id: "evt", type: "link.clicked" });
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("yoy-event")).toBe("link.clicked");
    expect(headers.get("yoy-delivery")).toBe(id);
    const t = Math.floor(NOW.getTime() / 1000);
    const expected = new Bun.CryptoHasher("sha256", "whsec_test").update(`${t}.${body}`).digest("hex");
    expect(headers.get("yoy-signature")).toBe(`t=${t},v1=${expected}`);
    expect(await row(id)).toMatchObject({
      status: "delivered",
      attempts: 1,
      last_status: 200,
      next_attempt_at: null,
      delivered_at: NOW,
    });
  });

  test("a non-2xx answer is retried after a backoff", async () => {
    respond = async () => new Response("no", { status: 500 });
    const id = await pending(2);

    await run();

    expect(await row(id)).toMatchObject({
      status: "pending",
      attempts: 3,
      last_status: 500,
      last_error: "HTTP 500",
      next_attempt_at: new Date(NOW.getTime() + 120_000), // 30 s * 2^2, jitter factor 1.0
    });
  });

  test("redirects are not followed and count as failures", async () => {
    respond = async () => new Response(null, { status: 302, headers: { location: "http://10.0.0.1/" } });
    const id = await pending();

    await run();

    expect((await row(id)).status).toBe("pending");
    expect(sent).toHaveLength(1);
  });

  test("network errors are recorded and retried", async () => {
    respond = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    const id = await pending();

    await run();

    expect(await row(id)).toMatchObject({ status: "pending", attempts: 1, last_status: null, last_error: "connect ECONNREFUSED" });
  });

  test("backoff is capped at 6 hours", async () => {
    respond = async () => new Response("no", { status: 503 });
    const id = await pending(11);

    await run();

    expect((await row(id)).next_attempt_at).toEqual(new Date(NOW.getTime() + 6 * 3_600_000));
  });

  test("the 14th failed attempt marks the delivery dead", async () => {
    respond = async () => new Response("no", { status: 500 });
    const id = await pending(13);

    await run();

    expect(await row(id)).toMatchObject({ status: "dead", attempts: 14, next_attempt_at: null });
  });

  test("a webhook host now resolving to a private address is not called", async () => {
    const id = await pending();

    await run({ resolveHost: async () => ["10.0.0.7"] });

    expect(sent).toHaveLength(0);
    expect(await row(id)).toMatchObject({ status: "pending", attempts: 1, last_error: "target_rejected: private_address" });
  });

  test("deliveries not yet due are left alone", async () => {
    const id = await pending();
    await sql`update webhook_deliveries set next_attempt_at = ${new Date(NOW.getTime() + 60_000)} where id = ${id}`;

    expect(await run()).toBe(0);
    expect(sent).toHaveLength(0);
  });

  test("concurrent runs deliver each delivery once", async () => {
    for (let i = 0; i < 5; i++) await pending();

    await Promise.all([run(), run(), run()]);

    expect(sent).toHaveLength(5);
  });
});
