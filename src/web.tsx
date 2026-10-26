// The personal side of yoy.fyi (ADR-0004): sign in with Google, see and create your own short
// links, download QR codes, and create API keys for your own service.
import type { SQL } from "bun";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie, setCookie } from "hono/cookie";
import { csrf } from "hono/csrf";
import { raw } from "hono/html";
import type { Child } from "hono/jsx";
import { type AdminConfig, startGoogle } from "./admin/auth";
import { BarChart, Ranking } from "./admin/charts";
import { linkBody, previewFrom } from "./admin/links";
import { timeseries, breakdown } from "./analytics";
import { isUuid } from "./http";
import { type Scope, issueKey } from "./keys";
import { type LinkRow, createLink, toLink, updateLink } from "./links";
import { conversionTotals } from "./conversions";
import { parseCsv, toCsv } from "./csv";
import { type QrError, type QrStyle, qrOptions, qrPng, qrSvg } from "./qr";
import { createRateLimiter } from "./ratelimit";
import type { UnsafeUrls } from "./safe-browsing";
import { checkTarget } from "./target-policy";
import { clientLabel } from "./oauth";
import { issueConnectToken } from "./telegram";
import { LANGS, type Lang } from "./blog";
import { MESSAGES } from "./messages";
import { PUBLIC_TEXT } from "./public-text";
import { HANDLE, bioErrorText, saveBio } from "./bio";
import { type User, clearUserSession, currentUser } from "./users";

const DAY = 86_400_000;
const MAX_KEYS = 10;
// What a person may grant their own keys. Keys are managed here, never through keys:manage.
const USER_SCOPES = ["links:read", "links:write", "analytics:read", "webhooks:manage", "conversions:write"] as const satisfies readonly Scope[];
// Messages for a createLink / updateLink error, in the page's language.
function errorList(T: Msg, r: { code: string; message: string; details?: Record<string, unknown> }): string[] {
  const fields = (r.details?.fields ?? {}) as Record<string, string>;
  if (Object.keys(fields).length) return Object.keys(fields).map((k) => T.fields[k] ?? T.unknownField(k));
  if (r.code === "target_rejected") {
    const reason = String(r.details?.reason ?? "");
    const what = r.details?.field === "preview.image" ? T.previewImageNotAllowed : T.targetNotAllowed;
    return [`${what}: ${T.reasons[reason] ?? reason}.`];
  }
  return [T.codes[r.code] ?? r.message];
}

type Msg = (typeof MESSAGES)[Lang];
const qrErrorText = (T: Msg, code: QrError) => (code === "caption" ? T.qr.caption(40) : T.qr[code]);
const LANG_COOKIE = "yfi_lang";
const isLang = (v: unknown): v is Lang => typeof v === "string" && (LANGS as readonly string[]).includes(v);
const langOf = (c: Context): Lang => (c.get("lang" as never) as Lang | undefined) ?? "uk";
const tr = (c: Context): Msg => MESSAGES[langOf(c)];

type Deps = {
  sql: SQL;
  publicOrigin: string;
  admin: AdminConfig;
  now: () => Date;
  resolveHost?: (host: string) => Promise<string[]>;
  unsafeUrls?: UnsafeUrls;
  // The bot's username, when the Telegram bot is configured.
  telegramBot?: string;
};
type Env = { Variables: { user: User; lang: Lang } };

// `bot` is the Telegram bot's username; without a bot the Telegram link is hidden.
function Page({
  title,
  user,
  og,
  bot,
  jsonLd,
  canonical,
  lang = "uk",
  alternates,
  children,
}: {
  title: string;
  user?: User | null;
  og?: { title: string; description?: string };
  bot?: string;
  jsonLd?: object;
  canonical?: string;
  lang?: Lang;
  alternates?: Record<string, string>;
  children: Child;
}) {
  const T = MESSAGES[lang];
  return (
    <html lang={lang}>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>{title === "yoy.fyi" ? title : `${title} · yoy.fyi`}</title>
        <link rel="stylesheet" href="/static/admin.css" />
        {og && <meta property="og:title" content={og.title} />}
        {og?.description && <meta property="og:description" content={og.description} />}
        {og?.description && <meta name="description" content={og.description} />}
        {canonical && <link rel="canonical" href={canonical} />}
        {alternates &&
          Object.entries(alternates).map(([l, href]) => <link rel="alternate" hreflang={l} href={href} />)}
        {jsonLd && <script type="application/ld+json">{raw(JSON.stringify(jsonLd).replace(/</g, "\\u003c"))}</script>}
        <script src="/static/copy.js" defer></script>
      </head>
      <body>
        <header>
          <a href="/" class="brand">
            yoy.fyi
          </a>
          {user && <a href="/account/keys">{T.nav.keys}</a>}
          {user && <a href="/account/apps">{T.nav.apps}</a>}
          {user && bot && <a href="/account/telegram">Telegram</a>}
          {user && <a href="/account/bio">{T.nav.bio}</a>}
          {user && (
            <form method="post" action="/logout">
              <button type="submit" class="link">
                {T.nav.signOut}
              </button>
            </form>
          )}
        </header>
        <main>{children}</main>
        <footer class="meta">
          <a href={`/blog/${lang}`}>{T.nav.blog}</a> · <a href="/privacy">{T.nav.privacy}</a> · <a href="/terms">{T.nav.terms}</a> ·{" "}
          {LANGS.filter((l) => l !== lang).map((l) => (
            <>
              <a href={`/lang/${l}`} hreflang={l}>
                {LANG_NAMES[l]}
              </a>{" "}
            </>
          ))}
        </footer>
      </body>
    </html>
  );
}

// Channel variants of a short link: the redirect passes these query parameters on to the target
// and records them on the click (see buildTarget), so no extra link is needed.
const CHANNELS = [
  ["Telegram", "telegram", "social"],
  ["Instagram", "instagram", "social"],
  ["Facebook", "facebook", "social"],
  ["email", "email", "email"],
] as const;

const LANG_NAMES: Record<Lang, string> = { uk: "Українська", en: "English", es: "Español", fr: "Français" };

