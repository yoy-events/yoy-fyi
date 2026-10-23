import type { SQL } from "bun";
import { Hono } from "hono";

export type AppDeps = {
  sql: SQL;
  publicOrigin: string;
};

const CODE = /^[A-Za-z0-9_-]{1,64}$/;

type LinkRow = {
  id: string;
  service_id: string;
  target_url: string;
  utm_defaults: Record<string, string> | null;
  pass_click_id: boolean;
  gone: boolean;
};

const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body><h1>${title}</h1><p>${body}</p></body></html>`;

export function createApp({ sql }: AppDeps) {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true }));

  app.get("/:code", async (c) => {
    const code = c.req.param("code");
    if (!CODE.test(code)) return c.html(page("Not found", "This short link does not exist."), 404);

    const [link]: LinkRow[] = await sql`
      select id, service_id, target_url, utm_defaults, pass_click_id,
             (disabled_at is not null or expires_at <= now()) as gone
      from links where code = ${code}`;
    if (!link) return c.html(page("Not found", "This short link does not exist."), 404);
    if (link.gone) return c.html(page("Link no longer available", "This short link was disabled or has expired."), 410);

    c.header("Cache-Control", "no-store");
    return c.redirect(link.target_url, 302);
  });

  app.notFound((c) => c.html(page("Not found", "This short link does not exist."), 404));

  return app;
}
