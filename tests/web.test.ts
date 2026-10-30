// The personal home page and account pages (ADR-0004): valid, invalid and empty input.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { reset, testDb } from "./helpers";
import { ORIGIN, webApp } from "./web-helpers";

let sql: SQL;
let now: Date;
let web: ReturnType<typeof webApp>;
let mail: typeof web.mail;
let app: typeof web.app;

beforeAll(async () => {
  sql = await testDb();
});

beforeEach(async () => {
  await reset(sql);
  now = new Date("2026-10-24T12:00:00Z");
  web = webApp(sql, () => now);
  ({ mail, app } = web);
});

const get = (path: string, cookie = "") => web.get(path, cookie);
const post = (path: string, fields: Record<string, string | string[]>, cookie: string, origin = ORIGIN) => web.post(path, fields, cookie, origin);
const signIn = (sub?: string, email?: string, extra?: Record<string, unknown>) => web.signIn(sub, email, extra);

async function createVia(cookie: string, fields: Record<string, string>) {
  const res = await post("/links", fields, cookie);
  const location = res.headers.get("location");
  return { res, id: location ? new URL(location, ORIGIN).searchParams.get("created") : null };
}

describe("signing in", () => {
  test("signed out, / describes yoy.fyi and offers Google sign-in", async () => {
    const res = await get("/");
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('href="/login/google"');
    expect(html).not.toContain('action="/links"');
  });

  test("the first sign-in creates the user and a personal service; the next one reuses them", async () => {
    const first = await signIn();
    expect(first.res.status).toBe(303);
    expect(first.res.headers.get("location")).toBe("/");
    await signIn();

    const users = await sql`select email, name from users`;
    const services = await sql`select slug from services where owner_user_id is not null`;
    expect(users).toEqual([{ email: "ann@example.com", name: "Ann" }]);
    expect(services).toHaveLength(1);
    expect(services[0].slug).toMatch(/^u-[a-z0-9]{10}$/);
  });

  test("Google sign-in for users asks for no login hint", async () => {
    const to = new URL((await get("/login/google")).headers.get("location")!);
    expect(to.searchParams.get("login_hint")).toBeNull();
    expect(to.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/admin/login/google/callback`);
  });

  test("an unverified Google email cannot sign in", async () => {
    const { res, cookie } = await signIn("g2", "bob@example.com", { email_verified: false });
    expect(res.status).toBe(400);
    expect(cookie).not.toContain("yfi_user");
  });

  test("a blocked user cannot sign in", async () => {
    await signIn();
    await sql`update users set disabled_at = now()`;
    expect((await signIn()).res.status).toBe(400);
  });

  test("a user session is not an admin session", async () => {
    const { cookie } = await signIn("g3", mail.admin.email);
    expect((await get("/admin", cookie)).headers.get("location")).toBe("/admin/login");
  });

  test("sign out ends the session", async () => {
    const { cookie } = await signIn();
    const out = await post("/logout", {}, cookie);
    expect(out.status).toBe(303);
    expect(out.headers.getSetCookie().some((c) => /^__Host-yfi_user=;/.test(c))).toBe(true);
  });
});

describe("home page", () => {
  test("with no links: an empty state and the create form", async () => {
    const { cookie } = await signIn();
    const html = await (await get("/", cookie)).text();
    expect(html).toContain("Створіть перше коротке посилання");
    expect(html).toContain('action="/links"');
  });

  test("lists only the signed-in user's links", async () => {
    const ann = (await signIn("ga", "ann@example.com")).cookie;
    const bob = (await signIn("gb", "bob@example.com")).cookie;
    await createVia(ann, { target_url: "https://example.com/ann" });
    await createVia(bob, { target_url: "https://example.com/bob" });

    const html = await (await get("/", ann)).text();
    expect(html).toContain("https://example.com/ann");
    expect(html).not.toContain("https://example.com/bob");
  });
});

describe("after creating", () => {
  test("returns to / with a card: short link, copy button, QR and downloads", async () => {
    const { cookie } = await signIn();
    const { res, id } = await createVia(cookie, { target_url: "https://example.com/a" });
    expect(res.headers.get("location")).toBe(`/?created=${id}`);

    const html = await (await get(`/?created=${id}`, cookie)).text();
    const [{ code }] = await sql`select code from links where id = ${id}`;
    const short = `${ORIGIN}/${code}`;
    expect(html).toContain(`value="${short}" readonly`);
    expect(html).toContain(`data-copy="${short}"`);
    expect(html).toContain(`src="/links/${id}/qr.svg"`);
    expect(html).toContain(`href="/links/${id}/qr.png"`);
    expect(html).toContain(`href="/links/${id}"`);
    expect(html).toContain('src="/static/copy.js"');
  });

  test.each([
    ["another user's link", "other"],
    ["a malformed id", "not-a-uuid"],
    ["an empty id", ""],
  ])("with %s there is no card", async (_, which) => {
    const ann = (await signIn("ga", "ann@example.com")).cookie;
    const bob = (await signIn("gb", "bob@example.com")).cookie;
    const { id } = await createVia(bob, { target_url: "https://example.com/b" });
    const created = which === "other" ? id : which;
    const res = await get(`/?created=${created}`, ann);
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("data-copy=");
  });

  test("the link page has a copy button too", async () => {
    const { cookie } = await signIn();
    const { id } = await createVia(cookie, { target_url: "https://example.com/a" });
    expect(await (await get(`/links/${id}`, cookie)).text()).toContain("data-copy=");
  });

  test("copy.js is served from our origin and allowed by the CSP, with no inline script", async () => {
    const js = await get("/static/copy.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toStartWith("text/javascript");
    const page = await get("/");
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(await page.text()).not.toMatch(/<script>(?!<\/script>)/);
  });

  // Runs copy.js against a minimal document: one click on `label`, then its timer.
  async function clickCopy(label: string, body: Record<string, string>, clipboard: () => Promise<void>) {
    const handlers: Record<string, (e: unknown) => Promise<void> | void> = {};
    const timers: (() => void)[] = [];
    const document = {
      body: { dataset: body },
      addEventListener: (type: string, fn: (e: unknown) => void) => {
        handlers[type] = fn;
      },
    };
    const button = { textContent: label, dataset: { copy: "https://yoy.fyi/gig" } as Record<string, string>, closest: () => button };
    new Function("document", "navigator", "setTimeout", await Bun.file(new URL("../src/admin/copy.js", import.meta.url).pathname).text())(document, { clipboard: { writeText: clipboard } }, (fn: () => void) => timers.push(fn));
    await handlers.click!({ target: button });
    const shown = button.textContent;
    for (const fn of timers) fn();
    return { shown, after: button.textContent };
  }

  test("the copy button says Copied in the page's language and gets its own label back", async () => {
    const html = await (await get("/", `${(await signIn()).cookie}; yfi_lang=es`)).text();
    const body = /<body data-copied="([^"]+)" data-copy-failed="([^"]+)">/.exec(html)!;
    expect([body[1], body[2]]).toEqual(["Copiado", "Selecciona y copia"]);

    const ok = await clickCopy("Copiar para Telegram", { copied: "Copiado", copyFailed: "Selecciona y copia" }, async () => {});
    expect(ok).toEqual({ shown: "Copiado", after: "Copiar para Telegram" });
    const failed = await clickCopy("Copiar", { copied: "Copiado", copyFailed: "Selecciona y copia" }, async () => Promise.reject(new Error("denied")));
    expect(failed).toEqual({ shown: "Selecciona y copia", after: "Copiar" });
  });

  test("without translations (the admin pages) the copy button falls back to English", async () => {
    expect(await clickCopy("Copy", {}, async () => {})).toEqual({ shown: "Copied", after: "Copy" });
  });
});

describe("create form", () => {
  test("shows only the long URL; everything else waits under More options", async () => {
    const { cookie } = await signIn();
    const html = await (await get("/", cookie)).text();
    const [visible, hidden] = html.split("<details");

    expect(visible).toContain('name="target_url"');
    expect(hidden).toContain("Більше параметрів");
    for (const name of ["title", "code", "tags", "utm_source", "utm_medium", "utm_campaign"]) {
      expect(visible).not.toContain(`name="${name}"`);
      expect(hidden).toContain(`name="${name}"`);
    }
    expect(html).not.toMatch(/<details[^>]*open/);
  });

  test("after an error in an optional field, More options stays open with the values", async () => {
    const { cookie } = await signIn();
    const html = await (await post("/links", { target_url: "https://example.com/", code: "no spaces" }, cookie)).text();
    expect(html).toMatch(/<details[^>]*open/);
    expect(html).toContain('value="no spaces"');
  });
});

describe("POST /links", () => {
  test("valid: creates a link in the user's service, marked web, and opens it", async () => {
    const { cookie } = await signIn();
    const { res, id } = await createVia(cookie, { target_url: "https://example.com/a", title: "A", tags: "x, y" });

    expect(res.status).toBe(303);
    const [row] = await sql`select l.created_via, l.title, l.tags, s.owner_user_id is not null as owned from links l join services s on s.id = l.service_id where l.id = ${id}`;
    expect(row).toEqual({ created_via: "web", title: "A", tags: ["x", "y"], owned: true });
  });

  test.each([
    ["an empty body", {}],
    ["an empty target", { target_url: "" }],
    ["a non-http target", { target_url: "ftp://example.com/" }],
    ["a private target", { target_url: "http://127.0.0.1/" }],
    ["a bad custom code", { target_url: "https://example.com/", code: "no spaces" }],
    ["a reserved code", { target_url: "https://example.com/", code: "account" }],
  ])("%s shows the form again with an error and creates nothing", async (_, fields) => {
    const { cookie } = await signIn();
    const res = await post("/links", fields, cookie);
    expect(res.status).toBe(422);
    expect(await res.text()).toContain('class="errors"');
    const [{ count }] = await sql`select count(*)::int as count from links`;
    expect(count).toBe(0);
  });

  test("needs a session and our own Origin", async () => {
    const { cookie } = await signIn();
    expect((await post("/links", { target_url: "https://example.com/" }, "")).status).toBe(401);
    expect((await post("/links", { target_url: "https://example.com/" }, cookie, "https://evil.example")).status).toBe(403);
  });

  test("allows 20 links an hour per user", async () => {
    const { cookie } = await signIn();
    const statuses = [];
    for (let i = 0; i < 21; i++) statuses.push((await post("/links", { target_url: `https://example.com/${i}` }, cookie)).status);
    expect(statuses.slice(0, 20).every((s) => s === 303)).toBe(true);
    expect(statuses[20]).toBe(429);
  });
});

describe("link page", () => {
  test("shows the short URL, QR codes and clicks of the user's own link", async () => {
    const { cookie } = await signIn();
    const { id } = await createVia(cookie, { target_url: "https://example.com/a" });
    const html = await (await get(`/links/${id}`, cookie)).text();
    const [{ code }] = await sql`select code from links where id = ${id}`;

    expect(html).toContain(`${ORIGIN}/${code}`);
    expect(html).toContain(`/links/${id}/qr.svg`);
    expect(html).toContain(`/links/${id}/qr.png`);
    expect((await get(`/links/${id}/qr.svg`, cookie)).headers.get("content-type")).toStartWith("image/svg+xml");
    expect((await get(`/links/${id}/qr.png`, cookie)).headers.get("content-type")).toBe("image/png");
  });

  test("another user's link, a malformed id and no session all hide it", async () => {
    const ann = (await signIn("ga", "ann@example.com")).cookie;
    const bob = (await signIn("gb", "bob@example.com")).cookie;
    const { id } = await createVia(ann, { target_url: "https://example.com/a" });

    expect((await get(`/links/${id}`, bob)).status).toBe(404);
    expect((await get(`/links/${id}/qr.svg`, bob)).status).toBe(404);
    expect((await post(`/links/${id}/disable`, {}, bob)).status).toBe(404);
    expect((await get("/links/not-a-uuid", ann)).status).toBe(404);
    expect((await get(`/links/${id}`)).headers.get("location")).toBe("/");
  });

  test.each([
    ["uk", "Найбільше кліків: 0", "Кліків немає."],
    ["en", "Peak 0 clicks", "No clicks."],
    ["es", "Máximo: 0 clics", "Sin clics."],
    ["fr", "Pic : 0 clics", "Aucun clic."],
  ])("the chart and rankings speak %s and show the real peak", async (lang, peak, empty) => {
    const { cookie } = await signIn();
    const { id } = await createVia(cookie, { target_url: "https://example.com/a" });
    const html = await (await get(`/links/${id}`, `${cookie}; yfi_lang=${lang}`)).text();
    expect(html).toContain(`<figcaption class="meta">${peak}</figcaption>`);
    expect(html).toContain(`<p class="meta">${empty}</p>`);
    if (lang !== "en") expect(html).not.toMatch(/Peak|No clicks| clicks</);
  });

  test("with clicks, the chart's bars are labelled in the page's language", async () => {
    const { cookie } = await signIn();
    const { id } = await createVia(cookie, { target_url: "https://example.com/a" });
    const [{ service_id }] = await sql`select service_id from links where id = ${id}`;
    await sql`insert into link_stats_daily (link_id, service_id, bucket, is_bot, clicks, uniques) values (${id}, ${service_id}, '2026-10-23', false, 3, 2)`;
    const html = await (await get(`/links/${id}`, `${cookie}; yfi_lang=uk`)).text();
    expect(html).toContain("<title>2026-10-23: кліків: 3</title>");
    expect(html).toContain("Найбільше кліків: 3");
  });

  test("disable turns the link off", async () => {
    const { cookie } = await signIn();
    const { id } = await createVia(cookie, { target_url: "https://example.com/a" });
    expect((await post(`/links/${id}/disable`, {}, cookie)).status).toBe(303);
    const [{ code }] = await sql`select code from links where id = ${id}`;
    expect((await get(`/${code}`)).status).toBe(410);
  });
});

describe("account API keys", () => {
  test("valid: a key for the user's own service, shown once, works on /v1", async () => {
    const { cookie } = await signIn();
    const res = await post("/account/keys", { name: "my app", scope: ["links:read", "links:write"] }, cookie);
    const secret = /yfi_[A-Za-z0-9]{8}_[A-Za-z0-9]{32}/.exec(await res.text())?.[0];

    expect(res.status).toBe(201);
    const me = await app.request(`${ORIGIN}/v1/me`, { headers: { authorization: `Bearer ${secret}` } });
    expect((await me.json()).service.slug).toMatch(/^u-/);
    expect(await (await get("/account/keys", cookie)).text()).not.toContain(secret!);
  });

  test.each([
    ["an empty name", { name: "", scope: ["links:read"] }],
    ["no scopes", { name: "x" }],
    ["keys:manage", { name: "x", scope: ["keys:manage"] }],
    ["an unknown scope", { name: "x", scope: ["links:delete"] }],
    ["a name over 100 characters", { name: "x".repeat(101), scope: ["links:read"] }],
  ])("%s is refused with 422", async (_, fields) => {
    const { cookie } = await signIn();
    expect((await post("/account/keys", fields, cookie)).status).toBe(422);
  });

  test("revoking stops the key; another user's key cannot be revoked", async () => {
    const ann = (await signIn("ga", "ann@example.com")).cookie;
    const bob = (await signIn("gb", "bob@example.com")).cookie;
    const secret = /yfi_[A-Za-z0-9]{8}_[A-Za-z0-9]{32}/.exec(await (await post("/account/keys", { name: "k", scope: ["links:read"] }, ann)).text())![0];
    const [{ id }] = await sql`select id from api_keys`;

    expect((await post(`/account/keys/${id}/revoke`, {}, bob)).status).toBe(404);
    expect((await post(`/account/keys/${id}/revoke`, {}, ann)).status).toBe(303);
    expect((await app.request(`${ORIGIN}/v1/me`, { headers: { authorization: `Bearer ${secret}` } })).status).toBe(401);
  });

  test("needs a session", async () => {
    expect((await get("/account/keys")).headers.get("location")).toBe("/");
  });

  test("allows at most 10 active keys", async () => {
    const { cookie } = await signIn();
    const statuses = [];
    for (let i = 0; i < 11; i++) statuses.push((await post("/account/keys", { name: `k${i}`, scope: ["links:read"] }, cookie)).status);
    expect(statuses.slice(0, 10).every((s) => s === 201)).toBe(true);
    expect(statuses[10]).toBe(422);
  });

  test("a blocked user's keys stop working on /v1 and /mcp", async () => {
    const { cookie } = await signIn();
    const secret = /yfi_[A-Za-z0-9]{8}_[A-Za-z0-9]{32}/.exec(await (await post("/account/keys", { name: "k", scope: ["links:read"] }, cookie)).text())![0];
    await sql`update users set disabled_at = now()`;
    const auth = { authorization: `Bearer ${secret}` };

    expect((await app.request(`${ORIGIN}/v1/me`, { headers: auth })).status).toBe(401);
    const mcp = await app.request(`${ORIGIN}/mcp`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
    expect(mcp.status).toBe(401);
  });
});

describe("public pages", () => {
  test.each(["/privacy", "/terms"])("%s is public", async (path) => {
    const res = await get(path);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("yoy.fyi");
  });
});

test("without a Telegram bot, the header has no Telegram link", async () => {
  const { cookie } = await signIn();
  expect(await (await get("/", cookie)).text()).not.toContain('href="/account/telegram"');
});

describe("landing and docs for search engines and AI", () => {
  test("the signed-out home page has a description, canonical URL, FAQ and app JSON-LD, and links to the guide", async () => {
    const html = await (await get("/")).text();
    expect(html).toContain('<meta name="description"');
    expect(html).toContain(`<link rel="canonical" href="${ORIGIN}/"/>`);
    const ld = JSON.parse(/<script type="application\/ld\+json">(.*?)<\/script>/.exec(html)![1]!);
    expect(ld["@graph"].map((n: { "@type": string }) => n["@type"])).toEqual(["WebApplication", "FAQPage"]);
    expect(html).toContain('href="/docs/mcp"');
    expect(html).toContain(`${ORIGIN}/mcp`);
  });

  test("pages link the icon", async () => {
    expect(await (await get("/")).text()).toContain('rel="icon" href="/static/icon.svg"');
  });

  test("/docs/mcp explains every client, signed in or not", async () => {
    const res = await get("/docs/mcp");
    const html = await res.text();
    expect(res.status).toBe(200);
    for (const text of ["claude.ai", "ChatGPT", "claude mcp add --transport http", "mcpServers", "get_qr"]) expect(html).toContain(text);
    expect(res.headers.get("content-security-policy")).toContain("style-src 'self'");
  });

  test("the sitemap lists the guide", async () => {
    expect(await (await get("/sitemap.xml")).text()).toContain(`<loc>${ORIGIN}/docs/mcp</loc>`);
  });
});

describe("landing and guide in four languages", () => {
  test.each([
    ["/", "uk", "Короткі посилання та QR-коди"],
    ["/en", "en", "Short links and QR codes"],
    ["/es", "es", "Enlaces cortos y códigos QR"],
    ["/fr", "fr", "Liens courts et codes QR"],
  ])("%s is the landing page in %s with hreflang alternates", async (path, lang, h1) => {
    const html = await (await get(path)).text();
    expect(html).toContain(`<html lang="${lang}">`);
    expect(html).toContain(`<h1>${h1}</h1>`);
    for (const [l, href] of [["uk", "/"], ["en", "/en"], ["es", "/es"], ["fr", "/fr"]]) {
      expect(html).toContain(`hreflang="${l}" href="${ORIGIN}${href}"`);
    }
  });

  test.each([
    ["/docs/mcp", "uk"],
    ["/en/docs/mcp", "en"],
    ["/es/docs/mcp", "es"],
    ["/fr/docs/mcp", "fr"],
  ])("%s is the guide in %s", async (path, lang) => {
    const html = await (await get(path)).text();
    expect(html).toContain(`<html lang="${lang}">`);
    expect(html).toContain("claude mcp add --transport http");
  });

  test.each(["/de", "/english", "/en/docs", "/xen"])("%s is not a language page", async (path) => {
    expect((await get(path)).status).toBe(404);
  });

  test("a signed-in user on /en gets a link to their links", async () => {
    const { cookie } = await signIn();
    expect(await (await get("/en", cookie)).text()).toContain(">My links<");
  });

  test("the sitemap lists every language of the landing page and guide", async () => {
    const text = await (await get("/sitemap.xml")).text();
    for (const path of ["/", "/en", "/es", "/fr", "/docs/mcp", "/en/docs/mcp", "/es/docs/mcp", "/fr/docs/mcp"]) {
      expect(text).toContain(`<loc>${ORIGIN}${path}</loc>`);
    }
  });
});

describe("signed-in pages in the visitor's language", () => {
  const withLang = (cookie: string, lang: string) => `${cookie}; yfi_lang=${lang}`;

  test.each([
    ["en", "My links", "Shorten"],
    ["es", "Mis enlaces", "Acortar"],
    ["fr", "Mes liens", "Raccourcir"],
    ["uk", "Мої посилання", "Скоротити"],
  ])("with the %s cookie the home page is in that language", async (lang, h1, button) => {
    const { cookie } = await signIn();
    const html = await (await get("/", withLang(cookie, lang))).text();
    expect(html).toContain(`<html lang="${lang}">`);
    expect(html).toContain(`<h1>${h1}</h1>`);
    expect(html).toContain(button);
  });

  test("without a cookie, the browser's language is used, and an unknown one falls back to Ukrainian", async () => {
    const { cookie } = await signIn();
    const fr = await app.request(`${ORIGIN}/account/keys`, { headers: { cookie, "accept-language": "fr-FR,fr;q=0.9" } });
    expect(await fr.text()).toContain("<h1>Clés d&#39;API</h1>");
    const de = await app.request(`${ORIGIN}/account/keys`, { headers: { cookie, "accept-language": "de-DE" } });
    expect(await de.text()).toContain("<h1>API-ключі</h1>");
  });

  test("validation errors come in the page's language", async () => {
    const { cookie } = await signIn();
    const res = await post("/links", { target_url: "ftp://example.com/" }, withLang(cookie, "en"));
    expect(await res.text()).toContain("The address is not allowed");
  });

  test("/lang/en sets the cookie and returns to the page it came from; other origins go home", async () => {
    const res = await app.request(`${ORIGIN}/lang/en`, { headers: { referer: `${ORIGIN}/account/keys` } });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/account/keys");
    expect(res.headers.get("set-cookie")).toContain("yfi_lang=en");
    const away = await app.request(`${ORIGIN}/lang/fr`, { headers: { referer: "https://evil.example/x" } });
    expect(away.headers.get("location")).toBe("/");
  });

  // The landing page, the guide and the blog take their language from the address, so the switch
  // has to go to the same page in the chosen language, or nothing changes.
  test.each([
    ["/", "en", "/en"],
    ["/en", "fr", "/fr"],
    ["/fr", "uk", "/"],
    ["/docs/mcp", "es", "/es/docs/mcp"],
    ["/es/docs/mcp", "uk", "/docs/mcp"],
    ["/blog/en", "uk", "/blog/uk"],
    ["/blog/uk/some-post", "fr", "/blog/fr/some-post"],
    ["/privacy", "en", "/privacy"],
    ["/english", "fr", "/english"],
    ["/blog", "en", "/blog"],
  ])("switching from %s to %s goes to %s", async (from, lang, to) => {
    const res = await app.request(`${ORIGIN}/lang/${lang}`, { headers: { referer: `${ORIGIN}${from}` } });
    expect(res.headers.get("location")).toBe(to);
    expect(res.headers.get("set-cookie")).toContain(`yfi_lang=${lang}`);
  });

  test("signed in, / is the home page in every language, so the switch stays there", async () => {
    const { cookie } = await signIn();
    const res = await app.request(`${ORIGIN}/lang/en`, { headers: { cookie, referer: `${ORIGIN}/?q=gig` } });
    expect(res.headers.get("location")).toBe("/?q=gig");
  });

  test("an unknown language is not a switch", async () => {
    expect((await get("/lang/de")).status).toBe(404);
  });

  test("the footer offers the other languages", async () => {
    const html = await (await get("/privacy")).text();
    for (const l of ["en", "es", "fr"]) expect(html).toContain(`href="/lang/${l}"`);
  });
});