const OPTIONAL = ["title", "code", "tags", "utm_source", "utm_medium", "utm_campaign", "preview_title", "preview_description", "preview_image"] as const;

// What Telegram, Facebook and others show when the short link is shared.
function PreviewFields({ values, T }: { values: Record<string, string | undefined>; T: Msg }) {
  return (
    <fieldset>
      <legend>{T.preview.legend}</legend>
      <label>
        {T.preview.title}
        <input name="preview_title" maxlength={200} value={values.preview_title ?? ""} />
      </label>
      <label>
        {T.preview.description}
        <input name="preview_description" maxlength={500} value={values.preview_description ?? ""} />
      </label>
      <label>
        {T.preview.image} <span class="meta">{T.preview.imageHint}</span>
        <input type="url" name="preview_image" value={values.preview_image ?? ""} placeholder="https://" />
      </label>
    </fieldset>
  );
}

// One field to start with, like Bitly and Dub; the rest waits under More options (no JavaScript).
function CreateForm({ values = {}, errors = [], T }: { values?: Record<string, string>; errors?: string[]; T: Msg }) {
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
        {T.create.paste}
        <input type="url" name="target_url" required value={values.target_url ?? ""} placeholder="https://" />
      </label>
      <details open={open}>
        <summary>{T.create.more}</summary>
        <div class="stack">
          <label>
            {T.create.title}
            <input name="title" value={values.title ?? ""} maxlength={200} />
          </label>
          <label>
            {T.create.code} <span class="meta">{T.create.codeHint}</span>
            <input name="code" value={values.code ?? ""} />
          </label>
          <label>
            {T.create.tags} <span class="meta">{T.create.tagsHint}</span>
            <input name="tags" value={values.tags ?? ""} />
          </label>
          {(["utm_source", "utm_medium", "utm_campaign"] as const).map((k) => (
            <label>
              {k}
              <input name={k} value={values[k] ?? ""} />
            </label>
          ))}
          <PreviewFields values={values} T={T} />
        </div>
      </details>
      <button type="submit">{T.create.shorten}</button>
    </form>
  );
}

