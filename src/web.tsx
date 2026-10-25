// The personal side of yoy.fyi (ADR-0004): sign in with Google, see and create your own short
// links, download QR codes, and create API keys for your own service.
import type { SQL } from "bun";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
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
import { parseCsv, toCsv } from "./csv";
import { type QrStyle, qrOptions, qrPng, qrSvg } from "./qr";
import { createRateLimiter } from "./ratelimit";
import type { UnsafeUrls } from "./safe-browsing";
import { checkTarget } from "./target-policy";
import { issueConnectToken } from "./telegram";
import { REASON_UK } from "./uk";
import { HANDLE, saveBio } from "./bio";
import { type User, clearUserSession, currentUser } from "./users";

const DAY = 86_400_000;
const MAX_KEYS = 10;
// What a person may grant their own keys. Keys are managed here, never through keys:manage.
const USER_SCOPES = ["links:read", "links:write", "analytics:read", "webhooks:manage"] as const satisfies readonly Scope[];
const SCOPE_TEXT: Record<string, string> = {
  "links:read": "Читати посилання",
  "links:write": "Створювати, змінювати й вимикати посилання",
  "analytics:read": "Читати статистику кліків",
  "webhooks:manage": "Керувати вебхуками кліків",
};

// The pages are in Ukrainian; the API and its error codes stay English (the contract).
const STATUS_UK: Record<string, string> = { active: "активне", expired: "закінчилось", disabled: "вимкнене" };
// Field names are kept in brackets, so the form and the API docs stay easy to match.
const FIELD_UK: Record<string, string> = {
  target_url: "Адреса (target_url): до 2048 символів",
  code: "Свій код (code): 1–64 символи A-Z a-z 0-9 _ -",
  title: "Назва (title): до 200 символів",
  tags: "Теги (tags): до 20 різних тегів з a-z 0-9 _ : . -",
  utm_defaults: "UTM (utm_defaults): некоректні значення",
  preview: "Прев'ю (preview): потрібна назва до 200 символів, опис до 500, картинка — адреса https",
  expires_at: "Діє до (expires_at): дата й час у майбутньому",
  pass_click_id: "pass_click_id: так або ні",
};
const CODE_UK: Record<string, string> = {
  code_reserved: "Цей код зарезервований.",
  code_taken: "Цей код уже зайнятий.",
  link_disabled: "Вимкнене посилання не можна змінити.",
  idempotency_key_reused: "Повторний запит з іншими даними.",
};

// Ukrainian messages for a createLink / updateLink error.
function errorList(r: { code: string; message: string; details?: Record<string, unknown> }): string[] {
  const fields = (r.details?.fields ?? {}) as Record<string, string>;
  if (Object.keys(fields).length) return Object.keys(fields).map((k) => FIELD_UK[k] ?? `${k}: некоректне значення`);
  if (r.code === "target_rejected") {
    const reason = String(r.details?.reason ?? "");
    const what = r.details?.field === "preview.image" ? "Адреса картинки прев'ю не дозволена" : "Адреса не дозволена (not allowed)";
    return [`${what}: ${REASON_UK[reason] ?? reason}.`];
  }
  return [CODE_UK[r.code] ?? r.message];
}

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
type Env = { Variables: { user: User } };

// `bot` is the Telegram bot's username; without a bot the Telegram link is hidden.
function Page({
  title,
  user,
  og,
  bot,
  jsonLd,
  canonical,
  children,
}: {
  title: string;
  user?: User | null;
  og?: { title: string; description?: string };
  bot?: string;
  jsonLd?: object;
  canonical?: string;
  children: Child;
}) {
  return (
    <html lang="uk">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>{title === "yoy.fyi" ? title : `${title} · yoy.fyi`}</title>
        <link rel="stylesheet" href="/static/admin.css" />
        {og && <meta property="og:title" content={og.title} />}
        {og?.description && <meta property="og:description" content={og.description} />}
        {og?.description && <meta name="description" content={og.description} />}
        {canonical && <link rel="canonical" href={canonical} />}
        {jsonLd && <script type="application/ld+json">{raw(JSON.stringify(jsonLd).replace(/</g, "\\u003c"))}</script>}
        <script src="/static/copy.js" defer></script>
      </head>
      <body>
        <header>
          <a href="/" class="brand">
            yoy.fyi
          </a>
          {user && <a href="/account/keys">API-ключі</a>}
          {user && <a href="/account/apps">Підключені застосунки</a>}
          {user && bot && <a href="/account/telegram">Telegram</a>}
          {user && <a href="/account/bio">Сторінка bio</a>}
          {user && (
            <form method="post" action="/logout">
              <button type="submit" class="link">
                Вийти
              </button>
            </form>
          )}
        </header>
        <main>{children}</main>
        <footer class="meta">
          <a href="/blog/uk">Блог</a> · <a href="/privacy">Конфіденційність</a> · <a href="/terms">Умови</a>
        </footer>
      </body>
    </html>
  );
}

