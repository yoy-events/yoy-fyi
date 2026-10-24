// The Telegram bot: connect an account with a one-time /start link, then send a long link and
// get the short one with its QR. Valid, invalid and empty input.
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { createApp } from "../src/app";
import { type TelegramApi, telegramApi } from "../src/telegram";
import { reset, testAdmin, testDb } from "./helpers";

const ORIGIN = "https://yoy.fyi";
const CLIENT_ID = "123-test.apps.googleusercontent.com";
const SECRET = "s".repeat(64);
const TG_USER = 5551234;

let sql: SQL;
let now: Date;
let app: ReturnType<typeof createApp>;
let claims: Record<string, unknown>;
let cookie: string;
let sent: { method: string; params: Record<string, unknown> }[];

const api: TelegramApi = {
  call: async (method, params) => {
    sent.push({ method, params });
    return true;
  },
  sendPhoto: async (chatId, png, caption) => {
    sent.push({ method: "sendPhoto", params: { chat_id: chatId, caption, bytes: png.byteLength } });
  },
};

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
const cookies = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .filter((c) => !c.endsWith("="))
    .join("; ");
const get = (path: string, c = cookie) => app.request(`${ORIGIN}${path}`, { headers: c ? { cookie: c } : {} });
const post = (path: string, c = cookie, origin = ORIGIN) =>
  app.request(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin, cookie: c }, body: "" });

async function signIn(sub: string, email: string) {
  const start = await get("/login/google", "");
  const to = new URL(start.headers.get("location")!);
  claims = { iss: "https://accounts.google.com", aud: CLIENT_ID, sub, email, email_verified: true, nonce: to.searchParams.get("nonce"), exp: now.getTime() / 1000 + 3600 };
  return cookies(await get(`/admin/login/google/callback?code=c&state=${to.searchParams.get("state")}`, cookies(start)));
}

