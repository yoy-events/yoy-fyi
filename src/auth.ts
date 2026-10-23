import type { SQL } from "bun";
import { createMiddleware } from "hono/factory";
import { apiError } from "./http";
import { type Caller, type Scope, authenticate } from "./keys";

export type AuthEnv = { Variables: { caller: Caller } };

// last_used_at is written at most once a minute per key, from this process.
export function requireKey(sql: SQL) {
  const touchedAt = new Map<string, number>();
  return createMiddleware<AuthEnv>(async (c, next) => {
    const caller = await authenticate(sql, c.req.header("authorization"));
    if (!caller) return apiError(c, 401, "unauthorized", "Missing, unknown or revoked API key.");
    const now = Date.now();
    if (now - (touchedAt.get(caller.keyId) ?? 0) >= 60_000) {
      touchedAt.set(caller.keyId, now);
      await sql`update api_keys set last_used_at = now() where id = ${caller.keyId}`;
    }
    c.set("caller", caller);
    await next();
  });
}

export const requireScope = (scope: Scope) =>
  createMiddleware<AuthEnv>(async (c, next) => {
    if (!c.get("caller").scopes.includes(scope)) {
      return apiError(c, 403, "missing_scope", `This key lacks the ${scope} scope.`);
    }
    await next();
  });
