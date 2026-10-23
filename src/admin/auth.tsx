import type { SQL } from "bun";
import { Hono } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { createRateLimiter, rateLimitKey } from "../ratelimit";
import { Layout } from "./layout";

export type AdminConfig = {
  email: string;
  sessionSecret: string;
  sendEmail: (mail: { to: string; subject: string; text: string }) => Promise<void>;
};

type Deps = { sql: SQL; publicOrigin: string; admin: AdminConfig; now: () => Date };
type Env = { Bindings: { ip?: string } };

const COOKIE = "yfi_admin";
const TOKEN_TTL_MS = 15 * 60_000;
const SESSION_TTL_MS = 7 * 86_400_000;

const sha256 = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");

// The session is a signed cookie holding the admin email and an expiry. There is one admin,
// so nothing server-side is needed to look it up.
export function requireAdmin({ admin, now }: Pick<Deps, "admin" | "now">) {
  return createMiddleware(async (c, next) => {
    const value = await getSignedCookie(c, admin.sessionSecret, COOKIE, "host");
    const [email, expires] = typeof value === "string" ? value.split("|") : [];
    if (email !== admin.email || !(Number(expires) > now().getTime())) return c.redirect("/admin/login", 302);
    await next();
  });
}

export function authRoutes({ sql, publicOrigin, admin, now }: Deps) {
  const app = new Hono<Env>();
  const limitLogin = createRateLimiter({ perMinute: 5 / 15, burst: 5 });

  const loginPage = (message?: string) => (
    <Layout title="Sign in">
      <h1>Sign in</h1>
      {message && <p class="notice">{message}</p>}
      <form method="post" action="/admin/login" class="stack">
        <label>
          Email
          <input type="email" name="email" required autocomplete="email" />
        </label>
        <button type="submit">Email me a sign-in link</button>
      </form>
    </Layout>
  );

  app.get("/login", (c) => c.html(loginPage()));

  // Always the same answer, so the page does not reveal which address is the admin's.
  app.post("/login", async (c) => {
    const ip = c.req.header("fly-client-ip") ?? c.env?.ip;
    if (ip && !limitLogin(rateLimitKey(ip)).ok) return c.html(loginPage("Too many attempts. Try again later."), 429);

    const email = String((await c.req.parseBody()).email ?? "").trim().toLowerCase();
    if (email === admin.email.toLowerCase()) {
      const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
      await sql`insert into admin_login_tokens (token_hash, expires_at)
                values (${sha256(token)}, ${new Date(now().getTime() + TOKEN_TTL_MS)})`;
      await admin.sendEmail({
        to: admin.email,
        subject: "Sign in to yoy.fyi",
        text: `Sign in to yoy.fyi admin:\n\n${publicOrigin}/admin/login/verify?token=${token}\n\nThe link works once, for 15 minutes.`,
      });
    }
    return c.html(
      <Layout title="Check your inbox">
        <h1>Check your inbox</h1>
        <p>If that address is the admin's, a sign-in link is on its way. It works once, for 15 minutes.</p>
      </Layout>,
    );
  });

  // Opening the link only shows a button: mail scanners that prefetch links must not use it up.
  app.get("/login/verify", (c) =>
    c.html(
      <Layout title="Sign in">
        <h1>Sign in</h1>
        <form method="post" action="/admin/login/verify">
          <input type="hidden" name="token" value={c.req.query("token") ?? ""} />
          <button type="submit">Continue to admin</button>
        </form>
      </Layout>,
    ),
  );

  app.post("/login/verify", async (c) => {
    const token = String((await c.req.parseBody()).token ?? "");
    const at = now();
    const [used] = await sql`
      update admin_login_tokens set used_at = ${at}
      where token_hash = ${sha256(token)} and used_at is null and expires_at > ${at}
      returning token_hash`;
    if (!used) {
      return c.html(
        <Layout title="Link expired">
          <h1>That link has expired or was already used</h1>
          <p>
            <a href="/admin/login">Request a new one</a>
          </p>
        </Layout>,
        400,
      );
    }
    await setSignedCookie(c, COOKIE, `${admin.email}|${at.getTime() + SESSION_TTL_MS}`, admin.sessionSecret, {
      prefix: "host",
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      maxAge: SESSION_TTL_MS / 1000,
    });
    return c.redirect("/admin", 303);
  });

  app.post("/logout", (c) => {
    deleteCookie(c, COOKIE, { prefix: "host", path: "/", secure: true });
    return c.redirect("/admin/login", 303);
  });

  return app;
}