const update = (text: string, opts: { from?: number; chatType?: string; secret?: string | null } = {}) =>
  app.request(`${ORIGIN}/telegram/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(opts.secret === null ? {} : { "x-telegram-bot-api-secret-token": opts.secret ?? SECRET }) },
    body: JSON.stringify({
      update_id: 1,
      message: { message_id: 1, from: { id: opts.from ?? TG_USER }, chat: { id: opts.from ?? TG_USER, type: opts.chatType ?? "private" }, text },
    }),
  });
const lastText = () => String(sent.filter((s) => s.method === "sendMessage").at(-1)?.params.text ?? "");

// Starts the connect flow on the website and returns the /start token from the t.me link.
async function startToken(c = cookie) {
  const res = await post("/account/telegram/connect", c);
  const to = new URL(res.headers.get("location")!);
  expect(`${to.origin}${to.pathname}`).toBe("https://t.me/yoyfyi_bot");
  return to.searchParams.get("start")!;
}
async function connected() {
  await update(`/start ${await startToken()}`);
  await update("/confirm");
  sent = [];
}

beforeAll(async () => {
  sql = await testDb();
});

beforeEach(async () => {
  await reset(sql);
  now = new Date("2026-10-24T12:00:00Z");
  sent = [];
  const mail = testAdmin();
  app = createApp({
    sql,
    publicOrigin: ORIGIN,
    countryOf: () => null,
    resolveHost: async () => ["93.184.215.14"],
    now: () => now,
    telegram: { api, username: "yoyfyi_bot", webhookSecret: SECRET },
    admin: { ...mail.admin, google: { clientId: CLIENT_ID, clientSecret: "s", exchange: async () => Response.json({ id_token: `${b64({})}.${b64(claims)}.sig` }) } },
  });
  cookie = await signIn("g-ann", "ann@example.com");
});

describe("connecting an account", () => {
  test("the account page offers Connect; /start names the account and /confirm links it", async () => {
    expect(await (await get("/account/telegram")).text()).toContain('action="/account/telegram/connect"');
    const res = await update(`/start ${await startToken()}`);
    expect(res.status).toBe(200);
    expect(lastText()).toContain("ann@example.com");
    expect(lastText()).toContain("/confirm");
    expect((await sql`select telegram_user_id from users`)[0].telegram_user_id).toBeNull();

    await update("/confirm");
    expect(lastText()).toContain("Connected to ann@example.com");
    expect((await sql`select telegram_user_id from users`)[0].telegram_user_id).toBe(String(TG_USER));
    expect(await (await get("/account/telegram")).text()).toContain("Connected");
  });

  test.each([
    ["an unknown token", async () => "x".repeat(43)],
    ["an expired token", async () => {
      const t = await startToken();
      now = new Date(now.getTime() + 16 * 60_000);
      return t;
    }],
    ["a used token", async () => {
      const t = await startToken();
      await update(`/start ${t}`, { from: 999 });
      await update("/confirm", { from: 999 });
      return t;
    }],
  ])("%s does not connect", async (_, token) => {
    const t = await token();
    await update(`/start ${t}`);
    await update("/confirm");
    expect(lastText()).toContain("/account/telegram");
    expect((await sql`select 1 from users where telegram_user_id = ${TG_USER}`)).toHaveLength(0);
  });

  test("/start alone, or /confirm without a claimed token, links nothing", async () => {
    await update("/confirm");
    expect(lastText()).toContain("Nothing to confirm");
    expect(await sql`select 1 from users where telegram_user_id is not null`).toHaveLength(0);
  });

  test("/confirm applies to the latest /start only, even if an earlier one expires later", async () => {
    const bob = await signIn("g-bob", "bob@example.com");
    const bobToken = await startToken(bob);
    now = new Date(now.getTime() + 60_000);
    const annToken = await startToken();
    now = new Date(now.getTime() - 60_000);
    await update(`/start ${annToken}`);
    await update(`/start ${bobToken}`);
    await update("/confirm");
    const rows = await sql`select email from users where telegram_user_id = ${TG_USER}`;
    expect(rows.map((r: { email: string }) => r.email)).toEqual(["bob@example.com"]);
  });

  test("a token claimed by one Telegram user cannot be confirmed by another", async () => {
    await update(`/start ${await startToken()}`);
    await update("/confirm", { from: 999 });
    expect(await sql`select 1 from users where telegram_user_id is not null`).toHaveLength(0);
  });

  test("a confirmed connection to another account moves the Telegram user", async () => {
    await connected();
    const bob = await signIn("g-bob", "bob@example.com");
    await update(`/start ${await startToken(bob)}`);
    await update("/confirm");
    const rows = await sql`select email from users where telegram_user_id = ${TG_USER}`;
    expect(rows.map((r: { email: string }) => r.email)).toEqual(["bob@example.com"]);
  });

  test("disconnect unlinks", async () => {
    await connected();
    expect((await post("/account/telegram/disconnect")).status).toBe(303);
    expect((await sql`select telegram_user_id from users`)[0].telegram_user_id).toBeNull();
  });

  test("the account pages need a session and our own Origin", async () => {
    expect((await get("/account/telegram", "")).status).toBe(302);
    expect((await post("/account/telegram/connect", "")).status).toBe(401);
    expect((await post("/account/telegram/connect", cookie, "https://evil.example")).status).toBe(403);
  });
});

describe("shortening from Telegram", () => {
  test("a message with a link gets the short link and its QR back", async () => {
    await connected();
    await update("look https://example.com/long/page?x=1 thanks");
    const [link] = await sql`select code, target_url, created_via from links`;
    expect(link).toMatchObject({ target_url: "https://example.com/long/page?x=1", created_via: "telegram" });
    const photo = sent.find((s) => s.method === "sendPhoto")!;
    expect(photo.params).toMatchObject({ chat_id: TG_USER, caption: `${ORIGIN}/${link.code}` });
    expect(photo.params.bytes as number).toBeGreaterThan(100);
  });

  test.each([
    ["no link", "hello"],
    ["empty text", ""],
    ["a non-http link", "ftp://example.com/x"],
  ])("%s gets a hint and creates nothing", async (_, text) => {
    await connected();
    await update(text);
    expect(lastText()).toContain("Send me a link");
    expect(await sql`select 1 from links`).toHaveLength(0);
  });

  test("a refused target is explained", async () => {
    await connected();
    await update("https://127.0.0.1/admin");
    expect(lastText()).toContain("not allowed");
    expect(await sql`select 1 from links`).toHaveLength(0);
  });

  test("an unconnected Telegram user is told how to connect", async () => {
    await update("https://example.com/");
    expect(lastText()).toContain(`${ORIGIN}/account/telegram`);
    expect(await sql`select 1 from links`).toHaveLength(0);
  });

  test("a blocked user's Telegram creates nothing", async () => {
    await connected();
    await sql`update users set disabled_at = now()`;
    await update("https://example.com/");
    expect(await sql`select 1 from links`).toHaveLength(0);
  });

  test("group chats are ignored", async () => {
    await connected();
    await update("https://example.com/", { chatType: "group" });
    expect(sent).toHaveLength(0);
  });

  test("at most 20 links an hour", async () => {
    await connected();
    for (let i = 0; i < 20; i++) await update(`https://example.com/${i}`);
    await update("https://example.com/21");
    expect(await sql`select 1 from links`).toHaveLength(20);
    expect(lastText()).toContain("Too many");
  });
});

describe("telegramApi", () => {
  test("posts JSON to the Bot API and returns the result; an error reply throws", async () => {
    const calls: string[] = [];
    const ok = telegramApi("T0K", async (url, init) => {
      calls.push(`${url} ${init?.body}`);
      return Response.json({ ok: true, result: { username: "b" } });
    });
    expect(await ok.call("getMe", {})).toEqual({ username: "b" });
    expect(calls).toEqual(["https://api.telegram.org/botT0K/getMe {}"]);
    const bad = telegramApi("T0K", async () => Response.json({ ok: false, description: "Unauthorized" }, { status: 401 }));
    expect(bad.call("getMe", {})).rejects.toThrow("Unauthorized");
  });
});

describe("webhook", () => {
  test.each([
    ["no secret header", null],
    ["a wrong secret", "w".repeat(64)],
  ])("%s is 401 and does nothing", async (_, secret) => {
    expect((await update("https://example.com/", { secret })).status).toBe(401);
    expect(sent).toHaveLength(0);
  });

  test("updates without a message, and malformed bodies, are acknowledged and ignored", async () => {
    const send = (body: string) =>
      app.request(`${ORIGIN}/telegram/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET }, body });
    expect((await send(JSON.stringify({ update_id: 2, edited_message: {} }))).status).toBe(200);
    expect((await send("not json")).status).toBe(200);
    expect(sent).toHaveLength(0);
  });

  test("without a bot configured, there is no webhook and no account page", async () => {
    const plain = createApp({ sql, publicOrigin: ORIGIN, countryOf: () => null, admin: testAdmin().admin });
    expect((await plain.request(`${ORIGIN}/telegram/webhook`, { method: "POST", body: "{}" })).status).toBe(404);
  });
});
