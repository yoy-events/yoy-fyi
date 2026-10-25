// The blog and the files search engines and AI crawlers read: robots.txt, sitemap.xml, llms.txt.
// Posts are Markdown in content/blog/<slug>/<lang>.md, reviewed and published through PRs.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { raw } from "hono/html";
import type { Child } from "hono/jsx";
import { marked } from "marked";

export const LANGS = ["uk", "en", "es", "fr"] as const;
export type Lang = (typeof LANGS)[number];

const UI: Record<Lang, { name: string; blog: string; all: string; read: string; intro: string }> = {
  uk: { name: "Українська", blog: "Блог yoy.fyi", all: "Усі статті", read: "Читати", intro: "Короткі посилання, QR-коди й робота з ними через ChatGPT та Claude." },
  en: { name: "English", blog: "yoy.fyi blog", all: "All posts", read: "Read", intro: "Short links, QR codes, and how to make them from ChatGPT and Claude." },
  es: { name: "Español", blog: "Blog de yoy.fyi", all: "Todos los artículos", read: "Leer", intro: "Enlaces cortos, códigos QR y cómo crearlos desde ChatGPT y Claude." },
  fr: { name: "Français", blog: "Blog yoy.fyi", all: "Tous les articles", read: "Lire", intro: "Liens courts, codes QR et comment les créer depuis ChatGPT et Claude." },
};

export type Post = { slug: string; lang: Lang; title: string; description: string; date: string; html: string };

// Front matter is `key: value` lines between two `---` lines.
function parse(text: string): { meta: Record<string, string>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!m) throw new Error("missing front matter");
  const meta = Object.fromEntries(
    m[1]!.split("\n").map((line) => {
      const i = line.indexOf(":");
      return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
    }),
  );
  return { meta, body: m[2]! };
}

// Every post must exist in every language with a title, description and date.
export function loadPosts(dir: string): Post[] {
  const posts: Post[] = [];
  for (const slug of readdirSync(dir).sort()) {
    if (!/^[a-z0-9-]+$/.test(slug)) continue;
    for (const lang of LANGS) {
      const { meta, body } = parse(readFileSync(join(dir, slug, `${lang}.md`), "utf8"));
      if (!meta.title || !meta.description || !/^\d{4}-\d{2}-\d{2}$/.test(meta.date ?? "")) throw new Error(`${slug}/${lang}.md: title, description and date are required`);
      posts.push({ slug, lang, title: meta.title, description: meta.description, date: meta.date!, html: marked.parse(body, { async: false }) });
    }
  }
  return posts.sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));
}

const isLang = (s: string): s is Lang => (LANGS as readonly string[]).includes(s);

function Shell(props: { lang: Lang; title: string; description: string; canonical: string; alternates: Record<string, string>; jsonLd?: object; children: Child }) {
  return (
    <html lang={props.lang}>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>{props.title}</title>
        <meta name="description" content={props.description} />
        <link rel="canonical" href={props.canonical} />
        {Object.entries(props.alternates).map(([l, href]) => (
          <link rel="alternate" hreflang={l} href={href} />
        ))}
        <meta property="og:title" content={props.title} />
        <meta property="og:description" content={props.description} />
        <meta property="og:url" content={props.canonical} />
        <meta property="og:type" content="article" />
        <link rel="stylesheet" href="/static/admin.css" />
        <link rel="alternate" type="application/rss+xml" href={`/blog/${props.lang}/rss.xml`} />
        {props.jsonLd && <script type="application/ld+json">{raw(JSON.stringify(props.jsonLd).replace(/</g, "\\u003c"))}</script>}
      </head>
      <body>
        <header>
          <a href="/" class="brand">
            yoy.fyi
          </a>
          <a href={`/blog/${props.lang}`}>{UI[props.lang].blog}</a>
          {Object.entries(props.alternates)
            .filter(([l]) => l !== props.lang && isLang(l))
            .map(([l, href]) => (
              <a href={href} hreflang={l}>
                {UI[l as Lang].name}
              </a>
            ))}
        </header>
        <main>{props.children}</main>
        <footer class="meta">
          <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · <a href="/llms.txt">llms.txt</a>
        </footer>
      </body>
    </html>
  );
}

const xml = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[ch]!);

