import type { SQL } from "bun";
import { Hono } from "hono";
import QRCode from "qrcode";
import { type AuthEnv, requireScope } from "./auth";
import {
  apiError,
  decodeCursor,
  encodeCursor,
  isUuid,
  parseLimit,
  readJsonObject,
  validationFailed,
} from "./http";
import { randomBase62 } from "./keys";
import { type RateLimit, createRateLimiter } from "./ratelimit";
import type { UnsafeUrls } from "./safe-browsing";
import { checkTarget } from "./target-policy";

// System paths that can never be link codes, compared case-insensitively.
const RESERVED = new Set(["v1", "admin", "health", "qr", "static", "openapi", "robots", "favicon", "mcp", "oauth", "links", "account", "login", "logout", "privacy", "terms", "telegram", "blog", "docs", "en", "es", "fr", "uk", "lang"]);
const CODE = /^[A-Za-z0-9_-]{1,64}$/;
const TAG = /^[a-z0-9][a-z0-9_:.-]{0,39}$/;
const UTM_KEYS = new Set(["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"]);
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export type LinkRow = {
  id: string;
  code: string;
  target_url: string;
  title: string | null;
  tags: string[];
  utm_defaults: Record<string, string> | null;
  preview: Preview | null;
  pass_click_id: boolean;
  expires_at: Date | null;
  ext_service: string | null;
  ext_entity_type: string | null;
  ext_entity_id: string | null;
  created_at: Date;
  updated_at: Date;
  disabled_at: Date | null;
  disabled_by: "owner" | "admin" | "safe_browsing" | null;
  created_via: CreatedVia;
  created_by_client: string | null;
};

// The Open Graph preview link-preview bots see instead of the redirect (see app.ts).
export type Preview = { title: string; description?: string; image?: string };

export type CreatedVia = "api" | "admin" | "mcp" | "web" | "telegram";

export type LinkInput = {
  target_url: string;
  code?: string;
  title?: string;
  tags?: string[];
  utm_defaults?: Record<string, string>;
  preview?: Preview;
  pass_click_id?: boolean;
  expires_at?: string;
  external_ref?: { service: string; entity_type: string; entity_id: string };
};

const isString = (v: unknown, min: number, max: number): v is string =>
  typeof v === "string" && v.length >= min && v.length <= max;

type Check = { ok: (v: unknown, now: Date) => boolean; rule: string; nullable?: boolean };

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

const FIELDS: Record<string, Check> = {
  target_url: { ok: (v) => isString(v, 1, 2048), rule: "URL string, at most 2048 characters" },
  code: { ok: (v) => typeof v === "string" && CODE.test(v), rule: "1-64 characters of A-Z a-z 0-9 _ -" },
  title: { ok: (v) => isString(v, 0, 200), rule: "string, at most 200 characters", nullable: true },
  tags: {
    ok: (v) =>
      Array.isArray(v) &&
      v.length <= 20 &&
      new Set(v).size === v.length &&
      v.every((t) => typeof t === "string" && TAG.test(t)),
    rule: "up to 20 unique tags matching ^[a-z0-9][a-z0-9_:.-]{0,39}$",
  },
  utm_defaults: {
    ok: (v) => isPlainObject(v) && Object.entries(v).every(([k, x]) => UTM_KEYS.has(k) && isString(x, 1, 200)),
    rule: "object of utm_source, utm_medium, utm_campaign, utm_term, utm_content strings",
    nullable: true,
  },
  preview: {
    ok: (v) =>
      isPlainObject(v) &&
      Object.keys(v).every((k) => ["title", "description", "image"].includes(k)) &&
      isString(v.title, 1, 200) &&
      (v.description === undefined || isString(v.description, 0, 500)) &&
      (v.image === undefined || (isString(v.image, 1, 2048) && /^https:\/\/[^\s]+$/.test(v.image) && URL.canParse(v.image))),
    rule: "object with title (1-200), optional description (up to 500) and image (https URL)",
    nullable: true,
  },
  pass_click_id: { ok: (v) => typeof v === "boolean", rule: "boolean" },
  expires_at: {
    ok: (v, now) => typeof v === "string" && RFC3339.test(v) && Date.parse(v) > now.getTime(),
    rule: "RFC 3339 date-time in the future",
    nullable: true,
  },
  external_ref: {
    ok: (v) =>
      isPlainObject(v) &&
      Object.keys(v).length === 3 &&
      isString(v.service, 1, 64) &&
      isString(v.entity_type, 1, 64) &&
      isString(v.entity_id, 1, 128),
    rule: "object with service, entity_type, entity_id",
  },
};

