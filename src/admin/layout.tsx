import type { Child } from "hono/jsx";

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
