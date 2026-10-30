// Conversions: POST /v1/conversions reports that a click led to a sign-up or a purchase, and
// GET /v1/analytics/conversions totals them. A click is identified by the yoy_sid that the
// redirect appended to the target (links with pass_click_id).
import type { SQL } from "bun";
import { Hono } from "hono";
import { type AuthEnv, requireScope } from "./auth";
import { apiError, isDateTime, isUuid, readJsonObject, validationFailed } from "./http";

const EVENT = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;
const FIELDS = new Set(["click_id", "event", "value", "currency", "external_id", "occurred_at"]);
const DAY = 86_400_000;

type Row = {
  id: string;
  click_id: string;
  link_id: string;
  event: string;
  value: string | null;
  currency: string | null;
  external_id: string | null;
  occurred_at: Date;
  created_at: Date;
};

const toConversion = (r: Row) => ({
  id: r.id,
  click_id: r.click_id,
  link_id: r.link_id,
  event: r.event,
  value: r.value === null ? null : Number(r.value),
  currency: r.currency,
  external_id: r.external_id,
  occurred_at: r.occurred_at,
  created_at: r.created_at,
});

export function validateConversion(body: Record<string, unknown>, now: Date): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const key of Object.keys(body)) if (!FIELDS.has(key)) fields[key] = "unknown field";
  if (typeof body.click_id !== "string" || !isUuid(body.click_id)) fields.click_id = "the yoy_sid of the click, a UUID";
  if (typeof body.event !== "string" || !EVENT.test(body.event)) fields.event = "1-64 characters of a-z 0-9 _ . : -, such as signup or purchase";
  const { value, currency } = body;
  if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1e9)) fields.value = "a number from 0 to 1000000000";
  if (currency !== undefined && (typeof currency !== "string" || !/^[A-Za-z]{3}$/.test(currency))) fields.currency = "ISO 4217 code of 3 letters";
  if (!("value" in fields) && !("currency" in fields) && (value === undefined) !== (currency === undefined)) {
    fields[value === undefined ? "value" : "currency"] = "value and currency go together";
  }
  const ext = body.external_id;
  if (ext !== undefined && (typeof ext !== "string" || ext.length < 1 || ext.length > 128)) fields.external_id = "1-128 characters";
  const at = body.occurred_at;
  if (at !== undefined && (typeof at !== "string" || !isDateTime(at) || Date.parse(at) > now.getTime() + 60_000)) {
    fields.occurred_at = "RFC 3339 date-time, not in the future";
  }
  return fields;
}

export function conversionRoutes({ sql, now }: { sql: SQL; now: () => Date }) {
  const app = new Hono<AuthEnv>();

  app.post("/conversions", requireScope("conversions:write"), async (c) => {
    const body = await readJsonObject(c);
    if (!body) return apiError(c, 400, "invalid_request", "Body must be a JSON object.");
    const fields = validateConversion(body, now());
    if (Object.keys(fields).length) return validationFailed(c, fields);

    const serviceId = c.get("caller").serviceId;
    // The click must belong to the caller's service: another service's click id is just "not found".
    const [click] = await sql`select link_id, clicked_at from clicks where id = ${body.click_id as string} and service_id = ${serviceId} limit 1`;
    if (!click) return apiError(c, 404, "not_found", "Click not found. Pass the yoy_sid that yoy.fyi added to the target URL.");
    const occurredAt = body.occurred_at ? new Date(body.occurred_at as string) : now();
    if (occurredAt < new Date(click.clicked_at)) {
      return validationFailed(c, { occurred_at: "must not be before the click" });
    }

    const value = (body.value as number | undefined) ?? null;
    const currency = body.currency ? String(body.currency).toUpperCase() : null;
    const externalId = (body.external_id as string | undefined) ?? null;
    const same = (r: Row) => r.event === body.event && r.click_id === body.click_id && (r.value === null ? null : Number(r.value)) === value && r.currency === currency;

    const [row] = await sql`
      insert into conversions (id, service_id, link_id, click_id, event, value, currency, external_id, occurred_at)
      values (${Bun.randomUUIDv7()}, ${serviceId}, ${click.link_id}, ${body.click_id as string}, ${body.event as string}, ${value}, ${currency}, ${externalId}, ${occurredAt})
      on conflict (service_id, external_id) where external_id is not null do nothing
      returning *`;
    if (row) return c.json(toConversion(row as Row), 201);

    // The same external_id again: a retry of the same event is fine, a different one is a mistake.
    const [existing] = await sql`select * from conversions where service_id = ${serviceId} and external_id = ${externalId}`;
    if (!same(existing as Row)) {
      return apiError(c, 409, "conversion_conflict", "This external_id was already used for a different conversion.");
    }
    return c.json(toConversion(existing as Row), 200);
  });

  app.get("/analytics/conversions", requireScope("analytics:read"), async (c) => {
    const q = c.req.query();
    const serviceId = c.get("caller").serviceId;
    const valid =
      isDateTime(q.from ?? "") && isDateTime(q.to ?? "") && Date.parse(q.from!) < Date.parse(q.to!) && (q.link_id === undefined || isUuid(q.link_id));
    if (!valid) return apiError(c, 400, "invalid_request", "Invalid or missing query parameter.");
    if (Date.parse(q.to!) - Date.parse(q.from!) > 400 * DAY) return apiError(c, 422, "range_too_large", "The requested range is too large.");
    if (q.link_id) {
      const [own] = await sql`select 1 from links where id = ${q.link_id} and service_id = ${serviceId}`;
      if (!own) return apiError(c, 404, "not_found", "Link not found.");
    }
    return c.json({ events: await conversionTotals(sql, serviceId, new Date(q.from!), new Date(q.to!), q.link_id ?? null) });
  });

  return app;
}

export type EventTotals = { event: string; count: number; values: { currency: string; total: number }[] };

// Count per event, and the sum of value per currency (a sum across currencies means nothing).
export async function conversionTotals(sql: SQL, serviceId: string, from: Date, to: Date, linkId: string | null): Promise<EventTotals[]> {
  const rows: { event: string; currency: string | null; count: number; total: string | null }[] = await sql`
    select event, currency, count(*)::int as count, sum(value) as total
    from conversions
    where service_id = ${serviceId} and occurred_at >= ${from} and occurred_at < ${to}
      and (${linkId}::uuid is null or link_id = ${linkId}::uuid)
    group by event, currency order by event, currency`;
  const byEvent = new Map<string, EventTotals>();
  for (const r of rows) {
    const e = byEvent.get(r.event) ?? { event: r.event, count: 0, values: [] };
    e.count += r.count;
    if (r.currency && r.total !== null) e.values.push({ currency: r.currency, total: Number(r.total) });
    byEvent.set(r.event, e);
  }
  return [...byEvent.values()];
}