const UPDATABLE = new Set(["target_url", "title", "tags", "utm_defaults", "preview", "pass_click_id", "expires_at"]);

function checkFields(body: Record<string, unknown>, allowNull: boolean, now: Date): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) {
    const check = FIELDS[key];
    if (!check) fields[key] = "unknown field";
    else if (value === null ? !(allowNull && check.nullable) : !check.ok(value, now)) fields[key] = check.rule;
  }
  return fields;
}

export function validateLinkCreate(body: Record<string, unknown>, now: Date): Record<string, string> {
  const fields = checkFields(body, false, now);
  if (body.target_url === undefined) fields.target_url = `required ${FIELDS.target_url!.rule}`;
  return fields;
}

export function validateLinkUpdate(body: Record<string, unknown>, now: Date): Record<string, string> {
  const fields = checkFields(body, true, now);
  for (const key of Object.keys(body)) if (FIELDS[key] && !UPDATABLE.has(key)) fields[key] = "cannot change";
  if (Object.keys(body).length === 0) fields.body = "at least one field to change";
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
    preview: row.preview,
    pass_click_id: row.pass_click_id,
    expires_at: row.expires_at,
    external_ref: row.ext_service
      ? { service: row.ext_service, entity_type: row.ext_entity_type, entity_id: row.ext_entity_id }
      : null,
    status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    disabled_at: row.disabled_at,
    created_via: row.created_via,
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

type CreateResult =
  | { kind: "created" | "existing"; row: LinkRow }
  | {
      kind: "error";
      status: 409 | 422;
      code: "validation_failed" | "idempotency_key_reused" | "code_reserved" | "target_rejected" | "code_taken";
      message: string;
      details?: Record<string, unknown>;
    };

// An earlier create that this request must replay: same Idempotency-Key, or same external_ref.
async function findExisting(sql: SQL, serviceId: string, key: string | null, hash: string, ref: LinkInput["external_ref"]) {
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
}

// The target and the preview image pass the same policy, Safe Browsing included: bots fetch the
// image, and a preview must not point people at what the target check would refuse.
async function rejectedUrl(
  body: Record<string, unknown>,
  opts: { ownHost: string; resolveHost?: (host: string) => Promise<string[]>; unsafeUrls?: UnsafeUrls },
) {
  const image = (body.preview as Preview | null | undefined)?.image;
  for (const [field, url] of [["target_url", body.target_url], ["preview.image", image]] as const) {
    if (typeof url !== "string") continue;
    const reason = await checkTarget(url, { ownHost: opts.ownHost, resolve: opts.resolveHost, unsafeUrls: opts.unsafeUrls });
    if (reason) {
      const message = field === "target_url" ? "The target URL is not allowed." : "The preview image URL is not allowed.";
      return { kind: "error", status: 422, code: "target_rejected", message, details: field === "target_url" ? { reason } : { reason, field } } as const;
    }
  }
  return null;
}

// Creates a link for a service with every rule the API applies: validation, idempotency,
// reserved codes, the target policy and code generation. Shared by /v1 and the admin UI.
export async function createLink(
  sql: SQL,
  { ownHost, resolveHost, unsafeUrls }: { ownHost: string; resolveHost?: (host: string) => Promise<string[]>; unsafeUrls?: UnsafeUrls },
  serviceId: string,
  body: Record<string, unknown>,
  idempotencyKey: string | null = null,
  createdVia: CreatedVia = "api",
  createdByClient: string | null = null,
): Promise<CreateResult> {
  const fields = validateLinkCreate(body, new Date());
  if (Object.keys(fields).length) {
    return { kind: "error", status: 422, code: "validation_failed", message: "Request body failed validation.", details: { fields } };
  }
  const input = body as LinkInput;
  const hash = bodyHash(body);

  const replay = async (): Promise<CreateResult | null> => {
    const existing = await findExisting(sql, serviceId, idempotencyKey, hash, input.external_ref);
    if (!existing) return null;
    if ("reused" in existing) {
      return {
        kind: "error",
        status: 422,
        code: "idempotency_key_reused",
        message: "This Idempotency-Key was used with a different body.",
      };
    }
    return { kind: "existing", row: existing.link };
  };
  const replayed = await replay();
  if (replayed) return replayed;

  if (input.code && RESERVED.has(input.code.toLowerCase())) {
    return { kind: "error", status: 422, code: "code_reserved", message: `"${input.code}" is a reserved path.` };
  }
  const rejected = await rejectedUrl(body, { ownHost, resolveHost, unsafeUrls });
  if (rejected) return rejected;

  for (let attempt = 0; ; attempt++) {
    const code = input.code ?? randomBase62(7);
    try {
      const [row]: LinkRow[] = await sql`
        insert into links (id, service_id, code, target_url, title, tags, utm_defaults, preview, pass_click_id,
                           expires_at, ext_service, ext_entity_type, ext_entity_id, idempotency_key, idempotency_hash,
                           created_via, created_by_client)
        values (${Bun.randomUUIDv7()}, ${serviceId}, ${code}, ${input.target_url}, ${input.title ?? null},
                ${sql.array(input.tags ?? [], "text")}, ${input.utm_defaults ?? null}, ${input.preview ?? null}, ${input.pass_click_id ?? false},
                ${input.expires_at ?? null}, ${input.external_ref?.service ?? null},
                ${input.external_ref?.entity_type ?? null}, ${input.external_ref?.entity_id ?? null},
                ${idempotencyKey}, ${idempotencyKey ? hash : null}, ${createdVia}, ${createdByClient})
        returning *`;
      return { kind: "created", row: row! };
    } catch (err) {
      const constraint = uniqueViolation(err);
      // A concurrent create with the same key or external_ref won the race: replay it.
      if (constraint === "links_idempotency_key_idx" || constraint === "links_external_ref_idx") {
        const replayedAfterRace = await replay();
        if (replayedAfterRace) return replayedAfterRace;
      }
      if (constraint !== "links_code_key") throw err;
      if (input.code) return { kind: "error", status: 409, code: "code_taken", message: `The code "${input.code}" is already in use.` };
      if (attempt >= 4) throw err;
    }
  }
}

type Deps = {
  sql: SQL;
  publicOrigin: string;
  resolveHost?: (host: string) => Promise<string[]>;
  unsafeUrls?: UnsafeUrls;
  createLimit?: RateLimit;
};

// The MCP endpoint dispatches into these routes in-process and sets `createdVia` as a binding,
// which a client request cannot set.
type UpdateResult =
  | { kind: "updated"; row: LinkRow }
  | {
      kind: "error";
      status: 404 | 409 | 422;
      code: "not_found" | "link_disabled" | "validation_failed" | "target_rejected";
      message: string;
      details?: Record<string, unknown>;
    };

// Changes an active link of a service with the same rules everywhere: /v1 PATCH and the web page.
export async function updateLink(
  sql: SQL,
  { ownHost, resolveHost, unsafeUrls }: { ownHost: string; resolveHost?: (host: string) => Promise<string[]>; unsafeUrls?: UnsafeUrls },
  serviceId: string,
  id: string,
  body: Record<string, unknown>,
): Promise<UpdateResult> {
  const fields = validateLinkUpdate(body, new Date());
  if (Object.keys(fields).length) {
    return { kind: "error", status: 422, code: "validation_failed", message: "Request body failed validation.", details: { fields } };
  }
  const [link] = await sql`select disabled_at from links where id = ${id} and service_id = ${serviceId}`;
  if (!link) return { kind: "error", status: 404, code: "not_found", message: "Link not found." };
  const disabled = { kind: "error", status: 409, code: "link_disabled", message: "A disabled link cannot be changed." } as const;
  if (link.disabled_at) return disabled;
  const rejected = await rejectedUrl(body, { ownHost, resolveHost, unsafeUrls });
  if (rejected) return rejected;

  const changes = { ...body, updated_at: new Date() } as Record<string, unknown>;
  if (Array.isArray(body.tags)) changes.tags = sql.array(body.tags, "text");
  const [row] = await sql`
    update links set ${sql(changes)}
    where id = ${id} and service_id = ${serviceId} and disabled_at is null
    returning *`;
  return row ? { kind: "updated", row: row as LinkRow } : disabled;
}

type LinkEnv = AuthEnv & { Bindings: { createdVia?: CreatedVia } };

export function linkRoutes({ sql, publicOrigin, resolveHost, unsafeUrls, createLimit = { perMinute: 60, burst: 20 } }: Deps) {
  const app = new Hono<LinkEnv>();
  const ownHost = new URL(publicOrigin).hostname;
  const limitCreate = createRateLimiter(createLimit);

  app.post("/links", requireScope("links:write"), async (c) => {
    const caller = c.get("caller");
    // Per service, so creating more keys does not raise the limit.
    const limit = limitCreate(caller.serviceId);
    c.header("RateLimit-Limit", String(limitCreate.burst));
    c.header("RateLimit-Remaining", String(limit.remaining));
    if (!limit.ok) {
      c.header("Retry-After", String(limit.retryAfterSeconds));
      return apiError(c, 429, "rate_limited", "Too many link creates for this service.");
    }

    const idempotencyKey = c.req.header("idempotency-key") ?? null;
    if (idempotencyKey !== null && (idempotencyKey.length < 1 || idempotencyKey.length > 255)) {
      return apiError(c, 400, "invalid_request", "Idempotency-Key must be 1-255 characters.");
    }
    const body = await readJsonObject(c);
    if (!body) return apiError(c, 400, "invalid_request", "Body must be a JSON object.");
    const result = await createLink(sql, { ownHost, resolveHost, unsafeUrls }, caller.serviceId, body, idempotencyKey, c.env?.createdVia, caller.client ?? null);
    if (result.kind === "error") return apiError(c, result.status, result.code, result.message, result.details);
    if (result.kind === "created") c.header("Location", `/v1/links/${result.row.id}`);
    return c.json(toLink(result.row, publicOrigin), result.kind === "created" ? 201 : 200);
  });

  app.get("/links", requireScope("links:read"), async (c) => {
    const q = c.req.query();
    const limit = parseLimit(q.limit);
    const cursor = decodeCursor(q.cursor);
    const status = q.status ?? "all";
    const bad =
      limit === null ||
      cursor === null ||
      !["active", "expired", "disabled", "all"].includes(status) ||
      (q.tag !== undefined && !TAG.test(q.tag)) ||
      (q.code !== undefined && !CODE.test(q.code)) ||
      (q.q !== undefined && q.q.length > 200) ||
      [q.created_after, q.created_before].some((t) => t !== undefined && !RFC3339.test(t));
    if (bad) return apiError(c, 400, "invalid_request", "Invalid query parameter.");
    // `q` matches code, title or target as plain text; LIKE wildcards in it are escaped.
    const search = (q.q ?? "").trim();
    const pattern = `%${search.replace(/[\\%_]/g, "\\$&")}%`;

    const rows: LinkRow[] = await sql`
      select * from links
      where service_id = ${c.get("caller").serviceId}
        and (${q.tag ?? null}::text is null or tags @> array[${q.tag ?? null}::text])
        and (${q.code ?? null}::text is null or code = ${q.code ?? null})
        and (${search} = '' or code ilike ${pattern} or title ilike ${pattern} or target_url ilike ${pattern})
        and (${q.ext_service ?? null}::text is null or ext_service = ${q.ext_service ?? null})
        and (${q.ext_entity_type ?? null}::text is null or ext_entity_type = ${q.ext_entity_type ?? null})
        and (${q.ext_entity_id ?? null}::text is null or ext_entity_id = ${q.ext_entity_id ?? null})
        and (${q.created_after ?? null}::timestamptz is null or created_at >= ${q.created_after ?? null}::timestamptz)
        and (${q.created_before ?? null}::timestamptz is null or created_at < ${q.created_before ?? null}::timestamptz)
        and (${cursor ?? null}::uuid is null or id < ${cursor ?? null}::uuid)
        and case ${status}
          when 'disabled' then disabled_at is not null
          when 'expired' then disabled_at is null and expires_at <= now()
          when 'active' then disabled_at is null and (expires_at is null or expires_at > now())
          else true
        end
      order by id desc
      limit ${limit + 1}`;
    const page = rows.slice(0, limit);
    return c.json({
      data: page.map((row) => toLink(row, publicOrigin)),
      next_cursor: rows.length > limit ? encodeCursor(page.at(-1)!.id) : null,
    });
  });

  app.patch("/links/:id", requireScope("links:write"), async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) return apiError(c, 404, "not_found", "Link not found.");
    const body = await readJsonObject(c);
    if (!body) return apiError(c, 400, "invalid_request", "Body must be a JSON object.");
    const result = await updateLink(sql, { ownHost, resolveHost, unsafeUrls }, c.get("caller").serviceId, id, body);
    if (result.kind === "error") return apiError(c, result.status, result.code, result.message, result.details);
    return c.json(toLink(result.row, publicOrigin));
  });

  app.post("/links/:id/disable", requireScope("links:write"), async (c) => {
    const id = c.req.param("id");
    const [row] = isUuid(id)
      ? await sql`
          update links set disabled_at = coalesce(disabled_at, now()),
                           disabled_by = case when disabled_at is null then 'owner' else disabled_by end,
                           updated_at = case when disabled_at is null then now() else updated_at end
          where id = ${id} and service_id = ${c.get("caller").serviceId}
          returning *`
      : [];
    if (!row) return apiError(c, 404, "not_found", "Link not found.");
    return c.json(toLink(row as LinkRow, publicOrigin));
  });

  const findOwnLink = async (id: string, serviceId: string) =>
    isUuid(id) ? ((await sql`select * from links where id = ${id} and service_id = ${serviceId}`)[0] as LinkRow | undefined) : undefined;

  app.get("/links/:id/qr.svg", requireScope("links:read"), async (c) => {
    const link = await findOwnLink(c.req.param("id"), c.get("caller").serviceId);
    if (!link) return apiError(c, 404, "not_found", "Link not found.");
    const svg = await QRCode.toString(`${publicOrigin}/${link.code}`, { type: "svg", margin: 2 });
    return c.body(svg, 200, { "Content-Type": "image/svg+xml" });
  });

  app.get("/links/:id/qr.png", requireScope("links:read"), async (c) => {
    const raw = c.req.query("size");
    const size = raw === undefined ? 512 : Number(raw);
    if (!Number.isInteger(size) || size < 128 || size > 2048) return validationFailed(c, { size: "integer 128-2048" });
    const link = await findOwnLink(c.req.param("id"), c.get("caller").serviceId);
    if (!link) return apiError(c, 404, "not_found", "Link not found.");
    const png = await QRCode.toBuffer(`${publicOrigin}/${link.code}`, { type: "png", width: size, margin: 2 });
    return c.body(new Uint8Array(png), 200, { "Content-Type": "image/png" });
  });

  app.get("/links/:id", requireScope("links:read"), async (c) => {
    const link = await findOwnLink(c.req.param("id"), c.get("caller").serviceId);
    if (!link) return apiError(c, 404, "not_found", "Link not found.");
    return c.json(toLink(link, publicOrigin));
  });

  return app;
}
