// The personal side of yoy.fyi (ADR-0004): sign in with Google, see and create your own short
// links, download QR codes, and create API keys for your own service.
import type { SQL } from "bun";
import { type Context, Hono } from "hono";
import { csrf } from "hono/csrf";
import type { Child } from "hono/jsx";
import QRCode from "qrcode";
import { type AdminConfig, startGoogle } from "./admin/auth";
import { BarChart, Ranking } from "./admin/charts";
import { linkBody } from "./admin/links";
import { timeseries, breakdown } from "./analytics";
import { isUuid } from "./http";
import { type Scope, issueKey } from "./keys";
import { type LinkRow, createLink, toLink, updateLink } from "./links";
import { createRateLimiter } from "./ratelimit";
import type { UnsafeUrls } from "./safe-browsing";
import { checkTarget } from "./target-policy";
import { type User, clearUserSession, currentUser } from "./users";

const DAY = 86_400_000;
const MAX_KEYS = 10;
// What a person may grant their own keys. Keys are managed here, never through keys:manage.
const USER_SCOPES = ["links:read", "links:write", "analytics:read", "webhooks:manage"] as const satisfies readonly Scope[];
const SCOPE_TEXT: Record<string, string> = {
  "links:read": "Read links",
  "links:write": "Create, change and disable links",
  "analytics:read": "Read click analytics",
  "webhooks:manage": "Manage click webhooks",
};

type Deps = {
  sql: SQL;
  publicOrigin: string;
  admin: AdminConfig;
  now: () => Date;
  resolveHost?: (host: string) => Promise<string[]>;
  unsafeUrls?: UnsafeUrls;
};
type Env = { Variables: { user: User } };

function Page({ title, user, children }: { title: string; user?: User | null; children: Child }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>{title === "yoy.fyi" ? title : `${title} · yoy.fyi`}</title>
        <link rel="stylesheet" href="/static/admin.css" />
        <script src="/static/copy.js" defer></script>
      </head>
      <body>
        <header>
          <a href="/" class="brand">
            yoy.fyi
          </a>
          {user && <a href="/account/keys">API keys</a>}
          {user && <a href="/account/apps">Connected apps</a>}
          {user && (
            <form method="post" action="/logout">
              <button type="submit" class="link">
                Sign out
              </button>
            </form>
          )}
        </header>
        <main>{children}</main>
        <footer class="meta">
          <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a>
        </footer>
      </body>
    </html>
  );
}

const OPTIONAL = ["title", "code", "tags", "utm_source", "utm_medium", "utm_campaign"] as const;

// One field to start with, like Bitly and Dub; the rest waits under More options (no JavaScript).
function CreateForm({ values = {}, errors = [] }: { values?: Record<string, string>; errors?: string[] }) {
  const open = OPTIONAL.some((k) => values[k]);
  return (
    <form method="post" action="/links" class="stack card">
      {errors.length > 0 && (
        <ul class="errors">
          {errors.map((e) => (
            <li>{e}</li>
          ))}
        </ul>
      )}
      <label>
        Paste a long link
        <input type="url" name="target_url" required value={values.target_url ?? ""} placeholder="https://" />
      </label>
      <details open={open}>
        <summary>More options</summary>
        <div class="stack">
          <label>
            Title
            <input name="title" value={values.title ?? ""} maxlength={200} />
          </label>
          <label>
            Custom code <span class="meta">yoy.fyi/your-code</span>
            <input name="code" value={values.code ?? ""} />
          </label>
          <label>
            Tags <span class="meta">comma-separated</span>
            <input name="tags" value={values.tags ?? ""} />
          </label>
          {(["utm_source", "utm_medium", "utm_campaign"] as const).map((k) => (
            <label>
              {k}
              <input name={k} value={values[k] ?? ""} />
            </label>
          ))}
        </div>
      </details>
      <button type="submit">Shorten</button>
    </form>
  );
}

