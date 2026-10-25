// A minimal OAuth 2.1 authorization server for MCP clients in claude.ai and ChatGPT (ADR-0003).
// Public clients identify themselves with a Client ID Metadata Document; there is no dynamic
// registration. Each grant acts for one service: the admin picks any active service, a signed-in
// user (ADR-0005) gets their own personal service and nothing else.
import type { SQL } from "bun";
import { type Context, Hono } from "hono";
import { csrf } from "hono/csrf";
import { type AdminConfig, LoginForm, adminSignedIn } from "./admin/auth";
import { Layout } from "./admin/layout";
import { isUuid } from "./http";
import type { Caller } from "./keys";
import { type RateLimit, createRateLimiter, rateLimitKey } from "./ratelimit";
import { currentUser } from "./users";
import { checkTarget } from "./target-policy";
import { webhookUrlRejection } from "./webhooks";

export const OAUTH_SCOPES = ["links:read", "analytics:read", "links:write"] as const;
export type ClientMetadata = { client_id: string; client_name?: string; redirect_uris: string[] };
export type FetchClientMetadata = (clientId: string) => Promise<ClientMetadata | null>;

// Client ID documents are fetched only from these registrable domains. A client elsewhere is
// refused and logged, so a new legitimate host shows up in the logs before it is added here.
const CLIENT_HOSTS = ["claude.ai", "claude.com", "anthropic.com", "chatgpt.com", "openai.com"];
const SCOPE_TEXT: Record<string, string> = {
  "links:read": "Переглядати й читати короткі посилання",
  "analytics:read": "Читати статистику кліків",
  "links:write": "Створювати, змінювати й вимикати короткі посилання",
};

const PENDING_TTL_MS = 10 * 60_000;
const CODE_TTL_MS = 60_000;
const ACCESS_TTL_MS = 3_600_000;
const REFRESH_TTL_MS = 60 * 86_400_000;
const CLIENT_CACHE_MS = 86_400_000;
const METADATA_MAX_BYTES = 64 * 1024;

const sha256 = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");
const random = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
const s256 = (verifier: string) => new Bun.CryptoHasher("sha256").update(verifier).digest("base64url");
const CHALLENGE = /^[A-Za-z0-9_-]{43,128}$/;
const ACCESS = /^Bearer (yfo_[A-Za-z0-9_-]{43})$/;

const hostAllowed = (host: string) => CLIENT_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
const isLoopback = (u: URL) => u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);

// Exact match, except that loopback redirects match on any port (RFC 8252).
function redirectAllowed(declared: string[], actual: string): boolean {
  if (declared.includes(actual)) return true;
  let a: URL;
  try {
    a = new URL(actual);
  } catch {
    return false;
  }
  if (!isLoopback(a)) return false;
  return declared.some((d) => {
    try {
      const u = new URL(d);
      return isLoopback(u) && u.hostname === a.hostname && u.pathname === a.pathname && u.search === a.search;
    } catch {
      return false;
    }
  });
}

const withParams = (base: string, params: Record<string, string | undefined>) => {
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  return url.toString();
};

// Fetches a client's metadata document with the same outbound guard as webhooks.
export function fetchClientMetadata(opts: { ownHost: string; resolveHost?: (host: string) => Promise<string[]> }): FetchClientMetadata {
  return async (clientId) => {
    if (webhookUrlRejection(clientId) || (await checkTarget(clientId, { ownHost: opts.ownHost, resolve: opts.resolveHost }))) return null;
    try {
      const res = await fetch(clientId, { redirect: "manual", signal: AbortSignal.timeout(5000), headers: { accept: "application/json" } });
      if (!res.ok || !res.body) {
        await res.body?.cancel();
        return null;
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of res.body) {
        size += chunk.byteLength;
        if (size > METADATA_MAX_BYTES) return null;
        chunks.push(chunk);
      }
      const doc = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      return doc && typeof doc === "object" ? doc : null;
    } catch {
      return null;
    }
  };
}

