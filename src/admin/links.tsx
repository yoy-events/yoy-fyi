import type { SQL } from "bun";
import { Hono } from "hono";
import { type LinkRow, createLink, toLink } from "../links";
import { Layout } from "./layout";

type Deps = { sql: SQL; publicOrigin: string; resolveHost?: (host: string) => Promise<string[]> };
type FormValues = Record<string, string>;

const UTM = ["utm_source", "utm_medium", "utm_campaign"] as const;

// Turns the admin form into the same JSON body POST /v1/links accepts; blank fields are omitted.
function linkBody(f: FormValues): Record<string, unknown> {
  const body: Record<string, unknown> = { target_url: f.target_url ?? "" };
  if (f.code) body.code = f.code;
  if (f.title) body.title = f.title;
  const tags = (f.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  if (tags.length) body.tags = tags;
  const utm = Object.fromEntries(UTM.filter((k) => f[k]).map((k) => [k, f[k]]));
  if (Object.keys(utm).length) body.utm_defaults = utm;
  if (f.expires_at) body.expires_at = `${f.expires_at}:00Z`;
  if (f.pass_click_id === "on") body.pass_click_id = true;
  return body;
}

export function LinkForm({ slug, values = {}, errors = [] }: { slug: string; values?: FormValues; errors?: string[] }) {
  return (
    <form method="post" action={`/admin/services/${slug}/links`} class="stack card">
      <h2>New link</h2>
      {errors.length > 0 && (
        <ul class="errors">
          {errors.map((e) => (
            <li>{e}</li>
          ))}
        </ul>
      )}
      <label>
        Target URL
        <input type="url" name="target_url" required value={values.target_url ?? ""} placeholder="https://" />
      </label>
      <label>
        Custom code <span class="meta">(optional)</span>
        <input name="code" value={values.code ?? ""} pattern="[A-Za-z0-9_-]{1,64}" />
      </label>
      <label>
        Title
        <input name="title" value={values.title ?? ""} maxlength={200} />
      </label>
      <label>
        Tags <span class="meta">(comma-separated)</span>
        <input name="tags" value={values.tags ?? ""} />
      </label>
      {UTM.map((k) => (
        <label>
          {k}
          <input name={k} value={values[k] ?? ""} />
        </label>
      ))}
      <label>
        Expires <span class="meta">(UTC)</span>
        <input type="datetime-local" name="expires_at" value={values.expires_at ?? ""} />
      </label>
      <label class="check">
        <input type="checkbox" name="pass_click_id" checked={values.pass_click_id === "on"} /> Pass click id as yoy_sid
      </label>
      <button type="submit">Create link</button>
    </form>
  );
}

export async function LinkList({ sql, serviceId, status }: { sql: SQL; serviceId: string; status: string }) {
  const rows: (LinkRow & { status: string })[] = await sql`
    select *, case when disabled_at is not null then 'disabled'
                   when expires_at <= now() then 'expired' else 'active' end as status
    from links where service_id = ${serviceId}
      and (${status} = 'all' or case when disabled_at is not null then 'disabled'
                                     when expires_at <= now() then 'expired' else 'active' end = ${status})
    order by id desc limit 100`;
  return (
    <section>
      <h2>Links</h2>
      <nav class="filters">
        {["all", "active", "expired", "disabled"].map((s) => (
          <a href={`?status=${s}`} aria-current={s === status ? "page" : undefined}>
            {s}
          </a>
        ))}
      </nav>
      {rows.length === 0 ? (
        <p class="meta">No links.</p>
      ) : (
        <ul class="list">
          {rows.map((l) => (
            <li>
              <a href={`/admin/links/${l.id}`}>{l.code}</a>
              <span class="meta truncate">{l.title ?? l.target_url}</span>
              <span class={`badge ${l.status}`}>{l.status}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function linkRoutes({ sql, publicOrigin, resolveHost }: Deps) {
  const app = new Hono();
  const ownHost = new URL(publicOrigin).hostname;

  app.post("/services/:slug/links", async (c) => {
    const slug = c.req.param("slug");
    const [service] = await sql`select id from services where slug = ${slug}`;
    if (!service) return c.notFound();
    const values = Object.fromEntries(Object.entries(await c.req.parseBody()).map(([k, v]) => [k, String(v).trim()]));

    const result = await createLink(sql, { ownHost, resolveHost }, service.id, linkBody(values));
    if (result.kind !== "error") return c.redirect(`/admin/links/${result.row.id}`, 303);

    const fields = (result.details?.fields ?? {}) as Record<string, string>;
    const errors = Object.keys(fields).length
      ? Object.entries(fields).map(([k, v]) => `${k}: ${v}`)
      : [result.details?.reason ? `${result.message} (${result.details.reason})` : result.message];
    return c.html(
      <Layout title="New link" signedIn>
        <LinkForm slug={slug} values={values} errors={errors} />
      </Layout>,
      result.status,
    );
  });

  app.get("/links/:id", async (c) => {
    const id = c.req.param("id");
    const [row] = /^[0-9a-f-]{36}$/i.test(id)
      ? await sql`select l.*, s.slug from links l join services s on s.id = l.service_id where l.id = ${id}`
      : [];
    if (!row) return c.notFound();
    const link = toLink(row as LinkRow, publicOrigin);
    return c.html(
      <Layout title={link.code} signedIn>
        <p class="meta">
          <a href={`/admin/services/${row.slug}`}>{row.slug}</a>
        </p>
        <h1>{link.title ?? link.code}</h1>
        <p>
          <code>{link.short_url}</code> → <span class="truncate">{link.target_url}</span>
        </p>
        <p>
          <span class={`badge ${link.status}`}>{link.status}</span>
          {link.tags.length > 0 && <span class="meta"> · {link.tags.join(", ")}</span>}
        </p>
        {link.status !== "disabled" && (
          <form method="post" action={`/admin/links/${link.id}/disable`}>
            <button type="submit" class="danger">
              Disable link
            </button>
          </form>
        )}
      </Layout>,
    );
  });

  app.post("/links/:id/disable", async (c) => {
    const id = c.req.param("id");
    const [row] = /^[0-9a-f-]{36}$/i.test(id)
      ? await sql`
          update links set disabled_at = coalesce(disabled_at, now()),
                           updated_at = case when disabled_at is null then now() else updated_at end
          where id = ${id} returning id`
      : [];
    if (!row) return c.notFound();
    return c.redirect(`/admin/links/${row.id}`, 303);
  });

  return app;
}
