import type { SQL } from "bun";
import { Hono } from "hono";
import { type AuthEnv, requireScope } from "./auth";
import { apiError, isUuid, readJsonObject, validationFailed } from "./http";
import { randomBase62 } from "./keys";
import { sealSecret } from "./secretbox";
import { type TargetRejection, checkTarget } from "./target-policy";

const EVENTS = ["link.clicked"];

// Webhooks are server-side requests, so they get stricter rules than link targets: https on
// the default port only, which keeps deliveries away from internal services on other ports.
export function webhookUrlRejection(raw: string): TargetRejection | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return "scheme";
    if (url.port !== "") return "port";
    return null;
  } catch {
    return "scheme";
  }
}

type WebhookRow = {
  id: string;
  url: string;
  events: string[];
  include_bots: boolean;
  created_at: Date;
  disabled_at: Date | null;
};

const COLUMNS = "id, url, events, include_bots, created_at, disabled_at";
const toWebhook = (row: WebhookRow) => ({
  id: row.id,
  url: row.url,
  events: row.events,
  include_bots: row.include_bots,
  created_at: row.created_at,
  disabled_at: row.disabled_at,
});

type Deps = {
  sql: SQL;
  publicOrigin: string;
  webhookKey?: CryptoKey;
  resolveHost?: (host: string) => Promise<string[]>;
};

export function webhookRoutes({ sql, publicOrigin, webhookKey, resolveHost }: Deps) {
  const app = new Hono<AuthEnv>();
  const ownHost = new URL(publicOrigin).hostname;
  app.use("/webhooks/*", requireScope("webhooks:manage"));
  app.use("/webhooks", requireScope("webhooks:manage"));

  const findOwn = async (id: string, serviceId: string) =>
    isUuid(id)
      ? ((await sql`select ${sql.unsafe(COLUMNS)} from webhooks where id = ${id} and service_id = ${serviceId}`)[0] as
          | WebhookRow
          | undefined)
      : undefined;

  app.get("/webhooks", async (c) => {
    const rows: WebhookRow[] = await sql`
      select ${sql.unsafe(COLUMNS)} from webhooks where service_id = ${c.get("caller").serviceId} order by id desc`;
    return c.json({ data: rows.map(toWebhook) });
  });

  app.post("/webhooks", async (c) => {
    const body = await readJsonObject(c);
    if (!body) return apiError(c, 400, "invalid_request", "Body must be a JSON object.");
    const fields: Record<string, string> = {};
    for (const key of Object.keys(body)) if (!["url", "events", "include_bots"].includes(key)) fields[key] = "unknown field";
    if (typeof body.url !== "string" || body.url.length > 2048) fields.url = "https URL, at most 2048 characters";
    const events = body.events ?? ["link.clicked"];
    if (
      !Array.isArray(events) ||
      events.length === 0 ||
      new Set(events).size !== events.length ||
      !events.every((e) => EVENTS.includes(e))
    ) {
      fields.events = `non-empty unique list of ${EVENTS.join(", ")}`;
    }
    if (body.include_bots !== undefined && typeof body.include_bots !== "boolean") fields.include_bots = "boolean";
    if (Object.keys(fields).length) return validationFailed(c, fields);

    const url = body.url as string;
    const rejection = webhookUrlRejection(url) ?? (await checkTarget(url, { ownHost, resolve: resolveHost }));
    if (rejection) return apiError(c, 422, "target_rejected", "The webhook URL is not allowed.", { reason: rejection });
    if (!webhookKey) throw new Error("WEBHOOK_ENC_KEY is not configured");

    const secret = `whsec_${randomBase62(32)}`;
    const [row]: WebhookRow[] = await sql`
      insert into webhooks (id, service_id, url, secret_enc, events, include_bots)
      values (${Bun.randomUUIDv7()}, ${c.get("caller").serviceId}, ${url}, ${await sealSecret(webhookKey, secret)},
              ${sql.array(events as string[], "text")}, ${body.include_bots ?? false})
      returning ${sql.unsafe(COLUMNS)}`;
    return c.json({ webhook: toWebhook(row!), secret }, 201);
  });

  app.get("/webhooks/:id", async (c) => {
    const row = await findOwn(c.req.param("id"), c.get("caller").serviceId);
    if (!row) return apiError(c, 404, "not_found", "Webhook not found.");
    return c.json(toWebhook(row));
  });

  app.post("/webhooks/:id/disable", async (c) => {
    const id = c.req.param("id");
    const row = await sql.begin(async (tx) => {
      const [updated] = isUuid(id)
        ? await tx`
            update webhooks set disabled_at = coalesce(disabled_at, now())
            where id = ${id} and service_id = ${c.get("caller").serviceId}
            returning ${tx.unsafe(COLUMNS)}`
        : [];
      if (updated) {
        await tx`update webhook_deliveries set status = 'dead', next_attempt_at = null
                 where webhook_id = ${id} and status = 'pending'`;
      }
      return updated as WebhookRow | undefined;
    });
    if (!row) return apiError(c, 404, "not_found", "Webhook not found.");
    return c.json(toWebhook(row));
  });

  return app;
}
