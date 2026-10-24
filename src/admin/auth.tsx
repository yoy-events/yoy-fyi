import type { SQL } from "bun";
import { Hono } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { isUuid } from "../http";
import { createRateLimiter, rateLimitKey } from "../ratelimit";
import { setUserSession, upsertGoogleUser } from "../users";
import { Layout } from "./layout";

export type GoogleSignIn = {
  clientId: string;
  clientSecret: string;
  // Posts the token request; replaced in tests.
  exchange?: (body: URLSearchParams) => Promise<Response>;
};

export type AdminConfig = {
  email: string;
  sessionSecret: string;
  sendEmail: (mail: { to: string; subject: string; text: string }) => Promise<void>;
  // Optional second way in: Sign in with Google, accepted only for `email` with a verified address.
  google?: GoogleSignIn;
};

type Deps = { sql: SQL; publicOrigin: string; admin: AdminConfig; now: () => Date };
type Env = { Bindings: { ip?: string } };

const COOKIE = "yfi_admin";
const GOOGLE_COOKIE = "yfi_google";
const TOKEN_TTL_MS = 15 * 60_000;
const SESSION_TTL_MS = 7 * 86_400_000;
const GOOGLE_FLOW_TTL_MS = 10 * 60_000;
const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

const random = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
const s256 = (v: string) => new Bun.CryptoHasher("sha256").update(v).digest("base64url");

const sha256 = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");

// The session is a signed cookie holding the admin email and an expiry. There is one admin,
// so nothing server-side is needed to look it up.
export async function adminSignedIn(c: Context, { admin, now }: Pick<Deps, "admin" | "now">): Promise<boolean> {
  const value = await getSignedCookie(c, admin.sessionSecret, COOKIE, "host");
  const [email, expires] = typeof value === "string" ? value.split("|") : [];
  return email === admin.email && Number(expires) > now().getTime();
}

export function requireAdmin(deps: Pick<Deps, "admin" | "now">) {
  return createMiddleware(async (c, next) => {
    if (!(await adminSignedIn(c, deps))) return c.redirect("/admin/login", 302);
    await next();
  });
}

// `pending` is an OAuth authorize request to return to after signing in.
export function LoginForm({ pending, google = false }: { pending?: string; google?: boolean }) {
  return (
    <div class="stack">
      {google && (
        <a class="button" href={pending ? `/admin/login/google?pending=${pending}` : "/admin/login/google"}>
          Sign in with Google
        </a>
      )}
      <form method="post" action="/admin/login" class="stack">
        {pending && <input type="hidden" name="pending" value={pending} />}
        <label>
          Email
          <input type="email" name="email" required autocomplete="email" />
        </label>
        <button type="submit">Email me a sign-in link</button>
      </form>
    </div>
  );
}

const setSession = (c: Context, admin: AdminConfig, at: Date) =>
  setSignedCookie(c, COOKIE, `${admin.email}|${at.getTime() + SESSION_TTL_MS}`, admin.sessionSecret, {
    prefix: "host",
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });

const afterSignIn = (pending: string | null | undefined) => (pending ? `/oauth/authorize?pending=${pending}` : "/admin");

// One Google client and one callback serve both sign-ins: `admin` for /admin (ADMIN_EMAIL only)
// and `user` for the personal home page (any verified Google account, ADR-0004).
export async function startGoogle(
  c: Context,
  { publicOrigin, admin, now }: Pick<Deps, "publicOrigin" | "admin" | "now">,
  kind: "admin" | "user",
  pending: string | null = null,
) {
  const google = admin.google!;
  const flow = { kind, state: random(), verifier: random(), nonce: random(), pending, exp: now().getTime() + GOOGLE_FLOW_TTL_MS };
  await setSignedCookie(c, GOOGLE_COOKIE, Buffer.from(JSON.stringify(flow)).toString("base64url"), admin.sessionSecret, {
    prefix: "host",
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: GOOGLE_FLOW_TTL_MS / 1000,
  });
  const url = new URL(GOOGLE_AUTH);
  const params: Record<string, string> = {
    client_id: google.clientId,
    redirect_uri: `${publicOrigin}/admin/login/google/callback`,
    response_type: "code",
    // A user's name labels their account; the admin needs only the email.
    scope: kind === "user" ? "openid email profile" : "openid email",
    state: flow.state,
    nonce: flow.nonce,
    code_challenge: s256(flow.verifier),
    code_challenge_method: "S256",
    prompt: "select_account",
  };
  if (kind === "admin") params.login_hint = admin.email;
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return c.redirect(url.toString(), 302);
}