// Resolves a `yfo_` access token to the same caller shape as an API key.
export async function authenticateOAuth(sql: SQL, header: string | undefined, now: Date): Promise<Caller | null> {
  const match = ACCESS.exec(header ?? "");
  if (!match) return null;
  const [row] = await sql`
    update oauth_grants set last_used_at = ${now}
    where access_hash = ${sha256(match[1]!)} and revoked_at is null and access_expires_at > ${now}
      and service_id in (select id from services where disabled_at is null)
    returning id, service_id, scopes, client_id`;
  return row ? { keyId: row.id, serviceId: row.service_id, scopes: row.scopes, client: row.client_id } : null;
}

type Deps = {
  sql: SQL;
  publicOrigin: string;
  admin: AdminConfig;
  now: () => Date;
  clientMetadata: FetchClientMetadata;
  authorizeLimit?: RateLimit;
  tokenLimit?: RateLimit;
};
type Env = { Bindings: { ip?: string } };
type Pending = {
  id: string;
  client_id: string;
  redirect_uri: string;
  state: string | null;
  code_challenge: string;
  scopes: string[];
  resource: string;
};

export function oauthRoutes(deps: Deps) {
  const { sql, publicOrigin, now } = deps;
  const resource = `${publicOrigin}/mcp`;
  const app = new Hono<Env>();
  const limitAuthorize = createRateLimiter(deps.authorizeLimit ?? { perMinute: 30, burst: 30 });
  const limitToken = createRateLimiter(deps.tokenLimit ?? { perMinute: 20, burst: 20 });
  // Who is approving: the admin (any service) or a user (their own service only). Admin wins.
  const approver = async (c: Context): Promise<{ services: { id: string; slug: string }[]; label: string } | null> => {
    if (await adminSignedIn(c, deps)) {
      return { services: await sql`select id, slug from services where disabled_at is null order by slug`, label: "the admin" };
    }
    const user = await currentUser(c, sql, deps.admin.sessionSecret, now());
    if (!user) return null;
    return { services: await sql`select id, slug from services where id = ${user.serviceId}`, label: user.email };
  };
  const limited = (c: Context<Env>, limit: ReturnType<typeof createRateLimiter>) => {
    const ip = c.env?.ip;
    return ip ? !limit(rateLimitKey(ip)).ok : false;
  };

  const protectedResource = {
    resource,
    authorization_servers: [publicOrigin],
    scopes_supported: [...OAUTH_SCOPES],
    bearer_methods_supported: ["header"],
  };
  app.get("/.well-known/oauth-protected-resource/mcp", (c) => c.json(protectedResource));
  app.get("/.well-known/oauth-protected-resource", (c) => c.json(protectedResource));
  app.get("/.well-known/oauth-authorization-server", (c) =>
    c.json({
      issuer: publicOrigin,
      authorization_endpoint: `${publicOrigin}/oauth/authorize`,
      token_endpoint: `${publicOrigin}/oauth/token`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [...OAUTH_SCOPES],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    }),
  );

  // Cached client metadata, refetched once a day.
  async function loadClient(clientId: string): Promise<{ name: string; redirect_uris: string[] } | null> {
    const [cached] = await sql`select name, redirect_uris, fetched_at from oauth_clients where client_id = ${clientId}`;
    if (cached && now().getTime() - new Date(cached.fetched_at).getTime() < CLIENT_CACHE_MS) return cached;
    const doc = await deps.clientMetadata(clientId);
    const uris = doc?.redirect_uris;
    if (!doc || doc.client_id !== clientId || !Array.isArray(uris) || !uris.every((u) => typeof u === "string")) return null;
    const name = typeof doc.client_name === "string" && doc.client_name ? doc.client_name.slice(0, 100) : new URL(clientId).hostname;
    await sql`
      insert into oauth_clients (client_id, name, redirect_uris, fetched_at)
      values (${clientId}, ${name}, ${sql.array(uris, "text")}, ${now()})
      on conflict (client_id) do update set name = excluded.name, redirect_uris = excluded.redirect_uris, fetched_at = excluded.fetched_at`;
    return { name, redirect_uris: uris };
  }

  const errorPage = (c: Context, message: string) =>
    c.html(
      <Layout title="Не вдалося підключити">
        <h1>Цей запит на підключення не можна використати</h1>
        <p>{message}</p>
      </Layout>,
      400,
    );

  async function consentPage(c: Context, pending: Pending, who: { services: { id: string; slug: string }[]; label: string }) {
    const client = await loadClient(pending.client_id);
    if (!client) return errorPage(c, "Не вдалося визначити застосунок.");
    const { services } = who;
    const host = new URL(pending.redirect_uri).host;
    return c.html(
      <Layout title="Підключити застосунок" signedIn>
        <h1>Підключити {client.name}</h1>
        <p>
          {client.name} просить доступ до yoy.fyi для одного сервісу. Після рішення ви повернетеся на <strong>{host}</strong>.
        </p>
        <p class="meta">Ви ввійшли як {who.label}.</p>
        {services.length === 0 ? (
          <p class="notice">Спершу створіть сервіс: випустіть для нього API-ключ в адмінці.</p>
        ) : (
          <form method="post" action="/oauth/authorize" class="stack card">
            <input type="hidden" name="pending" value={pending.id} />
            <fieldset>
              <legend>Сервіс</legend>
              {services.map((s: { id: string; slug: string }, i: number) => (
                <label>
                  <input type="radio" name="service" value={s.id} checked={i === 0} required /> {s.slug}
                </label>
              ))}
            </fieldset>
            <fieldset>
              <legend>Дозволи</legend>
              {pending.scopes.map((scope) => (
                <label>
                  <input type="checkbox" name="scope" value={scope} checked={scope !== "links:write"} /> {SCOPE_TEXT[scope]}
                </label>
              ))}
            </fieldset>
            <div class="row">
              <button type="submit" name="decision" value="approve">
                Дозволити
              </button>
              <button type="submit" name="decision" value="deny" class="secondary">
                Відмовити
              </button>
            </div>
          </form>
        )}
      </Layout>,
    );
  }

  const loginPage = (c: Context, pendingId: string) =>
    c.html(
      <Layout title="Вхід">
        <h1>Увійдіть, щоб підключити застосунок</h1>
        <p>Після входу ви повернетеся сюди, щоб підтвердити підключення.</p>
        {deps.admin.google && (
          <a class="button" href={`/login/google?pending=${pendingId}`}>
            Увійти через Google
          </a>
        )}
        <details>
          <summary>Вхід для адміністратора</summary>
          <LoginForm pending={pendingId} google={!!deps.admin.google} />
        </details>
      </Layout>,
    );

  app.get("/oauth/authorize", async (c) => {
    if (limited(c, limitAuthorize)) return c.text("Too many requests", 429);
    const q = c.req.query();
    const who = await approver(c);

    // Coming back from the emailed sign-in link.
    if (q.pending !== undefined) {
      if (!who) return loginPage(c, q.pending);
      const [pending]: Pending[] = isUuid(q.pending)
        ? await sql`select * from oauth_pending where id = ${q.pending} and expires_at > ${now()}`
        : [];
      return pending ? consentPage(c, pending, who) : errorPage(c, "Термін дії запиту минув. Почніть підключення знову із застосунку.");
    }

    // Until the client and its redirect are verified, errors stay on this page (no open redirect).
    const clientId = q.client_id ?? "";
    const redirectUri = q.redirect_uri ?? "";
    let clientUrl: URL;
    try {
      clientUrl = new URL(clientId);
    } catch {
      return errorPage(c, "client_id must be an https URL.");
    }
    if (clientUrl.protocol !== "https:" || !hostAllowed(clientUrl.hostname)) {
      console.warn("oauth client host refused", { host: clientUrl.hostname });
      return errorPage(c, "Цьому застосунку не дозволено підключатися.");
    }
    const client = await loadClient(clientId);
    if (!client) return errorPage(c, "Не вдалося прочитати опис застосунку.");
    if (!redirectUri || !redirectAllowed(client.redirect_uris, redirectUri)) return errorPage(c, "Адреса повернення не збігається з тією, яку оголосив застосунок.");

    const fail = (error: string, description: string) =>
      c.redirect(withParams(redirectUri, { error, error_description: description, state: q.state, iss: publicOrigin }), 302);
    if (q.response_type !== "code") return fail("unsupported_response_type", "Only response_type=code is supported.");
    if (q.code_challenge_method !== "S256" || !CHALLENGE.test(q.code_challenge ?? "")) {
      return fail("invalid_request", "PKCE with code_challenge_method=S256 is required.");
    }
    if (q.resource !== undefined && q.resource !== resource) return fail("invalid_target", `The only resource is ${resource}.`);
    const asked = q.scope ? q.scope.split(" ").filter(Boolean) : [...OAUTH_SCOPES];
    const scopes = OAUTH_SCOPES.filter((s) => asked.includes(s));
    if (scopes.length === 0) return fail("invalid_scope", `Grantable scopes: ${OAUTH_SCOPES.join(" ")}.`);

    const [pending]: Pending[] = await sql`
      insert into oauth_pending (id, client_id, redirect_uri, state, code_challenge, scopes, resource, expires_at)
      values (${crypto.randomUUID()}, ${clientId}, ${redirectUri}, ${q.state ?? null}, ${q.code_challenge!},
              ${sql.array(scopes, "text")}, ${resource}, ${new Date(now().getTime() + PENDING_TTL_MS)})
      returning *`;
    return who ? consentPage(c, pending!, who) : loginPage(c, pending!.id);
  });

  app.post("/oauth/authorize", csrf({ origin: publicOrigin }), async (c) => {
    const who = await approver(c);
    if (!who) return c.text("Sign in first", 401);
    const form = await c.req.parseBody({ all: true });
    const one = (v: unknown) => (Array.isArray(v) ? String(v[0] ?? "") : String(v ?? ""));
    const pendingId = one(form.pending);
    const [pending]: Pending[] = isUuid(pendingId)
      ? await sql`select * from oauth_pending where id = ${pendingId} and expires_at > ${now()}`
      : [];
    if (!pending) return errorPage(c, "Термін дії запиту минув або на нього вже відповіли. Почніть підключення знову із застосунку.");
    const back = (params: Record<string, string>) =>
      c.redirect(withParams(pending.redirect_uri, { ...params, state: pending.state ?? undefined, iss: publicOrigin }), 303);

    if (one(form.decision) === "deny") {
      await sql`delete from oauth_pending where id = ${pending.id}`;
      return back({ error: "access_denied", error_description: "The request was denied." });
    }

    const serviceId = one(form.service);
    const service = who.services.find((s) => s.id === serviceId);
    const granted = [form.scope ?? []].flat().map(String);
    const scopesOk = granted.length > 0 && granted.every((s) => pending.scopes.includes(s));
    if (!service || !scopesOk) return errorPage(c, "Оберіть сервіс і хоча б один із запропонованих дозволів.");

    const code = random();
    const [deleted] = await sql`delete from oauth_pending where id = ${pending.id} returning id`;
    if (!deleted) return errorPage(c, "На цей запит уже відповіли.");
    await sql`
      insert into oauth_codes (code_hash, client_id, service_id, scopes, redirect_uri, code_challenge, resource, expires_at)
      values (${sha256(code)}, ${pending.client_id}, ${service.id}, ${sql.array(granted, "text")}, ${pending.redirect_uri},
              ${pending.code_challenge}, ${pending.resource}, ${new Date(now().getTime() + CODE_TTL_MS)})`;
    return back({ code });
  });

  app.post("/oauth/token", async (c) => {
    c.header("Cache-Control", "no-store");
    const err = (error: string, description: string, status: 400 | 429 = 400) => c.json({ error, error_description: description }, status);
    if (limited(c, limitToken)) return err("slow_down", "Too many token requests.", 429);
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const field = (k: string) => (typeof form[k] === "string" ? (form[k] as string) : "");
    const at = now();

    const issue = async (grant: { scopes: string[] }, tokens: { access: string; refresh: string }) =>
      c.json({
        access_token: tokens.access,
        token_type: "Bearer",
        expires_in: ACCESS_TTL_MS / 1000,
        refresh_token: tokens.refresh,
        scope: grant.scopes.join(" "),
      });
    const fresh = () => ({ access: `yfo_${random()}`, refresh: `yfr_${random()}` });

    switch (field("grant_type")) {
      case "authorization_code": {
        const [code, redirectUri, clientId, verifier] = ["code", "redirect_uri", "client_id", "code_verifier"].map(field);
        if (!code || !redirectUri || !clientId || !verifier) return err("invalid_request", "code, redirect_uri, client_id and code_verifier are required.");
        if (field("resource") && field("resource") !== resource) return err("invalid_target", `The only resource is ${resource}.`);
        const [row] = await sql`
          update oauth_codes set used_at = ${at}
          where code_hash = ${sha256(code)} and used_at is null and expires_at > ${at}
          returning *`;
        if (!row || row.client_id !== clientId || row.redirect_uri !== redirectUri || s256(verifier) !== row.code_challenge) {
          return err("invalid_grant", "The code is invalid, expired, already used, or does not match this request.");
        }
        const tokens = fresh();
        await sql`
          insert into oauth_grants (id, client_id, service_id, scopes, access_hash, access_expires_at, refresh_hash, refresh_expires_at)
          values (${Bun.randomUUIDv7()}, ${clientId}, ${row.service_id}, ${sql.array(row.scopes, "text")}, ${sha256(tokens.access)},
                  ${new Date(at.getTime() + ACCESS_TTL_MS)}, ${sha256(tokens.refresh)}, ${new Date(at.getTime() + REFRESH_TTL_MS)})`;
        return issue(row, tokens);
      }
      case "refresh_token": {
        const [refresh, clientId] = ["refresh_token", "client_id"].map(field);
        if (!refresh || !clientId) return err("invalid_request", "refresh_token and client_id are required.");
        const hash = sha256(refresh);
        // A refresh token that was already rotated away means it leaked: end the whole grant.
        const [replayed] = await sql`update oauth_grants set revoked_at = ${at} where prev_refresh_hash = ${hash} and revoked_at is null returning id`;
        if (replayed) return err("invalid_grant", "This refresh token was already used; the connection was revoked.");
        const tokens = fresh();
        const [grant] = await sql`
          update oauth_grants
          set access_hash = ${sha256(tokens.access)}, access_expires_at = ${new Date(at.getTime() + ACCESS_TTL_MS)},
              prev_refresh_hash = refresh_hash, refresh_hash = ${sha256(tokens.refresh)},
              refresh_expires_at = ${new Date(at.getTime() + REFRESH_TTL_MS)}
          where refresh_hash = ${hash} and client_id = ${clientId} and revoked_at is null and refresh_expires_at > ${at}
          returning scopes`;
        if (!grant) return err("invalid_grant", "The refresh token is invalid, expired or revoked.");
        return issue(grant, tokens);
      }
      case "":
        return err("invalid_request", "grant_type is required.");
      default:
        return err("unsupported_grant_type", "Supported: authorization_code, refresh_token.");
    }
  });

  return app;
}
