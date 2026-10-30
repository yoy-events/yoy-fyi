import type { Child } from "hono/jsx";

// A form's problems above its fields; nothing when there are none.
export function Errors({ errors = [] }: { errors?: string[] }) {
  return errors.length > 0 ? (
    <ul class="errors">
      {errors.map((e) => (
        <li>{e}</li>
      ))}
    </ul>
  ) : null;
}

// A time in UTC to the minute, as the admin and account pages list them.
export const when = (d: Date | null, never = "never") => (d ? d.toISOString().slice(0, 16).replace("T", " ") : never);

export function Layout({ title, signedIn = false, children }: { title: string; signedIn?: boolean; children: Child }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>{`${title} · yoy.fyi admin`}</title>
        <link rel="stylesheet" href="/static/admin.css" />
      </head>
      <body>
        <header>
          <a href="/admin" class="brand">
            yoy.fyi
          </a>
          {signedIn && <a href="/admin/users">Users</a>}
          {signedIn && <a href="/admin/apps">Connected apps</a>}
          {signedIn && <a href="/admin/ai">AI usage</a>}
          {signedIn && (
            <form method="post" action="/admin/logout">
              <button type="submit" class="link">
                Sign out
              </button>
            </form>
          )}
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
