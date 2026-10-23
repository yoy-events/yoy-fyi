import type { SQL } from "bun";
import { Hono } from "hono";
import { type AuthEnv, requireScope } from "./auth";
import { apiError, isUuid, readJsonObject, validationFailed } from "./http";
import { randomBase62 } from "./keys";
import { type RateLimit, createRateLimiter } from "./ratelimit";
import { checkTarget } from "./target-policy";

// System paths that can never be link codes, compared case-insensitively.
const RESERVED = new Set(["v1", "admin", "health", "qr", "static", "openapi", "robots", "favicon"]);
const CODE = /^[A-Za-z0-9_-]{1,64}$/;
const TAG = /^[a-z0-9][a-z0-9_:.-]{0,39}$/;
const UTM_KEYS = new Set(["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"]);
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const CREATE_FIELDS = new Set([
  "target_url",
  "code",
  "title",
  "tags",
  "utm_defaults",
  "pass_click_id",
  "expires_at",
  "external_ref",
]);

type LinkRow = {
  id: string;
  code: string;
  target_url: string;
  title: string | null;
  tags: string[];
  utm_defaults: Record<string, string> | null;
  pass_click_id: boolean;
  expires_at: Date | null;
  ext_service: string | null;
  ext_entity_type: string | null;
  ext_entity_id: string | null;
  created_at: Date;
  updated_at: Date;
  disabled_at: Date | null;
};

export type LinkInput = {
  target_url: string;
  code?: string;
  title?: string;
  tags?: string[];
  utm_defaults?: Record<string, string>;
  pass_click_id?: boolean;
  expires_at?: string;
  external_ref?: { service: string; entity_type: string; entity_id: string };
};

const isString = (v: unknown, min: number, max: number): v is string =>
  typeof v === "string" && v.length >= min && v.length <= max;

export function validateLinkCreate(body: Record<string, unknown>, now: Date): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const key of Object.keys(body)) if (!CREATE_FIELDS.has(key)) fields[key] = "unknown field";

  if (!isString(body.target_url, 1, 2048)) fields.target_url = "required URL string, at most 2048 characters";
  if (body.code !== undefined && !(typeof body.code === "string" && CODE.test(body.code))) {
    fields.code = "1-64 characters of A-Z a-z 0-9 _ -";
  }
  if (body.title !== undefined && !isString(body.title, 0, 200)) fields.title = "string, at most 200 characters";
  const tags = body.tags;
  if (
    tags !== undefined &&
    !(Array.isArray(tags) && tags.length <= 20 && new Set(tags).size === tags.length && tags.every((t) => typeof t === "string" && TAG.test(t)))
  ) {
    fields.tags = "up to 20 unique tags matching ^[a-z0-9][a-z0-9_:.-]{0,39}$";
  }
  const utm = body.utm_defaults;
  if (
    utm !== undefined &&
    !(
      utm &&
      typeof utm === "object" &&
      !Array.isArray(utm) &&
      Object.entries(utm).every(([k, v]) => UTM_KEYS.has(k) && isString(v, 1, 200))
    )
  ) {
    fields.utm_defaults = "object of utm_source, utm_medium, utm_campaign, utm_term, utm_content strings";
  }
  if (body.pass_click_id !== undefined && typeof body.pass_click_id !== "boolean") fields.pass_click_id = "boolean";
  if (body.expires_at !== undefined) {
    const ok = typeof body.expires_at === "string" && RFC3339.test(body.expires_at) && Date.parse(body.expires_at) > now.getTime();
    if (!ok) fields.expires_at = "RFC 3339 date-time in the future";
  }
  const ref = body.external_ref as Record<string, unknown> | undefined;
  if (
    ref !== undefined &&
    !(
      ref &&
      typeof ref === "object" &&
      Object.keys(ref).length === 3 &&
      isString(ref.service, 1, 64) &&
      isString(ref.entity_type, 1, 64) &&
      isString(ref.entity_id, 1, 128)
    )
  ) {
    fields.external_ref = "object with service, entity_type, entity_id";
  }
  return fields;
}

export function toLink(row: LinkRow, publicOrigin: string, now = new Date()) {
  const status = row.disabled_at ? "disabled" : row.expires_at && row.expires_at <= now ? "expired" : "active";
  return {
    id: row.id,
    code: row.code,
    short_url: `${publicOrigin}/${row.code}`,
    target_url: row.target_url,
    title: row.title,
    tags: row.tags,
    utm_defaults: row.utm_defaults,
    pass_click_id: row.pass_click_id,
    expires_at: row.expires_at,
    external_ref: row.ext_service
      ? { service: row.ext_service, entity_type: row.ext_entity_type, entity_id: row.ext_entity_id }
      : null,
    status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    disabled_at: row.disabled_at,
  };
}

const uniqueViolation = (err: unknown): string | null => {
  const e = err as { errno?: string; constraint?: string } | null;
  return e?.errno === "23505" ? (e.constraint ?? "") : null;
};

