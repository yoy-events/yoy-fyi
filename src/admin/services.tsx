import type { SQL } from "bun";
import { Hono } from "hono";
import { SCOPES, type Scope, issueKey, toApiKey } from "../keys";
import { Errors, Layout, when } from "./layout";
import { LinkForm, LinkList } from "./links";

const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function KeyForm({ service = "", errors = [] as string[] }) {
  return (
    <form method="post" action="/admin/keys" class="stack card">
      <h2>New API key</h2>
      <Errors errors={errors} />
      <label>
        Service
        <input name="service" value={service} required pattern="[a-z0-9][a-z0-9-]{0,39}" placeholder="yoy" />
      </label>
      <label>
        Key name
        <input name="name" required maxlength={100} placeholder="production" />
      </label>
      <fieldset>
        <legend>Scopes</legend>
        {SCOPES.map((s) => (
          <label class="check">
            <input type="checkbox" name="scopes" value={s} /> {s}
          </label>
        ))}
      </fieldset>
      <button type="submit">Create key</button>
    </form>
  );
}

export function serviceRoutes(sql: SQL) {
  const app = new Hono();

  app.get("/", async (c) => {
    const services = await sql`
      select s.slug, s.name, s.disabled_at,
        (select count(*)::int from api_keys k where k.service_id = s.id and k.revoked_at is null) as keys,
        (select count(*)::int from links l where l.service_id = s.id) as links,
        (select coalesce(sum(clicks), 0)::int from link_stats_daily d
          where d.service_id = s.id and not d.is_bot and d.bucket >= now() - interval '7 days') as clicks_7d
      from services s order by s.slug`;
    return c.html(
      <Layout title="Services" signedIn>
        <h1>Services</h1>
        {services.length === 0 ? (
          <p>No services yet. Create a key to add one.</p>
        ) : (
          <ul class="list">
            {services.map((s: { slug: string; keys: number; links: number; clicks_7d: number; disabled_at: Date | null }) => (
              <li>
                <a href={`/admin/services/${s.slug}`}>{s.slug}</a>
                <span class="meta">
                  {plural(s.keys, "key")} · {plural(s.links, "link")} · {plural(s.clicks_7d, "click")} in 7 days
                  {s.disabled_at && " · disabled"}
                </span>
              </li>
            ))}
          </ul>
        )}
        <KeyForm />
      </Layout>,
    );
  });

  app.post("/keys", async (c) => {
    const body = await c.req.parseBody({ all: true });
    const service = String(body.service ?? "").trim();
    const name = String(body.name ?? "").trim();
    const scopes = [body.scopes ?? []].flat().map(String);
    const errors: string[] = [];
    if (!SLUG.test(service)) errors.push("Service: lowercase letters, digits and dashes, up to 40 characters.");
    if (name.length < 1 || name.length > 100) errors.push("Key name: 1–100 characters.");
    if (scopes.length === 0 || !scopes.every((s) => (SCOPES as readonly string[]).includes(s))) {
      errors.push("Pick at least one scope.");
    }
    if (errors.length) {
      return c.html(
        <Layout title="New key" signedIn>
          <KeyForm service={service} errors={errors} />
        </Layout>,
        422,
      );
    }
    const { token, key } = await issueKey(sql, { serviceSlug: service, name, scopes: scopes as Scope[] });
    return c.html(
      <Layout title="Key created" signedIn>
        <h1>Key created for {service}</h1>
        <p>
          Copy it now. It is shown only once and cannot be recovered.
        </p>
        <pre class="secret">{token}</pre>
        <p class="meta">
          {key.name} · {key.scopes.join(", ")}
        </p>
        <p>
          <a href={`/admin/services/${service}`}>Back to {service}</a>
        </p>
      </Layout>,
    );
  });

  app.post("/keys/:id/revoke", async (c) => {
    const id = c.req.param("id");
    const [row] = /^[0-9a-f-]{36}$/i.test(id)
      ? await sql`
          update api_keys k set revoked_at = coalesce(k.revoked_at, now())
          from services s where k.id = ${id} and s.id = k.service_id
          returning s.slug`
      : [];
    if (!row) return c.notFound();
    return c.redirect(`/admin/services/${row.slug}`, 303);
  });

  app.get("/services/:slug", async (c) => {
    const [service] = await sql`select id, slug, name from services where slug = ${c.req.param("slug")}`;
    if (!service) return c.notFound();
    const status = ["active", "expired", "disabled"].includes(c.req.query("status") ?? "") ? c.req.query("status")! : "all";
    const keys = await sql`
      select id, name, prefix, scopes, created_at, last_used_at, revoked_at from api_keys
      where service_id = ${service.id} order by revoked_at nulls first, id desc`;
    const webhooks = await sql`
      select w.url, w.disabled_at,
        (select count(*)::int from webhook_deliveries d where d.webhook_id = w.id and d.status = 'dead') as dead,
        (select count(*)::int from webhook_deliveries d where d.webhook_id = w.id and d.status = 'pending') as pending
      from webhooks w where w.service_id = ${service.id} order by w.id desc`;

    return c.html(
      <Layout title={service.slug} signedIn>
        <h1>{service.slug}</h1>
        {await LinkList({ sql, serviceId: service.id, status })}
        <LinkForm slug={service.slug} />
        <section>
          <h2>API keys</h2>
          <ul class="list">
            {keys.map((row: Parameters<typeof toApiKey>[0]) => {
              const k = toApiKey(row);
              return (
                <li>
                  <span>
                    <strong>{k.name}</strong> <code>{k.prefix}</code>
                  </span>
                  <span class="meta">
                    {k.scopes.join(", ")} · last used {when(k.last_used_at)}
                    {k.revoked_at && ` · revoked ${when(k.revoked_at)}`}
                  </span>
                  {!k.revoked_at && (
                    <form method="post" action={`/admin/keys/${k.id}/revoke`}>
                      <button type="submit" class="danger">
                        Revoke
                      </button>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
          <KeyForm service={service.slug} />
        </section>
        {webhooks.length > 0 && (
          <section>
            <h2>Webhooks</h2>
            <ul class="list">
              {webhooks.map((w: { url: string; disabled_at: Date | null; dead: number; pending: number }) => (
                <li>
                  <code>{w.url}</code>
                  <span class="meta">
                    {w.pending} pending · {w.dead} dead{w.disabled_at && " · disabled"}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </Layout>,
    );
  });

  return app;
}
