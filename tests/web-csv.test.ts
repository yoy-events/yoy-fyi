// Importing links from CSV and exporting links and clicks: valid, invalid and empty input.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { createApp } from "../src/app";
import { addClick, reset, testAdmin, testDb } from "./helpers";

const ORIGIN = "https://yoy.fyi";
const CLIENT_ID = "123-test.apps.googleusercontent.com";

let sql: SQL;
let now: Date;
let app: ReturnType<typeof createApp>;
let claims: Record<string, unknown>;
let cookie: string;

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
const cookies = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .filter((c) => !c.endsWith("="))
    .join("; ");
const get = (path: string, c = cookie) => app.request(`${ORIGIN}${path}`, { headers: c ? { cookie: c } : {} });
const post = (path: string, fields: Record<string, string>, c = cookie, origin = ORIGIN) =>
  app.request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin, cookie: c },
    body: new URLSearchParams(fields).toString(),
  });
const importCsv = (csv: string, c = cookie) => post("/links/import", { csv }, c);

async function signIn(sub: string, email: string) {
  const start = await get("/login/google", "");
  const to = new URL(start.headers.get("location")!);
  claims = { iss: "https://accounts.google.com", aud: CLIENT_ID, sub, email, email_verified: true, nonce: to.searchParams.get("nonce"), exp: now.getTime() / 1000 + 3600 };
  return cookies(await get(`/admin/login/google/callback?code=c&state=${to.searchParams.get("state")}`, cookies(start)));
}

const links = () => sql`select code, target_url, title, tags, created_via from links order by id`;

beforeAll(async () => {
  sql = await testDb();
});

beforeEach(async () => {
  await reset(sql);
  now = new Date("2026-10-24T12:00:00Z");
  const mail = testAdmin();
  app = createApp({
    sql,
    publicOrigin: ORIGIN,
    countryOf: () => null,
    resolveHost: async () => ["93.184.215.14"],
    now: () => now,
    admin: { ...mail.admin, google: { clientId: CLIENT_ID, clientSecret: "s", exchange: async () => Response.json({ id_token: `${b64({})}.${b64(claims)}.sig` }) } },
  });
  cookie = await signIn("g-ann", "ann@example.com");
});

describe("import", () => {
  test("the import page explains the columns and has a paste box and a file field", async () => {
    const html = await (await get("/links/import")).text();
    expect(html).toContain('name="csv"');
    expect(html).toContain('type="file"');
    expect(html).toContain("target_url");
  });

  test("creates a link per row and lists the short links", async () => {
    const res = await importCsv('target_url,title,code,tags\nhttps://example.com/a,Gig,gig,"music, lviv"\nhttps://example.com/b,,,\n');
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("https://yoy.fyi/gig");
    const [gig, plain] = await links();
    expect(gig).toEqual({ code: "gig", target_url: "https://example.com/a", title: "Gig", tags: ["music", "lviv"], created_via: "web" });
    expect(plain).toMatchObject({ target_url: "https://example.com/b", title: null, tags: [], created_via: "web" });
  });

  test("a bad row is reported with its line number while the good rows are created", async () => {
    const html = await (await importCsv("target_url,code\nhttps://example.com/a,one\nftp://example.com/x,two\nhttps://example.com/c,one\n")).text();
    expect(html).toContain("Рядок 3");
    expect(html).toContain("Рядок 4");
    expect((await links()).map((l: { code: string }) => l.code)).toEqual(["one"]);
  });

  test("a file upload works like pasting", async () => {
    const form = new FormData();
    form.append("file", new File(["target_url\nhttps://example.com/f\n"], "links.csv", { type: "text/csv" }));
    const res = await app.request(`${ORIGIN}/links/import`, { method: "POST", headers: { origin: ORIGIN, cookie }, body: form });
    expect(res.status).toBe(200);
    expect(await links()).toHaveLength(1);
  });

  test.each([
    ["nothing", "", "порожній"],
    ["only blank lines", "\n\n", "порожній"],
    ["a header only", "target_url\n", "немає рядків"],
    ["no target_url column", "title\nHello\n", "target_url"],
    ["an unknown column", "target_url,colour\nhttps://example.com/,red\n", "colour"],
    ["an unclosed quote", 'target_url\n"https://example.com/', "не закрита лапка"],
    ["more than 100 rows", `target_url\n${"https://example.com/\n".repeat(101)}`, "100"],
  ])("%s is refused with 422 and nothing is created", async (_, csv, message) => {
    const res = await importCsv(csv);
    expect(res.status).toBe(422);
    expect(await res.text()).toContain(message);
    expect(await links()).toHaveLength(0);
  });

  test("a body over 256 KB is refused before it is read", async () => {
    expect((await importCsv(`target_url\n${"x".repeat(300 * 1024)}`)).status).toBe(413);
    expect(await links()).toHaveLength(0);
  });

  test("at most 5 imports an hour", async () => {
    for (let i = 0; i < 5; i++) expect((await importCsv(`target_url\nhttps://example.com/${i}\n`)).status).toBe(200);
    expect((await importCsv("target_url\nhttps://example.com/x\n")).status).toBe(429);
  });

  test("needs a session and our own Origin", async () => {
    expect((await importCsv("target_url\nhttps://example.com/\n", "")).status).toBe(401);
    expect((await post("/links/import", { csv: "target_url\nhttps://example.com/\n" }, cookie, "https://evil.example")).status).toBe(403);
    expect((await get("/links/import", "")).status).toBe(302);
  });
});

