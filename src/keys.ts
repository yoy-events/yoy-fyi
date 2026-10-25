import type { SQL } from "bun";
import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { AuthEnv } from "./auth";
import { requireScope } from "./auth";
import { apiError, decodeCursor, encodeCursor, isUuid, parseLimit, readJsonObject, validationFailed } from "./http";

export const SCOPES = ["links:write", "links:read", "analytics:read", "keys:manage", "webhooks:manage"] as const;
export type Scope = (typeof SCOPES)[number];

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const TOKEN = /^yfi_([A-Za-z0-9]{8})_([A-Za-z0-9]{32})$/;

export function randomBase62(length: number): string {
  let out = "";
  while (out.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) {
      // 248 = 4 * 62: rejecting the rest keeps every character equally likely.
      if (byte < 248 && out.length < length) out += ALPHABET[byte % 62];
    }
  }
  return out;
}

const sha256 = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");

type KeyRow = {
  id: string;
  name: string;
  prefix: string;
  scopes: Scope[];
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
};

export const toApiKey = (row: KeyRow) => ({
  id: row.id,
  name: row.name,
  prefix: `yfi_${row.prefix}`,
  scopes: row.scopes,
  created_at: row.created_at,
  last_used_at: row.last_used_at,
  revoked_at: row.revoked_at,
});

const KEY_COLUMNS = "id, name, prefix, scopes, created_at, last_used_at, revoked_at";

async function insertKey(sql: SQL, serviceId: string, name: string, scopes: readonly Scope[]) {
  const prefix = randomBase62(8);
  const secret = randomBase62(32);
  const [row]: KeyRow[] = await sql`
    insert into api_keys (id, service_id, prefix, secret_hash, scopes, name)
    values (${Bun.randomUUIDv7()}, ${serviceId}, ${prefix}, ${sha256(secret)}, ${sql.array([...scopes], "text")}, ${name})
    returning ${sql.unsafe(KEY_COLUMNS)}`;
  return { token: `yfi_${prefix}_${secret}`, key: toApiKey(row!) };
}

// Used by the CLI and the admin UI: creates the service on first use.
export async function issueKey(sql: SQL, input: { serviceSlug: string; name: string; scopes: readonly Scope[] }) {
  const [service] = await sql`
    insert into services (id, slug, name) values (${Bun.randomUUIDv7()}, ${input.serviceSlug}, ${input.serviceSlug})
    on conflict (slug) do update set slug = excluded.slug
    returning id`;
  return insertKey(sql, service.id, input.name, input.scopes);
}

// `client` is the OAuth client_id when the caller is an OAuth grant (ADR-0003), absent for API keys.
export type Caller = { keyId: string; serviceId: string; scopes: Scope[]; client?: string };

export async function authenticate(sql: SQL, header: string | undefined): Promise<Caller | null> {
  const match = TOKEN.exec(header?.replace(/^Bearer /, "") ?? "");
  if (!match) return null;
  const [, prefix, secret] = match;
  const [row] = await sql`
    select k.id, k.service_id, k.scopes, k.secret_hash
    from api_keys k join services s on s.id = k.service_id
    left join users u on u.id = s.owner_user_id
    where k.prefix = ${prefix} and k.revoked_at is null and s.disabled_at is null and u.disabled_at is null`;
  if (!row) return null;
  const expected = Buffer.from(row.secret_hash, "hex");
  const actual = Buffer.from(sha256(secret!), "hex");
  if (!timingSafeEqual(expected, actual)) return null;
  return { keyId: row.id, serviceId: row.service_id, scopes: row.scopes };
}

export function keyRoutes(sql: SQL) {
  const app = new Hono<AuthEnv>();

  app.get("/me", async (c) => {
    const caller = c.get("caller");
    const [service] = await sql`select id, slug, name from services where id = ${caller.serviceId}`;
    const [key]: KeyRow[] = await sql`select ${sql.unsafe(KEY_COLUMNS)} from api_keys where id = ${caller.keyId}`;
    return c.json({ service, key: toApiKey(key!) });
  });

  app.get("/keys", requireScope("keys:manage"), async (c) => {
    const limit = parseLimit(c.req.query("limit"));
    const cursor = decodeCursor(c.req.query("cursor"));
    if (limit === null || cursor === null) return apiError(c, 400, "invalid_request", "Invalid limit or cursor.");
    const includeRevoked = c.req.query("include_revoked") === "true";
    const rows: KeyRow[] = await sql`
      select ${sql.unsafe(KEY_COLUMNS)} from api_keys
      where service_id = ${c.get("caller").serviceId}
        and (${includeRevoked} or revoked_at is null)
        and (${cursor ?? null}::uuid is null or id < ${cursor ?? null}::uuid)
      order by id desc
      limit ${limit + 1}`;
    const page = rows.slice(0, limit);
    return c.json({
      data: page.map(toApiKey),
      next_cursor: rows.length > limit ? encodeCursor(page.at(-1)!.id) : null,
    });
  });

  app.post("/keys", requireScope("keys:manage"), async (c) => {
    const body = await readJsonObject(c);
    if (!body) return apiError(c, 400, "invalid_request", "Body must be a JSON object.");
    const fields: Record<string, string> = {};
    const { name, scopes } = body;
    for (const extra of Object.keys(body).filter((k) => k !== "name" && k !== "scopes")) fields[extra] = "unknown field";
    if (typeof name !== "string" || name.length < 1 || name.length > 100) fields.name = "1-100 characters";
    const validScopes =
      Array.isArray(scopes) &&
      scopes.length > 0 &&
      new Set(scopes).size === scopes.length &&
      scopes.every((s) => (SCOPES as readonly unknown[]).includes(s));
    if (!validScopes) fields.scopes = `non-empty unique list of ${SCOPES.join(", ")}`;
    if (Object.keys(fields).length) return validationFailed(c, fields);

    const caller = c.get("caller");
    const granted = scopes as Scope[];
    if (!granted.every((s) => caller.scopes.includes(s))) {
      return apiError(c, 422, "scope_not_allowed", "A key cannot grant scopes it does not have.");
    }
    const { token, key } = await insertKey(sql, caller.serviceId, name as string, granted);
    return c.json({ key, secret: token }, 201);
  });

  app.post("/keys/:id/revoke", requireScope("keys:manage"), async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) return apiError(c, 404, "not_found", "Key not found.");
    const [row]: KeyRow[] = await sql`
      update api_keys set revoked_at = coalesce(revoked_at, now())
      where id = ${id} and service_id = ${c.get("caller").serviceId}
      returning ${sql.unsafe(KEY_COLUMNS)}`;
    if (!row) return apiError(c, 404, "not_found", "Key not found.");
    return c.json(toApiKey(row));
  });

  return app;
}