export function webRoutes({ sql, publicOrigin, admin, now, resolveHost, unsafeUrls, telegramBot }: Deps) {
  const app = new Hono<Env>();
  const ownHost = new URL(publicOrigin).hostname;
  const limitCreate = createRateLimiter({ perMinute: 20 / 60, burst: 20 });
  const user = (c: Context) => currentUser(c, sql, admin.sessionSecret, now());

  // The page language: the visitor's choice (cookie), else the browser's language, else Ukrainian.
  app.use(async (c, next) => {
    const chosen = getCookie(c, LANG_COOKIE);
    const browser = (c.req.header("accept-language") ?? "").toLowerCase().slice(0, 2);
    c.set("lang", isLang(chosen) ? chosen : isLang(browser) ? browser : "uk");
    await next();
  });

  // Switching language keeps the visitor on the page they came from (same origin only).
  app.get("/lang/:lang{(?:uk|en|es|fr)}", (c) => {
    setCookie(c, LANG_COOKIE, c.req.param("lang"), { path: "/", maxAge: 365 * 86_400, sameSite: "Lax", secure: true, httpOnly: true });
    let back = "/";
    try {
      const ref = new URL(c.req.header("referer") ?? "");
      if (ref.origin === publicOrigin && !ref.pathname.startsWith("//")) back = ref.pathname + ref.search;
    } catch {}
    return c.redirect(back, 303);
  });

  // Form posts must come from our own origin.
  app.use("/links/*", csrf({ origin: publicOrigin }));
  app.use("/links", csrf({ origin: publicOrigin }));
  app.use("/account/*", csrf({ origin: publicOrigin }));
  app.use("/logout", csrf({ origin: publicOrigin }));

  // Pages need a session; form posts without one get 401 instead of a redirect.
  const signedIn = async (c: Context<Env>, next: () => Promise<void>) => {
    const u = await user(c);
    if (!u) return c.req.method === "GET" ? c.redirect("/", 302) : c.text(tr(c).signInFirst, 401);
    c.set("user", u);
    await next();
  };
  app.use("/links", signedIn);
  app.use("/links/*", signedIn);
  app.use("/account/*", signedIn);

  const ownLink = async (u: User, id: string) =>
    isUuid(id) ? ((await sql`select * from links where id = ${id} and service_id = ${u.serviceId}`)[0] as LinkRow | undefined) : undefined;

  async function home(c: Context, u: User, form?: { values: Record<string, string>; errors: string[] }, status: 200 | 422 = 200) {
    const T = tr(c);
    // The link just created, shown on top with its QR, like Dub and Bitly.
    const createdRow = await ownLink(u, c.req.query("created") ?? "");
    const created = createdRow ? toLink(createdRow, publicOrigin, now()) : null;
    // Search matches code, title and target as plain text; LIKE wildcards in it are escaped.
    const q = (c.req.query("q") ?? "").trim().slice(0, 200);
    const tag = (c.req.query("tag") ?? "").trim().slice(0, 50);
    const pattern = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
    const links: (LinkRow & { clicks_7d: number })[] = await sql`
      select l.*, coalesce((select sum(d.clicks) from link_stats_daily d
                            where d.link_id = l.id and not d.is_bot and d.bucket >= ${new Date(now().getTime() - 7 * DAY)}), 0)::int as clicks_7d
      from links l
      where l.service_id = ${u.serviceId}
        and (${q} = '' or l.code ilike ${pattern} or l.title ilike ${pattern} or l.target_url ilike ${pattern})
        and (${tag} = '' or ${tag} = any(l.tags))
      order by l.id desc limit 200`;
    const tags: { tag: string }[] = await sql`
      select distinct unnest(tags) as tag from links where service_id = ${u.serviceId} order by tag limit 50`;
    const filtered = q !== "" || tag !== "";
    return c.html(
      <Page title={T.home.title} user={u} bot={telegramBot} lang={langOf(c)}>
        <h1>{T.home.title}</h1>
        {created && (
          <section class="card stack created">
            <h2>{T.home.ready}</h2>
            <div class="row">
              <input value={created.short_url} readonly aria-label={T.home.shortLink} />
              <button type="button" data-copy={created.short_url}>
                {T.home.copy}
              </button>
            </div>
            <img src={`/links/${created.id}/qr.svg`} alt={T.home.qrFor(created.short_url)} class="qr" width="160" height="160" />
            <p>
              {T.home.downloadQr} <a href={`/links/${created.id}/qr.png`} download={`${created.code}.png`}>PNG</a> ·{" "}
              <a href={`/links/${created.id}/qr.svg`} download={`${created.code}.svg`}>SVG</a> ·{" "}
              <a href={`/links/${created.id}`}>{T.home.stats}</a>
            </p>
          </section>
        )}
        {links.length === 0 && !created && !filtered && (
          <p class="notice">
            {T.home.firstHint}
          </p>
        )}
        <CreateForm values={form?.values} errors={form?.errors} T={T} />
        <p class="meta">
          <a href="/links/import">{T.home.importCsv}</a>
          {links.length > 0 && (
            <>
              {" "}
              · <a href="/links/export.csv">{T.home.exportCsv}</a>
            </>
          )}
        </p>
        {(links.length > 0 || filtered) && (
          <form method="get" action="/" class="row">
            <input type="search" name="q" value={q} placeholder={T.home.search} aria-label={T.home.search} />
            {tag && <input type="hidden" name="tag" value={tag} />}
            <button type="submit" class="secondary">
              {T.home.searchButton}
            </button>
          </form>
        )}
        {tags.length > 0 && (
          <p class="meta">
            {T.home.tags}{" "}
            {tags.map((t) => (
              <>
                <a href={`/?tag=${encodeURIComponent(t.tag)}`} class={t.tag === tag ? "badge active" : "badge"}>
                  {t.tag}
                </a>{" "}
              </>
            ))}
            {filtered && <a href="/">{T.home.showAll}</a>}
          </p>
        )}
        {filtered && links.length === 0 && <p class="notice">{T.home.nothing}</p>}
        {links.length > 0 && (
          <ul class="list">
            {links.map((row) => {
              const l = toLink(row, publicOrigin, now());
              return (
                <li>
                  <a href={`/links/${l.id}`}>{l.title ?? l.code}</a>
                  <span class="meta truncate">{l.target_url}</span>
                  <span class="meta">
                    {l.short_url} · {T.home.clicks7d(row.clicks_7d)}
                  </span>
                  {l.status !== "active" && <span class={`badge ${l.status}`}>{T.status[l.status]}</span>}
                </li>
              );
            })}
          </ul>
        )}
      </Page>,
      status,
    );
  }

  // The public landing page and the MCP guide in the site languages (see public-text.ts).
  const langPath = (lang: Lang, path: string) => (lang === "uk" ? path || "/" : `/${lang}${path}`);
  const alternatesFor = (path: string) =>
    Object.fromEntries([...LANGS.map((l) => [l, `${publicOrigin}${langPath(l, path)}`]), ["x-default", `${publicOrigin}${path || "/"}`]]);
  const LangLinks = ({ lang, path }: { lang: Lang; path: string }) => (
    <p class="meta">
      {LANGS.filter((l) => l !== lang).map((l) => (
        <>
          <a href={langPath(l, path)} hreflang={l}>
            {LANG_NAMES[l]}
          </a>{" "}
        </>
      ))}
    </p>
  );

  const landing = (c: Context, lang: Lang, u: User | null) => {
    const t = PUBLIC_TEXT[lang];
    const mcp = `${publicOrigin}/mcp`;
    const [aiBefore] = t.ai(mcp);
    return c.html(
      <Page
        title={t.title}
        lang={lang}
        user={u}
        bot={telegramBot}
        og={{ title: t.ogTitle, description: t.description }}
        canonical={`${publicOrigin}${langPath(lang, "")}`}
        alternates={alternatesFor("")}
        jsonLd={{
          "@context": "https://schema.org",
          "@graph": [
            {
              "@type": "WebApplication",
              name: "yoy.fyi",
              url: `${publicOrigin}/`,
              applicationCategory: "BusinessApplication",
              operatingSystem: "Any",
              inLanguage: lang,
              description: t.description,
              offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
            },
            {
              "@type": "FAQPage",
              inLanguage: lang,
              mainEntity: t.faq.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })),
            },
          ],
        }}
      >
        <LangLinks lang={lang} path="" />
        <h1>{t.h1}</h1>
        <p>{t.description}</p>
        {u ? (
          <a class="button" href="/">
            {t.myLinks}
          </a>
        ) : admin.google ? (
          <a class="button" href="/login/google">
            {t.signIn}
          </a>
        ) : (
          <p class="meta">{t.signInUnavailable}</p>
        )}
        <h2>{t.featuresTitle}</h2>
        <ul>
          {t.features.map((f) => (
            <li>{f}</li>
          ))}
        </ul>
        <h2>{t.aiTitle}</h2>
        <p>
          {aiBefore} <a href={langPath(lang, "/docs/mcp")}>{t.guide}</a>.
        </p>
        <h2>{t.faqTitle}</h2>
        {t.faq.map(([q, a]) => (
          <>
            <h3>{q}</h3>
            <p>{a}</p>
          </>
        ))}
        <p>
          <a href={`/blog/${lang}`}>{t.footer.blog}</a> · <a href={langPath(lang, "/docs/mcp")}>{t.footer.guide}</a> ·{" "}
          <a href="/v1/openapi.json">API</a>
        </p>
      </Page>,
    );
  };

  app.get("/", async (c) => {
    const u = await user(c);
    if (u) return home(c, u);
    return landing(c, "uk", null);
  });
  app.get("/:lang{(?:en|es|fr)}", async (c) => landing(c, c.req.param("lang") as Lang, await user(c)));

  const docs = async (c: Context, lang: Lang) => {
    const t = PUBLIC_TEXT[lang].docs;
    const mcp = `${publicOrigin}/mcp`;
    return c.html(
      <Page
        title={t.title}
        lang={lang}
        user={await user(c)}
        bot={telegramBot}
        og={{ title: t.title, description: t.description }}
        canonical={`${publicOrigin}${langPath(lang, "/docs/mcp")}`}
        alternates={alternatesFor("/docs/mcp")}
      >
        <LangLinks lang={lang} path="/docs/mcp" />
        <h1>{t.h1}</h1>
        <p>{t.intro(mcp)}</p>
        <h2>claude.ai</h2>
        <ol>
          {t.claudeAi.map((s) => (
            <li>{s}</li>
          ))}
        </ol>
        <h2>ChatGPT</h2>
        <ol>
          {t.chatgpt.map((s) => (
            <li>{s}</li>
          ))}
        </ol>
        <h2>Claude Code</h2>
        <pre>
          <code>{`claude mcp add --transport http yoy-fyi ${mcp}`}</code>
        </pre>
        <p>{t.claudeCodeAfter}</p>
        <h2>{t.cursorTitle}</h2>
        <p>{t.cursorIntro}</p>
        <pre>
          <code>{JSON.stringify({ mcpServers: { "yoy-fyi": { url: mcp } } }, null, 2)}</code>
        </pre>
        <p>
          {t.keyFallback} <a href="/account/keys">{t.keysPage}</a>: <code>Authorization: Bearer yfi_...</code>
        </p>
        <h2>{t.toolsTitle}</h2>
        <ul>
          {t.tools.map(([name, text]) => (
            <li>
              <code>{name}</code>: {text}
            </li>
          ))}
        </ul>
        <h2>{t.safetyTitle}</h2>
        <p>
          {t.safety} <a href="/account/apps">{t.appsPage}</a>.
        </p>
      </Page>,
    );
  };
  app.get("/docs/mcp", (c) => docs(c, "uk"));
  app.get("/:lang{(?:en|es|fr)}/docs/mcp", (c) => docs(c, c.req.param("lang") as Lang));



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
    if (!limitCreate(u.id).ok) return c.text(tr(c).home.tooMany, 429);
    const result = await createLink(sql, { ownHost, resolveHost, unsafeUrls }, u.serviceId, linkBody(values), null, "web");
    if (result.kind !== "error") return c.redirect(`/?created=${result.row.id}`, 303);
    return home(c, u, { values, errors: errorList(tr(c), result) }, 422);
  });

  // CSV import: up to MAX_IMPORT rows per file, each created like a link from the form.
  const IMPORT_COLUMNS = ["target_url", "title", "code", "tags"];
  const MAX_IMPORT = 100;
  const limitImport = createRateLimiter({ perMinute: 5 / 60, burst: 5 });

  type ImportResult = { line: number; short_url?: string; error?: string };
  const importPage = (c: Context, u: User, opts: { error?: string; results?: ImportResult[] } = {}, status: 200 | 422 | 429 = 200) => {
    const T = tr(c);
    const [i0, i1, i2, i3] = T.importPage.intro;
    return c.html(
      <Page title={T.importPage.title} user={u} bot={telegramBot} lang={langOf(c)}>
        <h1>{T.importPage.h1}</h1>
        <p>
          {i0}
          <code>target_url</code>
          {i1}
          <code>title</code>, <code>code</code>
          {i2}
          <code>tags</code>
          {i3} {T.importPage.perFile(MAX_IMPORT)}
        </p>
        {opts.error && <p class="notice">{opts.error}</p>}
        {opts.results && (
          <ul class="list">
            {opts.results.map((r) => (
              <li>
                {T.importPage.line(r.line)}{" "}
                {r.short_url ? (
                  <>
                    <input value={r.short_url} readonly aria-label={T.importPage.shortFromLine(r.line)} />{" "}
                    <button type="button" data-copy={r.short_url}>
                      {T.home.copy}
                    </button>
                  </>
                ) : (
                  <span class="meta">{r.error}</span>
                )}
              </li>
            ))}
          </ul>
        )}
        <form method="post" action="/links/import" enctype="multipart/form-data" class="stack card">
          <label>
            {T.importPage.file}
            <input type="file" name="file" accept=".csv,text/csv" />
          </label>
          <label>
            {T.importPage.orPaste}
            <textarea name="csv" rows={8} placeholder={"target_url,title,tags\nhttps://example.com/,Example,\"a, b\""}></textarea>
          </label>
          <button type="submit">{T.importPage.button}</button>
        </form>
        <p>
          <a href="/links/export.csv">{T.importPage.downloadAll}</a>
        </p>
      </Page>,
      status,
    );
  };

  app.get("/links/import", (c) => importPage(c, c.get("user")));

  // The body limit and the rate limit both apply before the CSV is read or parsed.
  app.post("/links/import", bodyLimit({ maxSize: 256 * 1024, onError: (c) => c.text(tr(c).importPage.tooBig, 413) }), async (c) => {
    const u = c.get("user");
    const T = tr(c);
    if (!limitImport(u.id).ok) return importPage(c, u, { error: T.importPage.tooMany }, 429);
    const form = await c.req.parseBody();
    const text = form.file instanceof File && form.file.size > 0 ? await form.file.text() : String(form.csv ?? "");
    const parsed = parseCsv(text);
    if ("error" in parsed) return importPage(c, u, { error: T.csvUnclosed }, 422);
    if (parsed.length === 0) return importPage(c, u, { error: T.importPage.empty }, 422);
    const [header, ...rows] = parsed as [string[], ...string[][]];
    const columns = header.map((h) => h.trim().toLowerCase());
    const unknown = columns.filter((h) => !IMPORT_COLUMNS.includes(h));
    if (!columns.includes("target_url")) return importPage(c, u, { error: T.importPage.needTarget }, 422);
    if (unknown.length) return importPage(c, u, { error: T.importPage.unknownCols(unknown.join(", ")) }, 422);
    if (rows.length === 0) return importPage(c, u, { error: T.importPage.noRows }, 422);
    if (rows.length > MAX_IMPORT) return importPage(c, u, { error: T.importPage.maxRows(MAX_IMPORT) }, 422);

    const results: ImportResult[] = [];
    for (const [i, row] of rows.entries()) {
      const values = Object.fromEntries(columns.map((k, j) => [k, (row[j] ?? "").trim()]));
      const result = await createLink(sql, { ownHost, resolveHost, unsafeUrls }, u.serviceId, linkBody(values), null, "web");
      results.push(
        result.kind === "error" ? { line: i + 2, error: errorList(T, result).join("; ") } : { line: i + 2, short_url: `${publicOrigin}/${result.row.code}` },
      );
    }
    return importPage(c, u, { results });
  });

  const csvFile = (c: Context, name: string, rows: unknown[][]) =>
    c.body(toCsv(rows), 200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"` });

  app.get("/links/export.csv", async (c) => {
    const u = c.get("user");
    const rows: (LinkRow & { clicks_total: number })[] = await sql`
      select l.*, coalesce((select sum(d.clicks) from link_stats_daily d where d.link_id = l.id and not d.is_bot), 0)::int as clicks_total
      from links l where l.service_id = ${u.serviceId} order by l.id`;
    return csvFile(c, "yoy-fyi-links.csv", [
      ["code", "short_url", "target_url", "title", "tags", "status", "clicks_total", "created_at"],
      ...rows.map((r) => {
        const l = toLink(r, publicOrigin, now());
        return [l.code, l.short_url, l.target_url, l.title, l.tags.join(", "), l.status, r.clicks_total, r.created_at.toISOString()];
      }),
    ]);
  });

  app.get("/links/:id/clicks.csv", async (c) => {
    const u = c.get("user");
    const row = await ownLink(u, c.req.param("id"));
    if (!row) return c.notFound();
    const clicks = await sql`
      select clicked_at, referer_host, country, ua_device, ua_browser, ua_os, utm_source, utm_medium, utm_campaign, is_bot
      from clicks where link_id = ${row.id} order by clicked_at desc limit 10000`;
    return csvFile(c, `${row.code}-clicks.csv`, [
      ["clicked_at", "referer_host", "country", "device", "browser", "os", "utm_source", "utm_medium", "utm_campaign", "is_bot"],
      ...clicks.map((k: Record<string, unknown>) => [
        (k.clicked_at as Date).toISOString(),
        k.referer_host,
        k.country,
        k.ua_device,
        k.ua_browser,
        k.ua_os,
        k.utm_source,
        k.utm_medium,
        k.utm_campaign,
        k.is_bot,
      ]),
    ]);
  });

  // Form fields of the edit form; empty title, tags and expiry clear them.
  const editBody = (f: Record<string, string>) => ({
    target_url: f.target_url ?? "",
    title: f.title || null,
    tags: (f.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean),
    expires_at: f.expires_at ? `${f.expires_at}:00Z` : null,
    preview: previewFrom(f),
  });


  async function linkPage(c: Context, u: User, row: LinkRow, form?: { values: Record<string, string>; errors: string[] }, status: 200 | 409 | 422 = 200) {
    const T = tr(c);
    const link = toLink(row, publicOrigin, now());
    // QR style from the page's own query; the image and downloads carry the same choices.
    const query = new URL(c.req.url).searchParams;
    const parsed = qrOptions(query);
    const qrError = "error" in parsed ? qrErrorText(T, parsed.error) : null;
    const style = "error" in parsed ? (qrOptions(new URLSearchParams()) as QrStyle) : parsed;
    const styled = !qrError && ["fg", "bg", "caption"].some((k) => query.get(k));
    const qrQuery = styled ? `?${new URLSearchParams({ fg: style.fg, bg: style.bg, ...(style.caption ? { caption: style.caption } : {}) })}` : "";
    const values = form?.values ?? {
      target_url: row.target_url,
      title: row.title ?? "",
      tags: row.tags.join(", "),
      expires_at: row.expires_at ? row.expires_at.toISOString().slice(0, 16) : "",
      preview_title: row.preview?.title ?? "",
      preview_description: row.preview?.description ?? "",
      preview_image: row.preview?.image ?? "",
    };
    const dayEnd = Math.floor(now().getTime() / DAY) * DAY + DAY;
    const scope = { serviceId: u.serviceId, linkId: link.id, tag: null, from: new Date(dayEnd - 30 * DAY), to: new Date(dayEnd), bots: "exclude" as const };
    const daily = await timeseries(sql, scope, "day");
    const conversions = await conversionTotals(sql, u.serviceId, new Date(dayEnd - 30 * DAY), new Date(dayEnd), link.id);
    const [referrers, channels, countries, devices] = await Promise.all(
      (["referer_host", "utm_source", "country", "device"] as const).map((d) => breakdown(sql, scope, d, 5)),
    );
    return c.html(
      <Page title={link.title ?? link.code} user={u} bot={telegramBot} lang={langOf(c)}>
        <h1>{link.title ?? link.code}</h1>
        <div class="row">
          <input value={link.short_url} readonly aria-label={T.home.shortLink} />
          <button type="button" data-copy={link.short_url}>
            {T.home.copy}
          </button>
        </div>
        <p class="meta truncate">→ {link.target_url}</p>
        <details>
          <summary>{T.link.channels}</summary>
          <p class="meta">{T.link.channelsHint}</p>
          <div class="stack">
            {CHANNELS.map(([name, source, medium]) => {
              const url = `${link.short_url}?utm_source=${source}&utm_medium=${medium}`;
              return (
                <div class="row">
                  <input value={url} readonly aria-label={T.link.shortFor(name)} />
                  <button type="button" data-copy={url}>
                    {T.link.copyFor(name)}
                  </button>
                </div>
              );
            })}
          </div>
        </details>
        <p>
          <span class={`badge ${link.status}`}>{T.status[link.status]}</span>
          {link.tags.length > 0 && <span class="meta"> · {link.tags.join(", ")}</span>}
        </p>
        <img src={`/links/${link.id}/qr.svg${qrQuery}`} alt={T.home.qrFor(link.short_url)} class="qr" width="160" height="160" />
        <p>
          {T.home.downloadQr}{" "}
          {!style.caption && (
            <>
              <a href={`/links/${link.id}/qr.png${qrQuery}`} download={`${link.code}.png`}>
                PNG
              </a>{" "}
              ·{" "}
            </>
          )}
          <a href={`/links/${link.id}/qr.svg${qrQuery}`} download={`${link.code}.svg`}>
            SVG
          </a>
        </p>
        <details open={!!qrQuery || !!qrError}>
          <summary>{T.link.qrStyle}</summary>
          <form method="get" action={`/links/${link.id}`} class="stack card">
            {qrError && <p class="notice">{qrError}</p>}
            <div class="row">
              <label>
                {T.link.codeColour} <input type="color" name="fg" value={style.fg} />
              </label>
              <label>
                {T.link.background} <input type="color" name="bg" value={style.bg} />
              </label>
            </div>
            <label>
              {T.link.caption} <span class="meta">{T.link.captionHint}</span>
              <input name="caption" maxlength={40} value={style.caption ?? ""} placeholder={T.link.captionPlaceholder} />
            </label>
            <button type="submit" class="secondary">
              {T.link.apply}
            </button>
          </form>
        </details>
        <h2>
          {T.link.clicks30(daily.totals.clicks)} <span class="meta">{T.link.visitors(daily.totals.uniques_upper_bound)}</span>
        </h2>
        <BarChart points={daily.points} label={(t) => t.toISOString().slice(0, 10)} />
        <p class="meta">
          <a href={`/links/${link.id}/clicks.csv`}>{T.link.downloadClicks}</a>
        </p>
        <h2>{T.link.conversions}</h2>
        {conversions.length === 0 ? (
          <p class="meta">{T.link.conversionsHint}</p>
        ) : (
          <ul class="list">
            {conversions.map((e) => (
              <li>
                <strong>{e.event}</strong>
                <span class="meta">{T.link.conversionValue(e.count, e.values.map((v) => `${v.total} ${v.currency}`).join(", "))}</span>
              </li>
            ))}
          </ul>
        )}
        <div class="rankings">
          <Ranking title={T.link.referrers} items={referrers!.items} total={referrers!.total_clicks} />
          <Ranking title={T.link.channelsRanking} items={channels!.items} total={channels!.total_clicks} />
          <Ranking title={T.link.countries} items={countries!.items} total={countries!.total_clicks} />
          <Ranking title={T.link.devices} items={devices!.items} total={devices!.total_clicks} />
        </div>
        {link.status !== "disabled" && (
          <details open={!!form}>
            <summary>{T.link.edit}</summary>
            <form method="post" action={`/links/${link.id}`} class="stack card">
              {form && form.errors.length > 0 && (
                <ul class="errors">
                  {form.errors.map((e) => (
                    <li>{e}</li>
                  ))}
                </ul>
              )}
              <label>
                {T.link.whereTo}
                <input type="url" name="target_url" required value={values.target_url} />
              </label>
              <label>
                {T.create.title}
                <input name="title" maxlength={200} value={values.title} />
              </label>
              <label>
                {T.create.tags} <span class="meta">{T.create.tagsHint}</span>
                <input name="tags" value={values.tags} />
              </label>
              <label>
                {T.link.expires} <span class="meta">{T.link.expiresHint}</span>
                <input type="datetime-local" name="expires_at" value={values.expires_at} />
              </label>
              <PreviewFields values={values} T={T} />
              <button type="submit">{T.link.save}</button>
            </form>
          </details>
        )}
        {form && link.status === "disabled" && <p class="notice">{form.errors.join(" ")}</p>}
        {link.status !== "disabled" ? (
          <form method="post" action={`/links/${link.id}/disable`}>
            <button type="submit" class="danger">
              {T.link.disable}
            </button>
          </form>
        ) : row.disabled_by === "owner" ? (
          <form method="post" action={`/links/${link.id}/enable`}>
            <button type="submit">{T.link.enable}</button>
          </form>
        ) : (
          <p class="meta">{T.link.disabledByUs(admin.email)}</p>
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
    return linkPage(c, u, row, { values, errors: errorList(tr(c), result) }, result.status);
  });

  // Only what the owner disabled can be re-enabled here; admin and Safe Browsing takedowns
  // stay down. The target is checked again in case it changed since.
  app.post("/links/:id/enable", async (c) => {
    const u = c.get("user");
    const row = await ownLink(u, c.req.param("id"));
    if (!row) return c.notFound();
    if (row.disabled_at) {
      const T = tr(c);
      const refuse = (why: string) => linkPage(c, u, row, { values: {}, errors: [T.link.cannotEnable(why)] }, 422);
      if (row.disabled_by !== "owner") return refuse(T.link.byYoy);
      const rejection = await checkTarget(row.target_url, { ownHost, resolve: resolveHost, unsafeUrls });
      if (rejection) return refuse(T.link.notAllowed(T.reasons[rejection] ?? rejection));
      await sql`
        update links set disabled_at = null, disabled_by = null, updated_at = ${now()}
        where id = ${row.id} and service_id = ${u.serviceId} and disabled_by = 'owner'`;
    }
    return c.redirect(`/links/${row.id}`, 303);
  });

  app.get("/links/:id/qr.svg", async (c) => {
    const row = await ownLink(c.get("user"), c.req.param("id"));
    if (!row) return c.notFound();
    const style = qrOptions(new URL(c.req.url).searchParams);
    if ("error" in style) return c.text(qrErrorText(tr(c), style.error), 400);
    return c.body(await qrSvg(`${publicOrigin}/${row.code}`, style), 200, { "Content-Type": "image/svg+xml" });
  });

  app.get("/links/:id/qr.png", async (c) => {
    const row = await ownLink(c.get("user"), c.req.param("id"));
    if (!row) return c.notFound();
    const style = qrOptions(new URL(c.req.url).searchParams);
    if ("error" in style) return c.text(qrErrorText(tr(c), style.error), 400);
    if (style.caption) return c.text(tr(c).qr.svgOnly, 400);
    return c.body(await qrPng(`${publicOrigin}/${row.code}`, style), 200, { "Content-Type": "image/png" });
  });

  app.post("/links/:id/disable", async (c) => {
    const u = c.get("user");
    const id = c.req.param("id");
    if (!(await ownLink(u, id))) return c.notFound();
    await sql`
      update links set disabled_at = ${now()}, disabled_by = 'owner', updated_at = ${now()}
      where id = ${id} and service_id = ${u.serviceId} and disabled_at is null`;
    return c.redirect(`/links/${id}`, 303);
  });

  async function keysPage(c: Context, u: User, opts: { secret?: string; errors?: string[] } = {}, status: 200 | 201 | 422 = 200) {
    const T = tr(c);
    const keys = await sql`
      select id, name, prefix, scopes, created_at, last_used_at from api_keys
      where service_id = ${u.serviceId} and revoked_at is null order by created_at desc`;
    return c.html(
      <Page title={T.keys.title} user={u} bot={telegramBot} lang={langOf(c)}>
        <h1>{T.keys.title}</h1>
        <p>
          {T.keys.intro[0]}
          <a href="/v1/openapi.json">API yoy.fyi</a>
          {T.keys.intro[1]}
          <code>{publicOrigin}/mcp</code>
          {T.keys.intro[2]}
        </p>
        {opts.secret && (
          <p class="notice">
            {T.keys.newShown} <code>{opts.secret}</code>
          </p>
        )}
        <form method="post" action="/account/keys" class="stack card">
          <h2>{T.keys.newKey}</h2>
          {opts.errors && opts.errors.length > 0 && (
            <ul class="errors">
              {opts.errors.map((e) => (
                <li>{e}</li>
              ))}
            </ul>
          )}
          <label>
            {T.keys.name}
            <input name="name" required maxlength={100} placeholder={T.keys.namePlaceholder} />
          </label>
          <fieldset>
            <legend>{T.keys.permissions}</legend>
            {USER_SCOPES.map((s) => (
              <label class="check">
                <input type="checkbox" name="scope" value={s} checked={s !== "webhooks:manage" && s !== "conversions:write"} /> {T.scopes[s]}
              </label>
            ))}
          </fieldset>
          <button type="submit">{T.keys.create}</button>
        </form>
        {keys.length > 0 && (
          <ul class="list">
            {keys.map((k: { id: string; name: string; prefix: string; scopes: string[]; last_used_at: Date | null }) => (
              <li>
                <strong>{k.name}</strong> <code>yfi_{k.prefix}_…</code>
                <span class="meta">
                  {k.scopes.join(", ")} · {T.keys.lastUsed} {k.last_used_at ? k.last_used_at.toISOString().slice(0, 16).replace("T", " ") : T.keys.never}
                </span>
                <form method="post" action={`/account/keys/${k.id}/revoke`}>
                  <button type="submit" class="danger">
                    {T.keys.revoke}
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
    const T = tr(c);
    if (name.length < 1 || name.length > 100) errors.push(T.keys.errName);
    if (scopes.length === 0 || !scopes.every((s) => (USER_SCOPES as readonly string[]).includes(s)) || new Set(scopes).size !== scopes.length) {
      errors.push(T.keys.errScopes);
    }
    const [{ active }] = await sql`select count(*)::int as active from api_keys where service_id = ${u.serviceId} and revoked_at is null`;
    if (active >= MAX_KEYS) errors.push(T.keys.errMax(MAX_KEYS));
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

  // Link-in-bio: one public page per user at /@handle with chosen short links, which count clicks
  // like any other visit to them.
  async function bioForm(c: Context, u: User, values?: { handle: string; title: string; description: string; link: string[] }, errors: string[] = []) {
    const T = tr(c);
    const [page] = await sql`select * from bio_pages where user_id = ${u.id}`;
    const v = values ?? { handle: page?.handle ?? "", title: page?.title ?? "", description: page?.description ?? "", link: page?.link_ids ?? [] };
    const links: LinkRow[] = await sql`select * from links where service_id = ${u.serviceId} and disabled_at is null order by id desc limit 200`;
    return c.html(
      <Page title={T.bioPage.title} user={u} bot={telegramBot} lang={langOf(c)}>
        <h1>{T.bioPage.title}</h1>
        <p>{T.bioPage.intro}{page && <> : <a href={`/@${page.handle}`}>{`${publicOrigin}/@${page.handle}`}</a></>}.</p>
        <form method="post" action="/account/bio" class="stack card">
          {errors.length > 0 && (
            <ul class="errors">
              {errors.map((e) => (
                <li>{e}</li>
              ))}
            </ul>
          )}
          <label>
            {T.bioPage.address} <span class="meta">{publicOrigin}/@…, {T.bioPage.addressHint}</span>
            <input name="handle" required maxlength={30} value={v.handle} />
          </label>
          <label>
            {T.bioPage.heading}
            <input name="title" maxlength={100} value={v.title} />
          </label>
          <label>
            {T.bioPage.description}
            <input name="description" maxlength={300} value={v.description} />
          </label>
          <fieldset>
            <legend>{T.bioPage.links}</legend>
            {links.length === 0 && <p class="meta">{T.bioPage.createFirst}</p>}
            {links.map((l) => (
              <label class="check">
                <input type="checkbox" name="link" value={l.id} checked={v.link.includes(l.id)} /> {l.title ?? l.code}{" "}
                <span class="meta">{l.target_url}</span>
              </label>
            ))}
          </fieldset>
          <button type="submit">{T.bioPage.save}</button>
        </form>
      </Page>,
      errors.length ? 422 : 200,
    );
  }

  app.get("/account/bio", (c) => bioForm(c, c.get("user")));

  app.post("/account/bio", async (c) => {
    const u = c.get("user");
    const form = await c.req.parseBody({ all: true });
    const one = (k: string) => String([form[k] ?? ""].flat()[0] ?? "").trim();
    const values = { handle: one("handle").toLowerCase(), title: one("title"), description: one("description"), link: [form.link ?? []].flat().map(String) };
    const saved = await saveBio(sql, { userId: u.id, serviceId: u.serviceId, publicOrigin, now: now() }, values);
    if ("errors" in saved) return bioForm(c, u, values, saved.errors.map((e) => bioErrorText(e, langOf(c))));
    return c.redirect("/account/bio", 303);
  });

  app.get("/:handle{@[^/]*}", async (c) => {
    const handle = c.req.param("handle").slice(1);
    const [page] = HANDLE.test(handle)
      ? await sql`
          select b.* from bio_pages b join users u on u.id = b.user_id join services s on s.owner_user_id = u.id
          where b.handle = ${handle} and u.disabled_at is null and s.disabled_at is null`
      : [];
    if (!page) return c.notFound();
    const links: LinkRow[] = await sql`
      select * from links where id = any(${page.link_ids}) and disabled_at is null and (expires_at is null or expires_at > ${now()})
      order by id desc`;
    const title = page.title ?? `@${page.handle}`;
    return c.html(
      <Page title={title} og={{ title, description: page.description ?? undefined }}>
        <h1>{title}</h1>
        {page.description && <p>{page.description}</p>}
        <ul class="list">
          {links.map((l) => (
            <li>
              <a class="button" href={`${publicOrigin}/${l.code}`}>
                {l.title ?? new URL(l.target_url).hostname}
              </a>
            </li>
          ))}
        </ul>
      </Page>,
    );
  });

  // Connecting a Telegram account to the bot: a one-time token in a t.me deep link (ADR-0006).
  app.get("/account/telegram", async (c) => {
    const u = c.get("user");
    if (!telegramBot) return c.notFound();
    const [row] = await sql`select telegram_user_id from users where id = ${u.id}`;
    const T = tr(c);
    return c.html(
      <Page title="Telegram" user={u} bot={telegramBot} lang={langOf(c)}>
        <h1>{T.telegram.title}</h1>
        <p>
          {T.telegram.intro[0]}
          <a href={`https://t.me/${telegramBot}`}>@{telegramBot}</a>
          {T.telegram.intro[1]}
        </p>
        {row?.telegram_user_id ? (
          <>
            <p class="notice">{T.telegram.connected}</p>
            <form method="post" action="/account/telegram/disconnect">
              <button type="submit" class="secondary">
                {T.telegram.disconnect}
              </button>
            </form>
          </>
        ) : (
          <form method="post" action="/account/telegram/connect">
            <button type="submit">{T.telegram.connect}</button>
          </form>
        )}
      </Page>,
    );
  });

  app.post("/account/telegram/connect", async (c) => {
    if (!telegramBot) return c.notFound();
    const token = await issueConnectToken(sql, c.get("user").id, now());
    return c.redirect(`https://t.me/${telegramBot}?start=${token}`, 303);
  });

  app.post("/account/telegram/disconnect", async (c) => {
    await sql`update users set telegram_user_id = null where id = ${c.get("user").id}`;
    return c.redirect("/account/telegram", 303);
  });

  // OAuth connections from claude.ai, ChatGPT and other MCP clients to this user's service.
  app.get("/account/apps", async (c) => {
    const u = c.get("user");
    // Calls are logged per client and account, so a client's calls show on each of its connections.
    const grants: { id: string; client_id: string; client: string | null; scopes: string[]; created_at: Date; last_used_at: Date | null; calls: number; tools: string[] | null }[] = await sql`
      select g.id, g.client_id, cl.name as client, g.scopes, g.created_at, g.last_used_at,
             (select count(*) from mcp_calls m where m.service_id = g.service_id and m.client = g.client_id
                and m.at >= ${new Date(now().getTime() - 30 * DAY)})::int as calls,
             (select array_agg(tool order by last desc) from
                (select tool, max(at) as last from mcp_calls m where m.service_id = g.service_id and m.client = g.client_id
                 group by tool order by last desc limit 5) t) as tools
      from oauth_grants g left join oauth_clients cl on cl.client_id = g.client_id
      where g.service_id = ${u.serviceId} and g.revoked_at is null and g.refresh_expires_at > ${now()}
        and g.created_at > ${new Date(now().getTime() - 90 * DAY)}
      order by g.created_at desc`;
    const T = tr(c);
    const when = (d: Date | null) => (d ? d.toISOString().slice(0, 16).replace("T", " ") : T.apps.never);
    return c.html(
      <Page title={T.apps.title} user={u} bot={telegramBot} lang={langOf(c)}>
        <h1>{T.apps.title}</h1>
        <p>
          {T.apps.intro[0]}
          <code>{publicOrigin}/mcp</code>
          {T.apps.intro[1]}
        </p>
        {grants.length > 1 && (
          <form method="post" action="/account/apps/revoke-all">
            <button type="submit" class="danger">
              {T.apps.disconnectAll}
            </button>
          </form>
        )}
        {grants.length > 0 && (
          <ul class="list">
            {grants.map((g) => (
              <li>
                <strong>{clientLabel(g.client_id, g.client)}</strong>
                <span class="meta">
                  {g.scopes.join(", ")} · {T.apps.connected} {when(g.created_at)} · {T.apps.lastUsed} {when(g.last_used_at)}
                </span>
                <span class="meta">
                  {T.apps.calls30(g.calls)}
                  {g.tools?.length ? T.apps.latest(g.tools.join(", ")) : ""}
                </span>
                <form method="post" action={`/account/apps/${g.id}/revoke`}>
                  <button type="submit" class="danger">
                    {T.apps.revoke}
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </Page>,
    );
  });

  app.post("/account/apps/revoke-all", async (c) => {
    await sql`update oauth_grants set revoked_at = ${now()} where service_id = ${c.get("user").serviceId} and revoked_at is null`;
    return c.redirect("/account/apps", 303);
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

  app.get("/privacy", async (c) => {
    const T = tr(c).privacy;
    return c.html(
      <Page title={T.title} user={await user(c)} bot={telegramBot} lang={langOf(c)}>
        <h1>{T.h1}</h1>
        {T.sections.map(([h, text]) => (
          <>
            {h && <h2>{h}</h2>}
            <p>{text}</p>
          </>
        ))}
        <p>{T.contact(admin.email)}</p>
      </Page>,
    );
  });

  app.get("/terms", async (c) => {
    const T = tr(c).terms;
    return c.html(
      <Page title={T.title} user={await user(c)} bot={telegramBot} lang={langOf(c)}>
        <h1>{T.h1}</h1>
        {T.paragraphs.map((text) => (
          <p>{text}</p>
        ))}
        <p>{T.contact(admin.email)}</p>
      </Page>,
    );
  });

  return app;
}