export function webRoutes({ sql, publicOrigin, admin, now, resolveHost, unsafeUrls }: Deps) {
  const app = new Hono<Env>();
  const ownHost = new URL(publicOrigin).hostname;
  const limitCreate = createRateLimiter({ perMinute: 20 / 60, burst: 20 });
  const user = (c: Context) => currentUser(c, sql, admin.sessionSecret, now());

  // Form posts must come from our own origin.
  app.use("/links/*", csrf({ origin: publicOrigin }));
  app.use("/links", csrf({ origin: publicOrigin }));
  app.use("/account/*", csrf({ origin: publicOrigin }));
  app.use("/logout", csrf({ origin: publicOrigin }));

  // Pages need a session; form posts without one get 401 instead of a redirect.
  const signedIn = async (c: Context<Env>, next: () => Promise<void>) => {
    const u = await user(c);
    if (!u) return c.req.method === "GET" ? c.redirect("/", 302) : c.text("Sign in first", 401);
    c.set("user", u);
    await next();
  };
  app.use("/links", signedIn);
  app.use("/links/*", signedIn);
  app.use("/account/*", signedIn);

  const ownLink = async (u: User, id: string) =>
    isUuid(id) ? ((await sql`select * from links where id = ${id} and service_id = ${u.serviceId}`)[0] as LinkRow | undefined) : undefined;

  async function home(c: Context, u: User, form?: { values: Record<string, string>; errors: string[] }, status: 200 | 422 = 200) {
    // The link just created, shown on top with its QR, like Dub and Bitly.
    const createdRow = await ownLink(u, c.req.query("created") ?? "");
    const created = createdRow ? toLink(createdRow, publicOrigin, now()) : null;
    const links: (LinkRow & { clicks_7d: number })[] = await sql`
      select l.*, coalesce((select sum(d.clicks) from link_stats_daily d
                            where d.link_id = l.id and not d.is_bot and d.bucket >= ${new Date(now().getTime() - 7 * DAY)}), 0)::int as clicks_7d
      from links l where l.service_id = ${u.serviceId} order by l.id desc limit 200`;
    return c.html(
      <Page title="My links" user={u}>
        <h1>My links</h1>
        {created && (
          <section class="card stack created">
            <h2>Your short link is ready</h2>
            <div class="row">
              <input value={created.short_url} readonly aria-label="Short link" />
              <button type="button" data-copy={created.short_url}>
                Copy
              </button>
            </div>
            <img src={`/links/${created.id}/qr.svg`} alt={`QR code for ${created.short_url}`} class="qr" width="160" height="160" />
            <p>
              Download QR: <a href={`/links/${created.id}/qr.png`} download={`${created.code}.png`}>PNG</a> ·{" "}
              <a href={`/links/${created.id}/qr.svg`} download={`${created.code}.svg`}>SVG</a> ·{" "}
              <a href={`/links/${created.id}`}>Stats</a>
            </p>
          </section>
        )}
        {links.length === 0 && !created && (
          <p class="notice">
            Create your first short link: paste a long URL below and get a short yoy.fyi link with a QR code and click
            stats.
          </p>
        )}
        <CreateForm values={form?.values} errors={form?.errors} />
        {links.length > 0 && (
          <ul class="list">
            {links.map((row) => {
              const l = toLink(row, publicOrigin, now());
              return (
                <li>
                  <a href={`/links/${l.id}`}>{l.title ?? l.code}</a>
                  <span class="meta truncate">{l.target_url}</span>
                  <span class="meta">
                    {l.short_url} · {row.clicks_7d} clicks in 7 days
                  </span>
                  {l.status !== "active" && <span class={`badge ${l.status}`}>{l.status}</span>}
                </li>
              );
            })}
          </ul>
        )}
      </Page>,
      status,
    );
  }

  app.get("/", async (c) => {
    const u = await user(c);
    if (u) return home(c, u);
    return c.html(
      <Page title="yoy.fyi">
        <h1>Short links and QR codes</h1>
        <p>Turn long links into short yoy.fyi links, download a QR code for each, and see who clicks: by day, source, country and device.</p>
        {admin.google ? (
          <a class="button" href="/login/google">
            Sign in with Google
          </a>
        ) : (
          <p class="meta">Sign-in is not available right now.</p>
        )}
      </Page>,
    );
  });

  // `pending` is an OAuth authorize request (an app connecting) to return to after signing in.
  app.get("/login/google", (c) => {
    if (!admin.google) return c.notFound();
    const pending = c.req.query("pending") ?? "";
    return startGoogle(c, { publicOrigin, admin, now }, "user", isUuid(pending) ? pending : null);
  });

  app.post("/logout", (c) => {
    clearUserSession(c);
    return c.redirect("/", 303);
  });

  app.post("/links", async (c) => {
    const u = c.get("user");
    const values = Object.fromEntries(Object.entries(await c.req.parseBody()).map(([k, v]) => [k, String(v).trim()]));
    if (!limitCreate(u.id).ok) return c.text("Too many new links. Try again in an hour.", 429);
    const result = await createLink(sql, { ownHost, resolveHost, unsafeUrls }, u.serviceId, linkBody(values), null, "web");
    if (result.kind !== "error") return c.redirect(`/?created=${result.row.id}`, 303);
    const fields = (result.details?.fields ?? {}) as Record<string, string>;
    const errors = Object.keys(fields).length
      ? Object.entries(fields).map(([k, v]) => `${k}: ${v}`)
      : [result.details?.reason ? `${result.message} (${result.details.reason})` : result.message];
    return home(c, u, { values, errors }, 422);
  });

  // Form fields of the edit form; empty title, tags and expiry clear them.
  const editBody = (f: Record<string, string>) => ({
    target_url: f.target_url ?? "",
    title: f.title || null,
    tags: (f.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean),
    expires_at: f.expires_at ? `${f.expires_at}:00Z` : null,
  });
  const errorList = (r: { message: string; details?: Record<string, unknown> }) => {
    const fields = (r.details?.fields ?? {}) as Record<string, string>;
    return Object.keys(fields).length
      ? Object.entries(fields).map(([k, v]) => `${k}: ${v}`)
      : [r.details?.reason ? `${r.message} (${r.details.reason})` : r.message];
  };

  async function linkPage(c: Context, u: User, row: LinkRow, form?: { values: Record<string, string>; errors: string[] }, status: 200 | 409 | 422 = 200) {
    const link = toLink(row, publicOrigin, now());
    const values = form?.values ?? {
      target_url: row.target_url,
      title: row.title ?? "",
      tags: row.tags.join(", "),
      expires_at: row.expires_at ? row.expires_at.toISOString().slice(0, 16) : "",
    };
    const dayEnd = Math.floor(now().getTime() / DAY) * DAY + DAY;
    const scope = { serviceId: u.serviceId, linkId: link.id, tag: null, from: new Date(dayEnd - 30 * DAY), to: new Date(dayEnd), bots: "exclude" as const };
    const daily = await timeseries(sql, scope, "day");
    const [referrers, countries, devices] = await Promise.all(
      (["referer_host", "country", "device"] as const).map((d) => breakdown(sql, scope, d, 5)),
    );
    return c.html(
      <Page title={link.title ?? link.code} user={u}>
        <h1>{link.title ?? link.code}</h1>
        <div class="row">
          <input value={link.short_url} readonly aria-label="Short link" />
          <button type="button" data-copy={link.short_url}>
            Copy
          </button>
        </div>
        <p class="meta truncate">→ {link.target_url}</p>
        <p>
          <span class={`badge ${link.status}`}>{link.status}</span>
          {link.tags.length > 0 && <span class="meta"> · {link.tags.join(", ")}</span>}
        </p>
        <img src={`/links/${link.id}/qr.svg`} alt={`QR code for ${link.short_url}`} class="qr" width="160" height="160" />
        <p>
          Download QR: <a href={`/links/${link.id}/qr.png`} download={`${link.code}.png`}>PNG</a> ·{" "}
          <a href={`/links/${link.id}/qr.svg`} download={`${link.code}.svg`}>SVG</a>
        </p>
        <h2>
          {daily.totals.clicks} clicks in 30 days <span class="meta">({daily.totals.uniques_upper_bound} visitors at most)</span>
        </h2>
        <BarChart points={daily.points} label={(t) => t.toISOString().slice(0, 10)} />
        <div class="rankings">
          <Ranking title="Referrers" items={referrers!.items} total={referrers!.total_clicks} />
          <Ranking title="Countries" items={countries!.items} total={countries!.total_clicks} />
          <Ranking title="Devices" items={devices!.items} total={devices!.total_clicks} />
        </div>
        {link.status !== "disabled" && (
          <details open={!!form}>
            <summary>Edit link</summary>
            <form method="post" action={`/links/${link.id}`} class="stack card">
              {form && form.errors.length > 0 && (
                <ul class="errors">
                  {form.errors.map((e) => (
                    <li>{e}</li>
                  ))}
                </ul>
              )}
              <label>
                Where it goes
                <input type="url" name="target_url" required value={values.target_url} />
              </label>
              <label>
                Title
                <input name="title" maxlength={200} value={values.title} />
              </label>
              <label>
                Tags <span class="meta">comma-separated</span>
                <input name="tags" value={values.tags} />
              </label>
              <label>
                Expires <span class="meta">UTC, empty for never</span>
                <input type="datetime-local" name="expires_at" value={values.expires_at} />
              </label>
              <button type="submit">Save</button>
            </form>
          </details>
        )}
        {form && link.status === "disabled" && <p class="notice">{form.errors.join(" ")}</p>}
        {link.status !== "disabled" ? (
          <form method="post" action={`/links/${link.id}/disable`}>
            <button type="submit" class="danger">
              Disable link
            </button>
          </form>
        ) : (
          <form method="post" action={`/links/${link.id}/enable`}>
            <button type="submit">Enable link</button>
          </form>
        )}
      </Page>,
      status,
    );
  }

  app.get("/links/:id", async (c) => {
    const u = c.get("user");
    const row = await ownLink(u, c.req.param("id"));
    if (!row) return c.notFound();
    return linkPage(c, u, row);
  });

  app.post("/links/:id", async (c) => {
    const u = c.get("user");
    const row = await ownLink(u, c.req.param("id"));
    if (!row) return c.notFound();
    const values = Object.fromEntries(Object.entries(await c.req.parseBody()).map(([k, v]) => [k, String(v).trim()]));
    const result = await updateLink(sql, { ownHost, resolveHost, unsafeUrls }, u.serviceId, row.id, editBody(values));
    if (result.kind === "updated") return c.redirect(`/links/${row.id}`, 303);
    if (result.status === 404) return c.notFound();
    return linkPage(c, u, row, { values, errors: errorList(result) }, result.status);
  });

  // Re-enabling checks the target again, so a link disabled for an unsafe target stays down.
  app.post("/links/:id/enable", async (c) => {
    const u = c.get("user");
    const row = await ownLink(u, c.req.param("id"));
    if (!row) return c.notFound();
    if (row.disabled_at) {
      const rejection = await checkTarget(row.target_url, { ownHost, resolve: resolveHost, unsafeUrls });
      if (rejection) return linkPage(c, u, row, { values: {}, errors: [`This link cannot be enabled: its target is not allowed (${rejection}).`] }, 422);
      await sql`update links set disabled_at = null, updated_at = ${now()} where id = ${row.id} and service_id = ${u.serviceId}`;
    }
    return c.redirect(`/links/${row.id}`, 303);
  });

  app.get("/links/:id/qr.svg", async (c) => {
    const row = await ownLink(c.get("user"), c.req.param("id"));
    if (!row) return c.notFound();
    return c.body(await QRCode.toString(`${publicOrigin}/${row.code}`, { type: "svg", margin: 2 }), 200, { "Content-Type": "image/svg+xml" });
  });

  app.get("/links/:id/qr.png", async (c) => {
    const row = await ownLink(c.get("user"), c.req.param("id"));
    if (!row) return c.notFound();
    const png = await QRCode.toBuffer(`${publicOrigin}/${row.code}`, { type: "png", width: 1024, margin: 2 });
    return c.body(new Uint8Array(png), 200, { "Content-Type": "image/png" });
  });

  app.post("/links/:id/disable", async (c) => {
    const u = c.get("user");
    const id = c.req.param("id");
    if (!(await ownLink(u, id))) return c.notFound();
    await sql`update links set disabled_at = coalesce(disabled_at, ${now()}), updated_at = ${now()} where id = ${id} and service_id = ${u.serviceId}`;
    return c.redirect(`/links/${id}`, 303);
  });

  async function keysPage(c: Context, u: User, opts: { secret?: string; errors?: string[] } = {}, status: 200 | 201 | 422 = 200) {
    const keys = await sql`
      select id, name, prefix, scopes, created_at, last_used_at from api_keys
      where service_id = ${u.serviceId} and revoked_at is null order by created_at desc`;
    return c.html(
      <Page title="API keys" user={u}>
        <h1>API keys</h1>
        <p>
          Use a key with the <a href="/v1/openapi.json">yoy.fyi API</a> or the MCP server at <code>{publicOrigin}/mcp</code>. Keys act
          only on your own links.
        </p>
        {opts.secret && (
          <p class="notice">
            Your new key, shown only now: <code>{opts.secret}</code>
          </p>
        )}
        <form method="post" action="/account/keys" class="stack card">
          <h2>New key</h2>
          {opts.errors && opts.errors.length > 0 && (
            <ul class="errors">
              {opts.errors.map((e) => (
                <li>{e}</li>
              ))}
            </ul>
          )}
          <label>
            Name
            <input name="name" required maxlength={100} placeholder="my app" />
          </label>
          <fieldset>
            <legend>Permissions</legend>
            {USER_SCOPES.map((s) => (
              <label class="check">
                <input type="checkbox" name="scope" value={s} checked={s !== "webhooks:manage"} /> {SCOPE_TEXT[s]}
              </label>
            ))}
          </fieldset>
          <button type="submit">Create key</button>
        </form>
        {keys.length > 0 && (
          <ul class="list">
            {keys.map((k: { id: string; name: string; prefix: string; scopes: string[]; last_used_at: Date | null }) => (
              <li>
                <strong>{k.name}</strong> <code>yfi_{k.prefix}_…</code>
                <span class="meta">
                  {k.scopes.join(", ")} · last used {k.last_used_at ? k.last_used_at.toISOString().slice(0, 16).replace("T", " ") : "never"}
                </span>
                <form method="post" action={`/account/keys/${k.id}/revoke`}>
                  <button type="submit" class="danger">
                    Revoke
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </Page>,
      status,
    );
  }

  app.get("/account/keys", (c) => keysPage(c, c.get("user")));

  app.post("/account/keys", async (c) => {
    const u = c.get("user");
    const form = await c.req.parseBody({ all: true });
    const name = String([form.name].flat()[0] ?? "").trim();
    const scopes = [form.scope ?? []].flat().map(String);
    const errors: string[] = [];
    if (name.length < 1 || name.length > 100) errors.push("Name: 1-100 characters.");
    if (scopes.length === 0 || !scopes.every((s) => (USER_SCOPES as readonly string[]).includes(s)) || new Set(scopes).size !== scopes.length) {
      errors.push("Choose at least one of the listed permissions.");
    }
    const [{ active }] = await sql`select count(*)::int as active from api_keys where service_id = ${u.serviceId} and revoked_at is null`;
    if (active >= MAX_KEYS) errors.push(`You can have at most ${MAX_KEYS} active keys. Revoke one first.`);
    if (errors.length) return keysPage(c, u, { errors }, 422);
    const [service] = await sql`select slug from services where id = ${u.serviceId}`;
    const { token } = await issueKey(sql, { serviceSlug: service.slug, name, scopes: scopes as Scope[] });
    return keysPage(c, u, { secret: token }, 201);
  });

  app.post("/account/keys/:id/revoke", async (c) => {
    const u = c.get("user");
    const id = c.req.param("id");
    const [row] = isUuid(id)
      ? await sql`update api_keys set revoked_at = coalesce(revoked_at, ${now()}) where id = ${id} and service_id = ${u.serviceId} returning id`
      : [];
    if (!row) return c.notFound();
    return c.redirect("/account/keys", 303);
  });

  // OAuth connections from claude.ai, ChatGPT and other MCP clients to this user's service.
  app.get("/account/apps", async (c) => {
    const u = c.get("user");
    const grants: { id: string; client: string; scopes: string[]; created_at: Date; last_used_at: Date | null }[] = await sql`
      select g.id, coalesce(cl.name, g.client_id) as client, g.scopes, g.created_at, g.last_used_at
      from oauth_grants g left join oauth_clients cl on cl.client_id = g.client_id
      where g.service_id = ${u.serviceId} and g.revoked_at is null and g.refresh_expires_at > ${now()}
      order by g.created_at desc`;
    const when = (d: Date | null) => (d ? d.toISOString().slice(0, 16).replace("T", " ") : "never");
    return c.html(
      <Page title="Connected apps" user={u}>
        <h1>Connected apps</h1>
        <p>
          To work with your links from a chat, add <code>{publicOrigin}/mcp</code> as a connector in claude.ai or ChatGPT and sign in
          with the same Google account.
        </p>
        {grants.length > 0 && (
          <ul class="list">
            {grants.map((g) => (
              <li>
                <strong>{g.client}</strong>
                <span class="meta">
                  {g.scopes.join(", ")} · connected {when(g.created_at)} · last used {when(g.last_used_at)}
                </span>
                <form method="post" action={`/account/apps/${g.id}/revoke`}>
                  <button type="submit" class="danger">
                    Revoke
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </Page>,
    );
  });

  app.post("/account/apps/:id/revoke", async (c) => {
    const u = c.get("user");
    const id = c.req.param("id");
    const [row] = isUuid(id)
      ? await sql`update oauth_grants set revoked_at = coalesce(revoked_at, ${now()}) where id = ${id} and service_id = ${u.serviceId} returning id`
      : [];
    if (!row) return c.notFound();
    return c.redirect("/account/apps", 303);
  });

  app.get("/privacy", async (c) =>
    c.html(
      <Page title="Privacy" user={await user(c)}>
        <h1>Privacy at yoy.fyi</h1>
        <p>yoy.fyi makes short links and counts their clicks. This page says what it stores and for how long.</p>
        <h2>Your account</h2>
        <p>
          When you sign in with Google, yoy.fyi receives and keeps your Google account id, email address and name. It uses them only
          to sign you in and to show whose links are whose. It does not read anything else from your Google account.
        </p>
        <h2>Clicks on short links</h2>
        <p>
          For each click yoy.fyi stores the time, the referring site, UTM and ad-click parameters, the browser, operating system and
          device type, the country (derived from the IP address, which is not stored), and a daily-changing hash used to count
          unique visitors. Raw clicks are kept for 13 months; daily totals are kept after that.
        </p>
        <h2>Sharing</h2>
        <p>
          The owner of a link sees its click statistics. If the owner set up a webhook, the click details above (never an IP
          address) are sent to it. yoy.fyi sells nothing to anyone.
        </p>
        <h2>Contact</h2>
        <p>Questions or deletion requests: {admin.email}.</p>
      </Page>,
    ),
  );

  app.get("/terms", async (c) =>
    c.html(
      <Page title="Terms" user={await user(c)}>
        <h1>Terms of use for yoy.fyi</h1>
        <p>yoy.fyi is offered as is, free of charge, without any guarantee of availability.</p>
        <p>
          Do not create links to phishing, malware, scams, spam or anything illegal. Links and accounts that break this rule are
          disabled without notice.
        </p>
        <p>Short links can be disabled at any time; a disabled code is never given to anyone else.</p>
        <p>Contact: {admin.email}.</p>
      </Page>,
    ),
  );

  return app;
}
