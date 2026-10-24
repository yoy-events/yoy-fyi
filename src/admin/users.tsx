import type { SQL } from "bun";
import { Hono } from "hono";
import { isUuid } from "../http";
import { Layout } from "./layout";

const when = (d: Date | null) => (d ? d.toISOString().slice(0, 16).replace("T", " ") : "never");

type UserRow = { id: string; email: string; name: string | null; slug: string; links: number; created_at: Date; last_seen_at: Date | null; disabled_at: Date | null };

// People who signed in with Google (ADR-0004). Blocking also disables their personal service, so
// their links answer 410 and their keys stop working; unblocking restores both.
export function userRoutes(sql: SQL, now: () => Date) {
  const app = new Hono();

  app.get("/users", async (c) => {
    const users: UserRow[] = await sql`
      select u.id, u.email, u.name, s.slug, u.created_at, u.last_seen_at, u.disabled_at,
             (select count(*)::int from links l where l.service_id = s.id) as links
      from users u join services s on s.owner_user_id = u.id
      order by u.created_at desc limit 500`;
    return c.html(
      <Layout title="Users" signedIn>
        <h1>Users</h1>
        {users.length === 0 ? (
          <p>Nobody has signed in on the home page yet.</p>
        ) : (
          <ul class="list">
            {users.map((u) => (
              <li>
                <strong>{u.email}</strong> {u.name && <span class="meta">{u.name}</span>}
                <span class="meta">
                  <a href={`/admin/services/${u.slug}`}>{u.slug}</a> · {u.links} {u.links === 1 ? "link" : "links"} · joined{" "}
                  {when(u.created_at)} · last seen {when(u.last_seen_at)}
                </span>
                {u.disabled_at && <span class="badge disabled">blocked</span>}
                <form method="post" action={`/admin/users/${u.id}/${u.disabled_at ? "unblock" : "block"}`}>
                  <button type="submit" class={u.disabled_at ? "secondary" : "danger"}>
                    {u.disabled_at ? "Unblock" : "Block"}
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </Layout>,
    );
  });

  for (const action of ["block", "unblock"] as const) {
    app.post(`/users/:id/${action}`, async (c) => {
      const id = c.req.param("id");
      if (!isUuid(id)) return c.notFound();
      const at = action === "block" ? now() : null;
      const [user] = await sql.begin(async (tx) => {
        const rows = await tx`update users set disabled_at = ${at} where id = ${id} returning id`;
        if (rows.length) await tx`update services set disabled_at = ${at} where owner_user_id = ${id}`;
        return rows;
      });
      if (!user) return c.notFound();
      return c.redirect("/admin/users", 303);
    });
  }

  return app;
}