const FAQ: [string, string][] = [
  ["Це безкоштовно?", "Так. Потрібен лише Google-акаунт для входу."],
  [
    "Чи можна створити коротке посилання через ChatGPT або Claude?",
    "Так. Підключіть yoy.fyi як конектор за адресою https://yoy.fyi/mcp, і асистент створюватиме справжні короткі посилання й QR-коди замість вигаданих адрес.",
  ],
  ["Скільки живе коротке посилання?", "Поки ви його не вимкнете або поки не мине термін дії, якщо ви його задали. Код вимкненого посилання не отримає ніхто інший."],
  ["Що зберігається про людей, які клікають?", "Час, сайт-джерело, UTM-мітки, браузер, пристрій і країна. IP-адреса не зберігається."],
];

const TOOL_DOCS: [string, string][] = [
  ["create_link", "створює коротке посилання"],
  ["create_links", "створює до 20 посилань за раз"],
  ["list_links", "шукає посилання за текстом і тегом"],
  ["get_link", "показує одне посилання"],
  ["update_link", "змінює адресу, назву, теги, прев'ю чи термін дії"],
  ["disable_link", "вимикає посилання"],
  ["get_qr", "повертає QR-код картинкою"],
  ["get_click_timeseries", "кліки за годинами чи днями"],
  ["get_click_breakdown", "кліки за джерелом, UTM, країною, пристроєм"],
  ["get_bio, update_bio", "сторінка link-in-bio yoy.fyi/@назва"],
  ["whoami", "до якого акаунта підключено"],
];

// Channel variants of a short link: the redirect passes these query parameters on to the target
// and records them on the click (see buildTarget), so no extra link is needed.
const CHANNELS = [
  ["Telegram", "telegram", "social"],
  ["Instagram", "instagram", "social"],
  ["Facebook", "facebook", "social"],
  ["email", "email", "email"],
] as const;

const OPTIONAL = ["title", "code", "tags", "utm_source", "utm_medium", "utm_campaign", "preview_title", "preview_description", "preview_image"] as const;

// What Telegram, Facebook and others show when the short link is shared.
function PreviewFields({ values }: { values: Record<string, string | undefined> }) {
  return (
    <fieldset>
      <legend>Прев'ю в Telegram, Facebook та інших застосунках</legend>
      <label>
        Назва прев'ю
        <input name="preview_title" maxlength={200} value={values.preview_title ?? ""} />
      </label>
      <label>
        Опис прев'ю
        <input name="preview_description" maxlength={500} value={values.preview_description ?? ""} />
      </label>
      <label>
        Адреса картинки прев'ю <span class="meta">https, від 1200×630</span>
        <input type="url" name="preview_image" value={values.preview_image ?? ""} placeholder="https://" />
      </label>
    </fieldset>
  );
}

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
        Вставте довге посилання
        <input type="url" name="target_url" required value={values.target_url ?? ""} placeholder="https://" />
      </label>
      <details open={open}>
        <summary>Більше параметрів</summary>
        <div class="stack">
          <label>
            Назва
            <input name="title" value={values.title ?? ""} maxlength={200} />
          </label>
          <label>
            Свій код <span class="meta">yoy.fyi/ваш-код</span>
            <input name="code" value={values.code ?? ""} />
          </label>
          <label>
            Теги <span class="meta">через кому</span>
            <input name="tags" value={values.tags ?? ""} />
          </label>
          {(["utm_source", "utm_medium", "utm_campaign"] as const).map((k) => (
            <label>
              {k}
              <input name={k} value={values[k] ?? ""} />
            </label>
          ))}
          <PreviewFields values={values} />
        </div>
      </details>
      <button type="submit">Скоротити</button>
    </form>
  );
}