export function blogRoutes({ publicOrigin, posts, indexable = true }: { publicOrigin: string; posts: Post[]; indexable?: boolean }) {
  const app = new Hono();
  const url = (path: string) => `${publicOrigin}${path}`;
  const indexAlternates = Object.fromEntries([...LANGS.map((l) => [l, url(`/blog/${l}`)]), ["x-default", url("/blog/en")]]);
  const postAlternates = (slug: string) =>
    Object.fromEntries([...LANGS.map((l) => [l, url(`/blog/${l}/${slug}`)]), ["x-default", url(`/blog/en/${slug}`)]]);
  const cache = { "Cache-Control": "public, max-age=600" };

  app.get("/blog", (c) => {
    const wanted = (c.req.header("accept-language") ?? "").toLowerCase();
    const lang = LANGS.find((l) => wanted.startsWith(l)) ?? "uk";
    return c.redirect(`/blog/${lang}`, 302);
  });

  app.get("/blog/:lang", (c) => {
    const lang = c.req.param("lang");
    if (!isLang(lang)) return c.notFound();
    const list = posts.filter((p) => p.lang === lang);
    return c.html(
      <Shell lang={lang} title={UI[lang].blog} description={UI[lang].intro} canonical={url(`/blog/${lang}`)} alternates={indexAlternates}>
        <h1>{UI[lang].blog}</h1>
        <p>{UI[lang].intro}</p>
        <ul class="list">
          {list.map((p) => (
            <li>
              <a href={`/blog/${lang}/${p.slug}`}>{p.title}</a>
              <span class="meta">
                {p.date} · {p.description}
              </span>
            </li>
          ))}
        </ul>
      </Shell>,
      200,
      cache,
    );
  });

  app.get("/blog/:lang/rss.xml", (c) => {
    const lang = c.req.param("lang");
    if (!isLang(lang)) return c.notFound();
    const items = posts
      .filter((p) => p.lang === lang)
      .map(
        (p) =>
          `<item><title>${xml(p.title)}</title><link>${url(`/blog/${lang}/${p.slug}`)}</link><guid>${url(`/blog/${lang}/${p.slug}`)}</guid><pubDate>${new Date(`${p.date}T09:00:00Z`).toUTCString()}</pubDate><description>${xml(p.description)}</description></item>`,
      )
      .join("");
    return c.body(
      `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${xml(UI[lang].blog)}</title><link>${url(`/blog/${lang}`)}</link><description>${xml(UI[lang].intro)}</description><language>${lang}</language>${items}</channel></rss>`,
      200,
      { "Content-Type": "application/rss+xml; charset=utf-8", ...cache },
    );
  });

  app.get("/blog/:lang/:slug", (c) => {
    const lang = c.req.param("lang");
    const post = isLang(lang) ? posts.find((p) => p.lang === lang && p.slug === c.req.param("slug")) : undefined;
    if (!post) return c.notFound();
    const canonical = url(`/blog/${lang}/${post.slug}`);
    return c.html(
      <Shell
        lang={post.lang}
        title={`${post.title} · yoy.fyi`}
        description={post.description}
        canonical={canonical}
        alternates={postAlternates(post.slug)}
        jsonLd={{
          "@context": "https://schema.org",
          "@type": "BlogPosting",
          headline: post.title,
          description: post.description,
          datePublished: post.date,
          inLanguage: post.lang,
          mainEntityOfPage: canonical,
          author: { "@type": "Organization", name: "yoy.fyi", url: publicOrigin },
          publisher: { "@type": "Organization", name: "yoy.fyi", url: publicOrigin },
        }}
      >
        <article>
          <p class="meta">{post.date}</p>
          {raw(post.html)}
        </article>
        <p>
          <a href={`/blog/${lang}`}>← {UI[post.lang].all}</a>
        </p>
      </Shell>,
      200,
      cache,
    );
  });

  // Private areas are kept out of search; short links themselves are left crawlable, since a
  // preview bot following one is how a shared link gets its card.
  app.get("/robots.txt", (c) =>
    c.text(
      indexable
        ? ["User-agent: *", "Allow: /", "Disallow: /admin", "Disallow: /account", "Disallow: /links", "Disallow: /oauth", "Disallow: /v1/", "", `Sitemap: ${url("/sitemap.xml")}`, ""].join("\n")
        : "User-agent: *\nDisallow: /\n",
      200,
      cache,
    ),
  );

  app.get("/sitemap.xml", (c) => {
    const entry = (loc: string, alternates?: Record<string, string>, lastmod?: string) =>
      `<url><loc>${loc}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ""}${Object.entries(alternates ?? {})
        .map(([l, href]) => `<xhtml:link rel="alternate" hreflang="${l}" href="${href}"/>`)
        .join("")}</url>`;
    const entries = [
      entry(url("/")),
      entry(url("/privacy")),
      entry(url("/terms")),
      ...LANGS.map((l) => entry(url(`/blog/${l}`), indexAlternates)),
      ...posts.map((p) => entry(url(`/blog/${p.lang}/${p.slug}`), postAlternates(p.slug), p.date)),
    ];
    return c.body(
      `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">${entries.join("")}</urlset>`,
      200,
      { "Content-Type": "application/xml; charset=utf-8", ...cache },
    );
  });

  // https://llmstxt.org: a plain summary for AI agents, in English.
  app.get("/llms.txt", (c) =>
    c.text(
      [
        "# yoy.fyi",
        "",
        "> Free short links and QR codes with click analytics (by day, source, country and device). Works from the website, a REST API, and from ChatGPT or Claude through a remote MCP server with OAuth sign-in (Google account).",
        "",
        "## Use it from an AI assistant",
        "",
        `- MCP server (Streamable HTTP, OAuth 2.1): ${url("/mcp")}`,
        "- In claude.ai or ChatGPT, add it as a custom connector with that URL, then sign in with Google.",
        "- Tools: create_link, update_link, disable_link, list_links, get_link, get_click_timeseries, get_click_breakdown, whoami.",
        "",
        "## API",
        "",
        `- OpenAPI contract: ${url("/v1/openapi.json")}`,
        "",
        "## Blog (English)",
        "",
        ...posts.filter((p) => p.lang === "en").map((p) => `- [${p.title}](${url(`/blog/en/${p.slug}`)}): ${p.description}`),
        "",
        "## Other languages",
        "",
        ...LANGS.filter((l) => l !== "en").map((l) => `- ${UI[l].name}: ${url(`/blog/${l}`)}`),
        "",
      ].join("\n"),
      200,
      cache,
    ),
  );

  return app;
}