describe("export", () => {
  test("links.csv has the user's links only, with formulas neutralised", async () => {
    await importCsv("target_url,title,code,tags\nhttps://example.com/a,=HYPERLINK(1),gig,music\n");
    const bob = await signIn("g-bob", "bob@example.com");
    await importCsv("target_url,code\nhttps://example.com/bob,bobs\n", bob);

    const res = await get("/links/export.csv");
    expect(res.headers.get("content-type")).toStartWith("text/csv");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="yoy-fyi-links.csv"');
    const lines = (await res.text()).trim().split("\r\n");
    expect(lines[0]).toBe("code,short_url,target_url,title,tags,status,clicks_total,created_at");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toStartWith("gig,https://yoy.fyi/gig,https://example.com/a,'=HYPERLINK(1),music,active,0,");
  });

  test("with no links, links.csv is the header alone", async () => {
    expect((await (await get("/links/export.csv")).text()).trim().split("\r\n")).toHaveLength(1);
  });

  test("clicks.csv lists one link's clicks, newest first", async () => {
    await importCsv("target_url,code\nhttps://example.com/a,gig\n");
    const [link] = await sql`select id, service_id from links`;
    await addClick(sql, { link_id: link.id, service_id: link.service_id, clicked_at: "2026-10-23T10:00:00Z", country: "UA", utm_source: "telegram" });
    await addClick(sql, { link_id: link.id, service_id: link.service_id, clicked_at: "2026-10-24T10:00:00Z", country: "PL", is_bot: true });

    const res = await get(`/links/${link.id}/clicks.csv`);
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="gig-clicks.csv"');
    const lines = (await res.text()).trim().split("\r\n");
    expect(lines[0]).toBe("clicked_at,referer_host,country,device,browser,os,utm_source,utm_medium,utm_campaign,is_bot");
    expect(lines.slice(1).map((l) => l.split(",")[2])).toEqual(["PL", "UA"]);
  });

  test.each([
    ["another user's link", "other"],
    ["an unknown id", "00000000-0000-0000-0000-000000000000"],
    ["a malformed id", "nope"],
  ])("clicks.csv of %s is 404", async (_, which) => {
    const bob = await signIn("g-bob", "bob@example.com");
    await importCsv("target_url,code\nhttps://example.com/bob,bobs\n", bob);
    const [bobLink] = await sql`select id from links`;
    expect((await get(`/links/${which === "other" ? bobLink.id : which}/clicks.csv`)).status).toBe(404);
  });

  test("exports need a session", async () => {
    expect((await get("/links/export.csv", "")).status).toBe(302);
  });
});