export function webRoutes({ sql, publicOrigin, admin, now, resolveHost, unsafeUrls, telegramBot }: Deps) {
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
    if (!u) return c.req.method === "GET" ? c.redirect("/", 302) : c.text("Спершу увійдіть", 401);
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
      <Page title="Мої посилання" user={u} bot={telegramBot}>
        <h1>Мої посилання</h1>
        {created && (
          <section class="card stack created">
            <h2>Коротке посилання готове</h2>
            <div class="row">
              <input value={created.short_url} readonly aria-label="Коротке посилання" />
              <button type="button" data-copy={created.short_url}>
                Копіювати
              </button>
            </div>
            <img src={`/links/${created.id}/qr.svg`} alt={`QR-код для ${created.short_url}`} class="qr" width="160" height="160" />
            <p>
              Завантажити QR: <a href={`/links/${created.id}/qr.png`} download={`${created.code}.png`}>PNG</a> ·{" "}
              <a href={`/links/${created.id}/qr.svg`} download={`${created.code}.svg`}>SVG</a> ·{" "}
              <a href={`/links/${created.id}`}>Статистика</a>
            </p>
          </section>
        )}
        {links.length === 0 && !created && !filtered && (
          <p class="notice">
            Створіть перше коротке посилання: вставте довгу адресу нижче й отримайте коротке посилання yoy.fyi з QR-кодом і
            статистикою кліків.
          </p>
        )}
        <CreateForm values={form?.values} errors={form?.errors} />
        <p class="meta">
          <a href="/links/import">Імпорт із CSV</a>
          {links.length > 0 && (
            <>
              {" "}
              · <a href="/links/export.csv">Експорт у CSV</a>
            </>
          )}
        </p>
        {(links.length > 0 || filtered) && (
          <form method="get" action="/" class="row">
            <input type="search" name="q" value={q} placeholder="Пошук посилань" aria-label="Пошук посилань" />
            {tag && <input type="hidden" name="tag" value={tag} />}
            <button type="submit" class="secondary">
              Шукати
            </button>
          </form>
        )}
        {tags.length > 0 && (
          <p class="meta">
            Теги:{" "}
            {tags.map((t) => (
              <>
                <a href={`/?tag=${encodeURIComponent(t.tag)}`} class={t.tag === tag ? "badge active" : "badge"}>
                  {t.tag}
                </a>{" "}
              </>
            ))}
            {filtered && <a href="/">Показати всі</a>}
          </p>
        )}
        {filtered && links.length === 0 && <p class="notice">Нічого не знайдено.</p>}
        {links.length > 0 && (
          <ul class="list">
            {links.map((row) => {
              const l = toLink(row, publicOrigin, now());
              return (
                <li>
                  <a href={`/links/${l.id}`}>{l.title ?? l.code}</a>
                  <span class="meta truncate">{l.target_url}</span>
                  <span class="meta">
                    {l.short_url} · кліків за 7 днів: {row.clicks_7d}
                  </span>
                  {l.status !== "active" && <span class={`badge ${l.status}`}>{STATUS_UK[l.status]}</span>}
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
    const description =
      "Безкоштовні короткі посилання й QR-коди зі статистикою кліків. Працює на сайті, через API і прямо з ChatGPT чи Claude.";
    return c.html(
      <Page
        title="yoy.fyi"
        og={{ title: "yoy.fyi: короткі посилання й QR-коди", description }}
        canonical={`${publicOrigin}/`}
        jsonLd={{
          "@context": "https://schema.org",
          "@graph": [
            {
              "@type": "WebApplication",
              name: "yoy.fyi",
              url: `${publicOrigin}/`,
              applicationCategory: "BusinessApplication",
              operatingSystem: "Any",
              description,
              offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
            },
            {
              "@type": "FAQPage",
              mainEntity: FAQ.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })),
            },
          ],
        }}
      >
        <h1>Короткі посилання та QR-коди</h1>
        <p>{description}</p>
        {admin.google ? (
          <a class="button" href="/login/google">
            Увійти через Google
          </a>
        ) : (
          <p class="meta">Вхід зараз недоступний.</p>
        )}
        <h2>Що вміє</h2>
        <ul>
          <li>Коротке посилання yoy.fyi з власним кодом або випадковим, з назвою й тегами.</li>
          <li>QR-код для кожного посилання: PNG 1024 пікселі або SVG, свої кольори й підпис під кодом.</li>
          <li>Статистика кліків за днями, джерелами, UTM-мітками, країнами й пристроями.</li>
          <li>Готові варіанти посилання для Telegram, Instagram, Facebook і розсилки.</li>
          <li>Власне прев'ю, яке показують Telegram і Facebook, коли посилання надсилають у чат.</li>
          <li>Імпорт і експорт у CSV, сторінка link-in-bio на yoy.fyi/@ваша-назва.</li>
        </ul>
        <h2>З ChatGPT і Claude</h2>
        <p>
          Додайте <code>{publicOrigin}/mcp</code> як конектор у claude.ai чи ChatGPT і ввійдіть через Google. Тоді асистент створює справжні короткі
          посилання й QR-коди та відповідає, скільки було кліків. <a href="/docs/mcp">Покрокова інструкція</a>.
        </p>
        <h2>Питання</h2>
        {FAQ.map(([q, a]) => (
          <>
            <h3>{q}</h3>
            <p>{a}</p>
          </>
        ))}
        <p>
          <a href="/blog/uk">Блог</a> · <a href="/docs/mcp">Підключення до AI</a> · <a href="/v1/openapi.json">API</a>
        </p>
      </Page>,
    );
  });

  // How to connect yoy.fyi to AI assistants; also what an assistant reads to explain it.
  app.get("/docs/mcp", async (c) =>
    c.html(
      <Page
        title="Підключення yoy.fyi до ChatGPT, Claude та інших"
        user={await user(c)}
        bot={telegramBot}
        og={{ title: "Підключення yoy.fyi до ChatGPT, Claude та інших", description: "Покрокові інструкції для claude.ai, ChatGPT, Claude Code і Cursor." }}
        canonical={`${publicOrigin}/docs/mcp`}
      >
        <h1>Підключення yoy.fyi до AI-асистентів</h1>
        <p>
          yoy.fyi має MCP-сервер за адресою <code>{publicOrigin}/mcp</code>. Через нього асистент створює короткі посилання, показує QR-коди й
          статистику кліків. Посилання справжні й працюють одразу.
        </p>
        <h2>claude.ai</h2>
        <ol>
          <li>Налаштування, розділ Connectors, Add custom connector.</li>
          <li>
            Адреса: <code>{publicOrigin}/mcp</code>, далі Connect.
          </li>
          <li>Увійдіть через Google і на сторінці дозволів поставте галочку для створення посилань, якщо хочете, щоб Claude їх створював.</li>
          <li>У чаті ввімкніть yoy.fyi через кнопку «+».</li>
        </ol>
        <h2>ChatGPT</h2>
        <ol>
          <li>Settings, Apps & Connectors, Advanced, увімкніть Developer mode.</li>
          <li>
            Створіть конектор з адресою <code>{publicOrigin}/mcp</code>.
          </li>
          <li>Увійдіть через Google і дозвольте доступ. Доступність режиму залежить від тарифу ChatGPT.</li>
        </ol>
        <h2>Claude Code, Cursor та інші програми</h2>
        <p>
          Створіть API-ключ на сторінці <a href="/account/keys">API-ключі</a> і передайте його в заголовку. Для Claude Code:
        </p>
        <pre>
          <code>{`claude mcp add --transport http yoy-fyi ${publicOrigin}/mcp --header "Authorization: Bearer yfi_..."`}</code>
        </pre>
        <p>Для Cursor, у файлі mcp.json:</p>
        <pre>
          <code>{JSON.stringify({ mcpServers: { "yoy-fyi": { url: `${publicOrigin}/mcp`, headers: { Authorization: "Bearer yfi_..." } } } }, null, 2)}</code>
        </pre>
        <h2>Інструменти</h2>
        <ul>
          {TOOL_DOCS.map(([name, text]) => (
            <li>
              <code>{name}</code>: {text}
            </li>
          ))}
        </ul>
        <h2>Безпека</h2>
        <p>
          Асистент бачить лише ваші посилання й лише з тими дозволами, які ви дали. Усі підключення видно на сторінці{" "}
          <a href="/account/apps">Підключені застосунки</a>, там їх можна відкликати.
        </p>
      </Page>,
    ),
  );

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
    if (!limitCreate(u.id).ok) return c.text("Забагато нових посилань. Спробуйте за годину.", 429);
    const result = await createLink(sql, { ownHost, resolveHost, unsafeUrls }, u.serviceId, linkBody(values), null, "web");
    if (result.kind !== "error") return c.redirect(`/?created=${result.row.id}`, 303);
    return home(c, u, { values, errors: errorList(result) }, 422);
  });

  // CSV import: up to MAX_IMPORT rows per file, each created like a link from the form.
  const IMPORT_COLUMNS = ["target_url", "title", "code", "tags"];
  const MAX_IMPORT = 100;
  const limitImport = createRateLimiter({ perMinute: 5 / 60, burst: 5 });

  type ImportResult = { line: number; short_url?: string; error?: string };
  const importPage = (c: Context, u: User, opts: { error?: string; results?: ImportResult[] } = {}, status: 200 | 422 | 429 = 200) =>
    c.html(
      <Page title="Імпорт посилань" user={u} bot={telegramBot}>
        <h1>Імпорт посилань із CSV</h1>
        <p>
          Перший рядок — назви колонок: <code>target_url</code> (обов'язкова), <code>title</code>, <code>code</code> і{" "}
          <code>tags</code> (через кому, в лапках). До {MAX_IMPORT} посилань в одному файлі.
        </p>
        {opts.error && <p class="notice">{opts.error}</p>}
        {opts.results && (
          <ul class="list">
            {opts.results.map((r) => (
              <li>
                Рядок {r.line}:{" "}
                {r.short_url ? (
                  <>
                    <input value={r.short_url} readonly aria-label={`Коротке посилання з рядка ${r.line}`} />{" "}
                    <button type="button" data-copy={r.short_url}>
                      Копіювати
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
            CSV-файл
            <input type="file" name="file" accept=".csv,text/csv" />
          </label>
          <label>
            або вставте його сюди
            <textarea name="csv" rows={8} placeholder={"target_url,title,tags\nhttps://example.com/,Example,\"a, b\""}></textarea>
          </label>
          <button type="submit">Імпортувати</button>
        </form>
        <p>
          <a href="/links/export.csv">Завантажити всі посилання в CSV</a>
        </p>
      </Page>,
      status,
    );

  app.get("/links/import", (c) => importPage(c, c.get("user")));

  // The body limit and the rate limit both apply before the CSV is read or parsed.
  app.post("/links/import", bodyLimit({ maxSize: 256 * 1024, onError: (c) => c.text("CSV більший за 256 КБ.", 413) }), async (c) => {
    const u = c.get("user");
    if (!limitImport(u.id).ok) return importPage(c, u, { error: "Забагато імпортів. Спробуйте за годину." }, 429);
    const form = await c.req.parseBody();
    const text = form.file instanceof File && form.file.size > 0 ? await form.file.text() : String(form.csv ?? "");
    const parsed = parseCsv(text);
    if ("error" in parsed) return importPage(c, u, { error: parsed.error }, 422);
    if (parsed.length === 0) return importPage(c, u, { error: "CSV порожній." }, 422);
    const [header, ...rows] = parsed as [string[], ...string[][]];
    const columns = header.map((h) => h.trim().toLowerCase());
    const unknown = columns.filter((h) => !IMPORT_COLUMNS.includes(h));
    if (!columns.includes("target_url")) return importPage(c, u, { error: "У першому рядку має бути колонка target_url." }, 422);
    if (unknown.length) return importPage(c, u, { error: `Невідомі колонки: ${unknown.join(", ")}.` }, 422);
    if (rows.length === 0) return importPage(c, u, { error: "У CSV немає рядків після заголовка." }, 422);
    if (rows.length > MAX_IMPORT) return importPage(c, u, { error: `Не більше ${MAX_IMPORT} посилань за один імпорт.` }, 422);

    const results: ImportResult[] = [];
    for (const [i, row] of rows.entries()) {
      const values = Object.fromEntries(columns.map((k, j) => [k, (row[j] ?? "").trim()]));
      const result = await createLink(sql, { ownHost, resolveHost, unsafeUrls }, u.serviceId, linkBody(values), null, "web");
      results.push(
        result.kind === "error" ? { line: i + 2, error: errorList(result).join("; ") } : { line: i + 2, short_url: `${publicOrigin}/${result.row.code}` },
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
    const link = toLink(row, publicOrigin, now());
    // QR style from the page's own query; the image and downloads carry the same choices.
    const query = new URL(c.req.url).searchParams;
    const parsed = qrOptions(query);
    const qrError = "error" in parsed ? parsed.error : null;
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
    const [referrers, channels, countries, devices] = await Promise.all(
      (["referer_host", "utm_source", "country", "device"] as const).map((d) => breakdown(sql, scope, d, 5)),
    );
    return c.html(
      <Page title={link.title ?? link.code} user={u} bot={telegramBot}>
        <h1>{link.title ?? link.code}</h1>
        <div class="row">
          <input value={link.short_url} readonly aria-label="Коротке посилання" />
          <button type="button" data-copy={link.short_url}>
            Копіювати
          </button>
        </div>
        <p class="meta truncate">→ {link.target_url}</p>
        <details>
          <summary>Посилання для каналів</summary>
          <p class="meta">Те саме коротке посилання з UTM-мітками, щоб у статистиці було видно, звідки прийшли кліки.</p>
          <div class="stack">
            {CHANNELS.map(([name, source, medium]) => {
              const url = `${link.short_url}?utm_source=${source}&utm_medium=${medium}`;
              return (
                <div class="row">
                  <input value={url} readonly aria-label={`Коротке посилання для ${name}`} />
                  <button type="button" data-copy={url}>
                    Копіювати для {name}
                  </button>
                </div>
              );
            })}
          </div>
        </details>
        <p>
          <span class={`badge ${link.status}`}>{STATUS_UK[link.status]}</span>
          {link.tags.length > 0 && <span class="meta"> · {link.tags.join(", ")}</span>}
        </p>
        <img src={`/links/${link.id}/qr.svg${qrQuery}`} alt={`QR-код для ${link.short_url}`} class="qr" width="160" height="160" />
        <p>
          Завантажити QR:{" "}
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
          <summary>Кольори й підпис QR</summary>
          <form method="get" action={`/links/${link.id}`} class="stack card">
            {qrError && <p class="notice">{qrError}</p>}
            <div class="row">
              <label>
                Код <input type="color" name="fg" value={style.fg} />
              </label>
              <label>
                Фон <input type="color" name="bg" value={style.bg} />
              </label>
            </div>
            <label>
              Підпис під кодом <span class="meta">лише в SVG, до 40 символів</span>
              <input name="caption" maxlength={40} value={style.caption ?? ""} placeholder="Скануй мене" />
            </label>
            <button type="submit" class="secondary">
              Застосувати
            </button>
          </form>
        </details>
        <h2>
          Кліків за 30 днів: {daily.totals.clicks} <span class="meta">(відвідувачів щонайбільше {daily.totals.uniques_upper_bound})</span>
        </h2>
        <BarChart points={daily.points} label={(t) => t.toISOString().slice(0, 10)} />
        <p class="meta">
          <a href={`/links/${link.id}/clicks.csv`}>Завантажити кліки в CSV</a>
        </p>
        <div class="rankings">
          <Ranking title="Джерела" items={referrers!.items} total={referrers!.total_clicks} />
          <Ranking title="Канали (utm_source)" items={channels!.items} total={channels!.total_clicks} />
          <Ranking title="Країни" items={countries!.items} total={countries!.total_clicks} />
          <Ranking title="Пристрої" items={devices!.items} total={devices!.total_clicks} />
        </div>
        {link.status !== "disabled" && (
          <details open={!!form}>
            <summary>Редагувати посилання</summary>
            <form method="post" action={`/links/${link.id}`} class="stack card">
              {form && form.errors.length > 0 && (
                <ul class="errors">
                  {form.errors.map((e) => (
                    <li>{e}</li>
                  ))}
                </ul>
              )}
              <label>
                Куди веде
                <input type="url" name="target_url" required value={values.target_url} />
              </label>
              <label>
                Назва
                <input name="title" maxlength={200} value={values.title} />
              </label>
              <label>
                Теги <span class="meta">через кому</span>
                <input name="tags" value={values.tags} />
              </label>
              <label>
                Діє до <span class="meta">UTC, порожньо — безстроково</span>
                <input type="datetime-local" name="expires_at" value={values.expires_at} />
              </label>
              <PreviewFields values={values} />
              <button type="submit">Зберегти</button>
            </form>
          </details>
        )}
        {form && link.status === "disabled" && <p class="notice">{form.errors.join(" ")}</p>}
        {link.status !== "disabled" ? (
          <form method="post" action={`/links/${link.id}/disable`}>
            <button type="submit" class="danger">
              Вимкнути посилання
            </button>
          </form>
        ) : row.disabled_by === "owner" ? (
          <form method="post" action={`/links/${link.id}/enable`}>
            <button type="submit">Увімкнути посилання</button>
          </form>
        ) : (
          <p class="meta">Це посилання вимкнув yoy.fyi. Якщо це помилка, напишіть на {admin.email}.</p>
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

  // Only what the owner disabled can be re-enabled here; admin and Safe Browsing takedowns
  // stay down. The target is checked again in case it changed since.
  app.post("/links/:id/enable", async (c) => {
    const u = c.get("user");
    const row = await ownLink(u, c.req.param("id"));
    if (!row) return c.notFound();
    if (row.disabled_at) {
      const refuse = (why: string) => linkPage(c, u, row, { values: {}, errors: [`Це посилання не можна увімкнути: ${why}.`] }, 422);
      if (row.disabled_by !== "owner") return refuse("його вимкнув yoy.fyi");
      const rejection = await checkTarget(row.target_url, { ownHost, resolve: resolveHost, unsafeUrls });
      if (rejection) return refuse(`адреса не дозволена: ${REASON_UK[rejection] ?? rejection}`);
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
    if ("error" in style) return c.text(style.error, 400);
    return c.body(await qrSvg(`${publicOrigin}/${row.code}`, style), 200, { "Content-Type": "image/svg+xml" });
  });

  app.get("/links/:id/qr.png", async (c) => {
    const row = await ownLink(c.get("user"), c.req.param("id"));
    if (!row) return c.notFound();
    const style = qrOptions(new URL(c.req.url).searchParams);
    if ("error" in style) return c.text(style.error, 400);
    if (style.caption) return c.text("Підпис доступний лише в SVG", 400);
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
    const keys = await sql`
      select id, name, prefix, scopes, created_at, last_used_at from api_keys
      where service_id = ${u.serviceId} and revoked_at is null order by created_at desc`;
    return c.html(
      <Page title="API-ключі" user={u} bot={telegramBot}>
        <h1>API-ключі</h1>
        <p>
          Ключ працює з <a href="/v1/openapi.json">API yoy.fyi</a> або MCP-сервером <code>{publicOrigin}/mcp</code>. Ключі діють
          лише на ваші посилання.
        </p>
        {opts.secret && (
          <p class="notice">
            Ваш новий ключ, показуємо лише зараз: <code>{opts.secret}</code>
          </p>
        )}
        <form method="post" action="/account/keys" class="stack card">
          <h2>Новий ключ</h2>
          {opts.errors && opts.errors.length > 0 && (
            <ul class="errors">
              {opts.errors.map((e) => (
                <li>{e}</li>
              ))}
            </ul>
          )}
          <label>
            Назва
            <input name="name" required maxlength={100} placeholder="мій застосунок" />
          </label>
          <fieldset>
            <legend>Дозволи</legend>
            {USER_SCOPES.map((s) => (
              <label class="check">
                <input type="checkbox" name="scope" value={s} checked={s !== "webhooks:manage"} /> {SCOPE_TEXT[s]}
              </label>
            ))}
          </fieldset>
          <button type="submit">Створити ключ</button>
        </form>
        {keys.length > 0 && (
          <ul class="list">
            {keys.map((k: { id: string; name: string; prefix: string; scopes: string[]; last_used_at: Date | null }) => (
              <li>
                <strong>{k.name}</strong> <code>yfi_{k.prefix}_…</code>
                <span class="meta">
                  {k.scopes.join(", ")} · останнє використання {k.last_used_at ? k.last_used_at.toISOString().slice(0, 16).replace("T", " ") : "ніколи"}
                </span>
                <form method="post" action={`/account/keys/${k.id}/revoke`}>
                  <button type="submit" class="danger">
                    Відкликати
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
    if (name.length < 1 || name.length > 100) errors.push("Назва: 1–100 символів.");
    if (scopes.length === 0 || !scopes.every((s) => (USER_SCOPES as readonly string[]).includes(s)) || new Set(scopes).size !== scopes.length) {
      errors.push("Оберіть хоча б один дозвіл зі списку.");
    }
    const [{ active }] = await sql`select count(*)::int as active from api_keys where service_id = ${u.serviceId} and revoked_at is null`;
    if (active >= MAX_KEYS) errors.push(`Можна мати не більше ${MAX_KEYS} активних ключів. Спершу відкличте один.`);
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
    const [page] = await sql`select * from bio_pages where user_id = ${u.id}`;
    const v = values ?? { handle: page?.handle ?? "", title: page?.title ?? "", description: page?.description ?? "", link: page?.link_ids ?? [] };
    const links: LinkRow[] = await sql`select * from links where service_id = ${u.serviceId} and disabled_at is null order by id desc limit 200`;
    return c.html(
      <Page title="Сторінка bio" user={u} bot={telegramBot}>
        <h1>Сторінка bio</h1>
        <p>Одна сторінка з вашими посиланнями для bio в Instagram чи Telegram{page && <> : <a href={`/@${page.handle}`}>{`${publicOrigin}/@${page.handle}`}</a></>}.</p>
        <form method="post" action="/account/bio" class="stack card">
          {errors.length > 0 && (
            <ul class="errors">
              {errors.map((e) => (
                <li>{e}</li>
              ))}
            </ul>
          )}
          <label>
            Адреса <span class="meta">{publicOrigin}/@…, 3–30 символів a-z 0-9 _ . -</span>
            <input name="handle" required maxlength={30} value={v.handle} />
          </label>
          <label>
            Заголовок
            <input name="title" maxlength={100} value={v.title} />
          </label>
          <label>
            Опис
            <input name="description" maxlength={300} value={v.description} />
          </label>
          <fieldset>
            <legend>Посилання, нові спершу</legend>
            {links.length === 0 && <p class="meta">Спершу створіть коротке посилання.</p>}
            {links.map((l) => (
              <label class="check">
                <input type="checkbox" name="link" value={l.id} checked={v.link.includes(l.id)} /> {l.title ?? l.code}{" "}
                <span class="meta">{l.target_url}</span>
              </label>
            ))}
          </fieldset>
          <button type="submit">Зберегти</button>
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
    if ("errors" in saved) return bioForm(c, u, values, saved.errors);
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
    return c.html(
      <Page title="Telegram" user={u} bot={telegramBot}>
        <h1>Telegram-бот</h1>
        <p>
          Надішліть довге посилання боту <a href={`https://t.me/${telegramBot}`}>@{telegramBot}</a> й отримайте коротке посилання yoy.fyi та його QR.
        </p>
        {row?.telegram_user_id ? (
          <>
            <p class="notice">Підключено.</p>
            <form method="post" action="/account/telegram/disconnect">
              <button type="submit" class="secondary">
                Відключити
              </button>
            </form>
          </>
        ) : (
          <form method="post" action="/account/telegram/connect">
            <button type="submit">Підключити Telegram</button>
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
    const grants: { id: string; client: string; scopes: string[]; created_at: Date; last_used_at: Date | null }[] = await sql`
      select g.id, coalesce(cl.name, g.client_id) as client, g.scopes, g.created_at, g.last_used_at
      from oauth_grants g left join oauth_clients cl on cl.client_id = g.client_id
      where g.service_id = ${u.serviceId} and g.revoked_at is null and g.refresh_expires_at > ${now()}
      order by g.created_at desc`;
    const when = (d: Date | null) => (d ? d.toISOString().slice(0, 16).replace("T", " ") : "ніколи");
    return c.html(
      <Page title="Підключені застосунки" user={u} bot={telegramBot}>
        <h1>Підключені застосунки</h1>
        <p>
          Щоб працювати з посиланнями з чату, додайте <code>{publicOrigin}/mcp</code> як конектор у claude.ai чи ChatGPT і ввійдіть
          тим самим Google-акаунтом.
        </p>
        {grants.length > 0 && (
          <ul class="list">
            {grants.map((g) => (
              <li>
                <strong>{g.client}</strong>
                <span class="meta">
                  {g.scopes.join(", ")} · підключено {when(g.created_at)} · останнє використання {when(g.last_used_at)}
                </span>
                <form method="post" action={`/account/apps/${g.id}/revoke`}>
                  <button type="submit" class="danger">
                    Відкликати
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
      <Page title="Конфіденційність" user={await user(c)} bot={telegramBot}>
        <h1>Конфіденційність на yoy.fyi</h1>
        <p>yoy.fyi створює короткі посилання й рахує кліки по них. Тут написано, що він зберігає і як довго.</p>
        <h2>Ваш акаунт</h2>
        <p>
          Коли ви входите через Google, yoy.fyi отримує й зберігає id вашого Google-акаунта, адресу пошти та ім'я. Вони потрібні лише для
          входу й щоб показувати, чиї посилання чиї. Нічого іншого з вашого Google-акаунта yoy.fyi не читає.
        </p>
        <h2>Кліки по коротких посиланнях</h2>
        <p>
          Для кожного кліку yoy.fyi зберігає час, сайт, з якого прийшли, UTM-мітки й рекламні параметри, браузер, операційну систему й
          тип пристрою, країну (визначену за IP-адресою, яка не зберігається) і хеш, що змінюється щодня, для підрахунку унікальних
          відвідувачів. Окремі кліки зберігаються 13 місяців, після цього лишаються лише денні підсумки.
        </p>
        <h2>Кому це видно</h2>
        <p>
          Статистику посилання бачить його власник. Якщо власник налаштував вебхук, туди надсилаються описані вище дані кліку (ніколи не
          IP-адреса). yoy.fyi нічого нікому не продає.
        </p>
        <h2>Контакти</h2>
        <p>Питання чи запити на видалення: {admin.email}.</p>
      </Page>,
    ),
  );

  app.get("/terms", async (c) =>
    c.html(
      <Page title="Умови" user={await user(c)} bot={telegramBot}>
        <h1>Умови користування yoy.fyi</h1>
        <p>yoy.fyi надається як є, безкоштовно, без жодних гарантій доступності.</p>
        <p>
          Не створюйте посилань на фішинг, шкідливі програми, шахрайство, спам чи будь-що незаконне. Посилання й акаунти, що порушують
          це правило, вимикаються без попередження.
        </p>
        <p>Короткі посилання можуть бути вимкнені будь-коли; код вимкненого посилання ніколи не передається іншим.</p>
        <p>Контакти: {admin.email}.</p>
      </Page>,
    ),
  );

  return app;
}
