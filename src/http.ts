import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export type ErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "missing_scope"
  | "not_found"
  | "code_taken"
  | "link_disabled"
  | "validation_failed"
  | "target_rejected"
  | "code_reserved"
  | "idempotency_key_reused"
  | "conversion_conflict"
  | "range_too_large"
  | "scope_not_allowed"
  | "rate_limited"
  | "internal";

export function apiError(
  c: Context,
  status: ContentfulStatusCode,
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
) {
  return c.json({ error: { code, message, ...(details ? { details } : {}) } }, status);
}

export const validationFailed = (c: Context, fields: Record<string, string>) =>
  apiError(c, 422, "validation_failed", "Request body failed validation.", { fields });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID.test(s);

// An RFC 3339 date-time that is also a real instant. The shape alone lets month 13 or hour 25
// through, and Date.parse rolls February 30 over to March 2 where Postgres refuses it.
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
export function isDateTime(s: string): boolean {
  const m = RFC3339.exec(s);
  if (!m || Number.isNaN(Date.parse(s))) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return new Date(Date.UTC(year, month - 1, day)).getUTCDate() === day;
}

export async function readJsonObject(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const body = await c.req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

// Cursors are the last row's id (UUIDv7, so creation order), base64url-encoded to stay opaque.
export const encodeCursor = (id: string) => Buffer.from(id).toString("base64url");
export function decodeCursor(cursor: string | undefined): string | null | undefined {
  if (cursor === undefined) return undefined;
  const id = Buffer.from(cursor, "base64url").toString();
  return isUuid(id) ? id : null;
}

export function parseLimit(raw: string | undefined, fallback = 50): number | null {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 100 ? n : null;
}

// Every write must come from one of our own pages. Hono's csrf() checks only form-style requests,
// so a POST with no body or a JSON body would pass it; this checks the Origin of any non-GET.
export const sameOrigin = (publicOrigin: string) => async (c: Context, next: () => Promise<void>) => {
  const method = c.req.method;
  if (method !== "GET" && method !== "HEAD" && c.req.header("origin") !== publicOrigin) return c.text("Forbidden", 403);
  await next();
};
