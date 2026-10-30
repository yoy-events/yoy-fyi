import type { SQL } from "bun";
import { Hono } from "hono";
import { isUuid } from "../http";
import { clientLabel } from "../oauth";
import { Layout, when } from "./layout";

type GrantRow = { id: string; client_id: string; client: string | null; service: string; scopes: string[]; created_at: Date; last_used_at: Date | null };

// OAuth connections made from claude.ai, ChatGPT and other MCP clients (ADR-0003).
export function appsRoutes(sql: SQL, now: () => Date) {
  const app = new Hono();

  app.get("/apps", async (c) => {
    const grants: GrantRow[] = await sql`
      select g.id, g.client_id, cl.name as client, s.slug as service, g.scopes, g.created_at, g.last_used_at
      from oauth_grants g
      join services s on s.id = g.service_id
      left join oauth_clients cl on cl.client_id = g.client_id
      where g.revoked_at is null and g.refresh_expires_at > ${now()}
      order by g.created_at desc`;
    return c.html(
      <Layout title="Connected apps" signedIn>
        <h1>Connected apps</h1>
        {grants.length === 0 ? (
          <p>No apps are connected. Add https://yoy.fyi/mcp as a connector in claude.ai or ChatGPT to connect one.</p>
        ) : (
          <ul class="list">
            {grants.map((g) => (
              <li>
                <strong>{clientLabel(g.client_id, g.client)}</strong> for <a href={`/admin/services/${g.service}`}>{g.service}</a>
                <span class="meta">
                  {g.scopes.join(", ")} · connected {when(g.created_at)} · last used {when(g.last_used_at)}
                </span>
                <form method="post" action={`/admin/apps/${g.id}/revoke`}>
                  <button type="submit" class="secondary">
                    Revoke
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </Layout>,
    );
  });

  app.post("/apps/:id/revoke", async (c) => {
    const id = c.req.param("id");
    if (isUuid(id)) await sql`update oauth_grants set revoked_at = ${now()} where id = ${id} and revoked_at is null`;
    return c.redirect("/admin/apps", 303);
  });

  return app;
}