// Key order must not change the hash, so objects are serialised with sorted keys.
const canonical = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(canonical).join(",")}]`
    : v && typeof v === "object"
      ? `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
          .join(",")}}`
      : JSON.stringify(v);
const bodyHash = (body: unknown) => new Bun.CryptoHasher("sha256").update(canonical(body)).digest("hex");

type Deps = {
  sql: SQL;
  publicOrigin: string;
  resolveHost?: (host: string) => Promise<string[]>;
  createLimit?: RateLimit;
};

export function linkRoutes({ sql, publicOrigin, resolveHost, createLimit = { perMinute: 60, burst: 20 } }: Deps) {
  const app = new Hono<AuthEnv>();
  const ownHost = new URL(publicOrigin).hostname;
  const limitCreate = createRateLimiter(createLimit);

  // An earlier create this request must replay: same Idempotency-Key, or same external_ref.
  const findExisting = async (serviceId: string, key: string | null, hash: string, ref: LinkInput["external_ref"]) => {
    if (key) {
      const [row] = await sql`select * from links where service_id = ${serviceId} and idempotency_key = ${key}`;
      if (row) return row.idempotency_hash === hash ? { link: row as LinkRow } : { reused: true as const };
    }
    if (ref) {
      const [row] = await sql`
        select * from links where service_id = ${serviceId}
          and ext_service = ${ref.service} and ext_entity_type = ${ref.entity_type} and ext_entity_id = ${ref.entity_id}`;
      if (row) return { link: row as LinkRow };
    }
    return null;
  };

  app.post("/links", requireScope("links:write"), async (c) => {
    const caller = c.get("caller");
    const limit = limitCreate(caller.keyId);
    c.header("RateLimit-Limit", String(limitCreate.burst));
    c.header("RateLimit-Remaining", String(limit.remaining));
    if (!limit.ok) {
      c.header("Retry-After", String(limit.retryAfterSeconds));
      return apiError(c, 429, "rate_limited", "Too many link creates for this key.");
    }

    const idempotencyKey = c.req.header("idempotency-key") ?? null;
    if (idempotencyKey !== null && (idempotencyKey.length < 1 || idempotencyKey.length > 255)) {
      return apiError(c, 400, "invalid_request", "Idempotency-Key must be 1-255 characters.");
    }
    const body = await readJsonObject(c);
    if (!body) return apiError(c, 400, "invalid_request", "Body must be a JSON object.");
    const fields = validateLinkCreate(body, new Date());
    if (Object.keys(fields).length) return validationFailed(c, fields);
    const input = body as LinkInput;
    const hash = bodyHash(body);

    const replay = async () => {
      const existing = await findExisting(caller.serviceId, idempotencyKey, hash, input.external_ref);
      if (!existing) return null;
      if ("reused" in existing) {
        return apiError(c, 422, "idempotency_key_reused", "This Idempotency-Key was used with a different body.");
      }
      return c.json(toLink(existing.link, publicOrigin), 200);
    };
    const replayed = await replay();
    if (replayed) return replayed;

    if (input.code && RESERVED.has(input.code.toLowerCase())) {
      return apiError(c, 422, "code_reserved", `"${input.code}" is a reserved path.`);
    }
    const rejection = await checkTarget(input.target_url, { ownHost, resolve: resolveHost });
    if (rejection) return apiError(c, 422, "target_rejected", "The target URL is not allowed.", { reason: rejection });

    const serviceId = caller.serviceId;
    for (let attempt = 0; ; attempt++) {
      const code = input.code ?? randomBase62(7);
      try {
        const [row]: LinkRow[] = await sql`
          insert into links (id, service_id, code, target_url, title, tags, utm_defaults, pass_click_id,
                             expires_at, ext_service, ext_entity_type, ext_entity_id, idempotency_key, idempotency_hash)
          values (${Bun.randomUUIDv7()}, ${serviceId}, ${code}, ${input.target_url}, ${input.title ?? null},
                  ${sql.array(input.tags ?? [], "text")}, ${input.utm_defaults ?? null}, ${input.pass_click_id ?? false},
                  ${input.expires_at ?? null}, ${input.external_ref?.service ?? null},
                  ${input.external_ref?.entity_type ?? null}, ${input.external_ref?.entity_id ?? null},
                  ${idempotencyKey}, ${idempotencyKey ? hash : null})
          returning *`;
        c.header("Location", `/v1/links/${row!.id}`);
        return c.json(toLink(row!, publicOrigin), 201);
      } catch (err) {
        const constraint = uniqueViolation(err);
        // A concurrent create with the same key or external_ref won the race: replay it.
        if (constraint === "links_idempotency_key_idx" || constraint === "links_external_ref_idx") {
          const replayedAfterRace = await replay();
          if (replayedAfterRace) return replayedAfterRace;
        }
        if (constraint !== "links_code_key") throw err;
        if (input.code) return apiError(c, 409, "code_taken", `The code "${input.code}" is already in use.`);
        if (attempt >= 4) throw err;
      }
    }
  });

  app.get("/links/:id", requireScope("links:read"), async (c) => {
    const id = c.req.param("id");
    const [row] = isUuid(id)
      ? await sql`select * from links where id = ${id} and service_id = ${c.get("caller").serviceId}`
      : [];
    if (!row) return apiError(c, 404, "not_found", "Link not found.");
    return c.json(toLink(row as LinkRow, publicOrigin));
  });

  return app;
}