// The id_token comes straight from Google's token endpoint over TLS, so its claims are checked
// and its signature is not (OpenID Connect Core 3.1.3.7, step 6).
function idTokenClaims(idToken: unknown): Record<string, unknown> | null {
  if (typeof idToken !== "string") return null;
  try {
    return JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

export function authRoutes({ sql, publicOrigin, admin, now }: Deps) {
  const app = new Hono<Env>();
  const limitLogin = createRateLimiter({ perMinute: 5 / 15, burst: 5 });

  const loginPage = (message?: string) => (
    <Layout title="Sign in">
      <h1>Sign in</h1>
      {message && <p class="notice">{message}</p>}
      <LoginForm google={!!admin.google} />
    </Layout>
  );

  app.get("/login", (c) => c.html(loginPage()));

  const google = admin.google;
  if (google) {
    const redirectUri = `${publicOrigin}/admin/login/google/callback`;
    const exchange = google.exchange ?? ((body: URLSearchParams) => fetch(GOOGLE_TOKEN, { method: "POST", body, signal: AbortSignal.timeout(10_000) }));

    app.get("/login/google", async (c) => {
      const ip = c.env?.ip;
      if (ip && !limitLogin(rateLimitKey(ip)).ok) return c.html(loginPage("Too many attempts. Try again later."), 429);
      const pending = isUuid(c.req.query("pending") ?? "") ? c.req.query("pending")! : null;
      return startGoogle(c, { publicOrigin, admin, now }, "admin", pending);
    });

    app.get("/login/google/callback", async (c) => {
      const refuse = (message: string) => c.html(loginPage(message), 400);
      const raw = await getSignedCookie(c, admin.sessionSecret, GOOGLE_COOKIE, "host");
      deleteCookie(c, GOOGLE_COOKIE, { prefix: "host", path: "/", secure: true });
      let flow: { kind?: string; state?: string; verifier?: string; nonce?: string; pending?: string | null; exp?: number } = {};
      try {
        flow = typeof raw === "string" ? JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) : {};
      } catch {}
      const q = c.req.query();
      if (!flow.state || q.state !== flow.state || !(Number(flow.exp) > now().getTime())) {
        return refuse("That sign-in attempt expired. Try again.");
      }
      if (q.error) return refuse("Google sign-in was cancelled.");
      if (!q.code) return refuse("Google did not return a sign-in code. Try again.");

      const res = await exchange(
        new URLSearchParams({
          code: q.code,
          client_id: google.clientId,
          client_secret: google.clientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
          code_verifier: flow.verifier!,
        }),
      ).catch(() => null);
      const body = res?.ok ? await res.json().catch(() => null) : null;
      const claims = idTokenClaims(body?.id_token);
      const verified =
        claims &&
        GOOGLE_ISSUERS.includes(String(claims.iss)) &&
        claims.aud === google.clientId &&
        Number(claims.exp) * 1000 > now().getTime() &&
        claims.nonce === flow.nonce &&
        claims.email_verified === true &&
        typeof claims.sub === "string" &&
        typeof claims.email === "string";
      if (!verified) return refuse("That Google account cannot sign in here.");

      if (flow.kind === "user") {
        const user = await upsertGoogleUser(
          sql,
          { sub: claims.sub as string, email: claims.email as string, name: typeof claims.name === "string" ? claims.name : null },
          now(),
        );
        if (!user) return refuse("This account is blocked.");
        await setUserSession(c, admin.sessionSecret, user.id, now());
        return c.redirect("/", 303);
      }
      if (String(claims.email).toLowerCase() !== admin.email.toLowerCase()) return refuse("That Google account cannot sign in here.");
      await setSession(c, admin, now());
      return c.redirect(afterSignIn(flow.pending), 303);
    });
  }

  // Always the same answer, so the page does not reveal which address is the admin's.
  app.post("/login", async (c) => {
    const ip = c.env?.ip;
    if (ip && !limitLogin(rateLimitKey(ip)).ok) return c.html(loginPage("Too many attempts. Try again later."), 429);

    const form = await c.req.parseBody();
    const email = String(form.email ?? "").trim().toLowerCase();
    const pending = isUuid(String(form.pending ?? "")) ? String(form.pending) : null;
    if (email === admin.email.toLowerCase()) {
      const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
      await sql`insert into admin_login_tokens (token_hash, expires_at, pending_id)
                values (${sha256(token)}, ${new Date(now().getTime() + TOKEN_TTL_MS)}, ${pending})`;
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
      returning pending_id`;
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
    await setSession(c, admin, at);
    return c.redirect(afterSignIn(used.pending_id), 303);
  });

  app.post("/logout", (c) => {
    deleteCookie(c, COOKIE, { prefix: "host", path: "/", secure: true });
    return c.redirect("/admin/login", 303);
  });

  return app;
}
