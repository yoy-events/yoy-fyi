// People who sign in with Google (ADR-0004). Each user owns one personal service, so their links,
// keys, analytics and webhooks run through exactly the same code as any other service.
import type { SQL } from "bun";
import type { Context } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { isUuid } from "./http";

const COOKIE = "yfi_user";
const SESSION_TTL_MS = 30 * 86_400_000;

export type User = { id: string; email: string; name: string | null; serviceId: string };

const slug = () => `u-${Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("")}`;

// Finds or creates the user for a verified Google identity. Returns null for a blocked user.
export async function upsertGoogleUser(
  sql: SQL,
  claims: { sub: string; email: string; name?: string | null },
  now: Date,
): Promise<{ id: string } | null> {
  return sql.begin(async (tx) => {
    const [user] = await tx`
      insert into users (id, google_sub, email, name, last_seen_at)
      values (${Bun.randomUUIDv7()}, ${claims.sub}, ${claims.email}, ${claims.name ?? null}, ${now})
      on conflict (google_sub) do update set email = excluded.email, name = excluded.name, last_seen_at = excluded.last_seen_at
      returning id, disabled_at`;
    if (user.disabled_at) return null;
    await tx`
      insert into services (id, slug, name, owner_user_id)
      values (${Bun.randomUUIDv7()}, ${slug()}, ${claims.email}, ${user.id})
      on conflict (owner_user_id) do nothing`;
    return { id: user.id };
  });
}

export const setUserSession = (c: Context, secret: string, userId: string, now: Date) =>
  setSignedCookie(c, COOKIE, `${userId}|${now.getTime() + SESSION_TTL_MS}`, secret, {
    prefix: "host",
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });

export const clearUserSession = (c: Context) => deleteCookie(c, COOKIE, { prefix: "host", path: "/", secure: true });

// The signed-in, not blocked user with their personal service, or null.
export async function currentUser(c: Context, sql: SQL, secret: string, now: Date): Promise<User | null> {
  const value = await getSignedCookie(c, secret, COOKIE, "host");
  const [id, expires] = typeof value === "string" ? value.split("|") : [];
  if (!id || !isUuid(id) || !(Number(expires) > now.getTime())) return null;
  const [user] = await sql`
    select u.id, u.email, u.name, s.id as service_id
    from users u join services s on s.owner_user_id = u.id
    where u.id = ${id} and u.disabled_at is null and s.disabled_at is null`;
  return user ? { id: user.id, email: user.email, name: user.name, serviceId: user.service_id } : null;
}
