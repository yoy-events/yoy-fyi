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
