// The yoy.fyi Telegram bot (ADR-0006). Telegram posts every message to /telegram/webhook; a
// connected user who sends a link gets the short link and its QR back.
import type { SQL } from "bun";
import { type Context, Hono } from "hono";
import { type UnsafeUrls } from "./safe-browsing";
import { createLink } from "./links";
import { qrPng } from "./qr";
import { createRateLimiter } from "./ratelimit";

export type TelegramApi = {
  call: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  sendPhoto: (chatId: number, png: Uint8Array, caption: string) => Promise<void>;
};
export type TelegramConfig = { api: TelegramApi; username: string; webhookSecret: string };

const CONNECT_TTL_MS = 15 * 60_000;
const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"]+/i;
const sha256 = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");

export function telegramApi(token: string, post: (url: string, init: RequestInit) => Promise<Response> = fetch): TelegramApi {
  const base = `https://api.telegram.org/bot${token}`;
  const check = async (res: Response) => {
    const body = (await res.json().catch(() => null)) as { ok?: boolean; result?: unknown; description?: string } | null;
    if (!body?.ok) throw new Error(`telegram: ${body?.description ?? res.status}`);
    return body.result;
  };
  return {
    call: async (method, params) =>
      check(await post(`${base}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params), signal: AbortSignal.timeout(10_000) })),
    sendPhoto: async (chatId, png, caption) => {
      const form = new FormData();
      form.append("chat_id", String(chatId));
      form.append("caption", caption);
      form.append("photo", new Blob([new Uint8Array(png)], { type: "image/png" }), "qr.png");
      await check(await post(`${base}/sendPhoto`, { method: "POST", body: form, signal: AbortSignal.timeout(10_000) }));
    },
  };
}

// The connect token that the website puts in https://t.me/<bot>?start=<token>.
export async function issueConnectToken(sql: SQL, userId: string, now: Date): Promise<string> {
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  await sql`insert into telegram_connect_tokens (token_hash, user_id, expires_at)
            values (${sha256(token)}, ${userId}, ${new Date(now.getTime() + CONNECT_TTL_MS)})`;
  return token;
}

type Deps = {
  sql: SQL;
  publicOrigin: string;
  telegram: TelegramConfig;
  now: () => Date;
  resolveHost?: (host: string) => Promise<string[]>;
  unsafeUrls?: UnsafeUrls;
};
type Message = { from?: { id?: number }; chat?: { id?: number; type?: string }; text?: string };

export function telegramRoutes({ sql, publicOrigin, telegram, now, resolveHost, unsafeUrls }: Deps) {
  const app = new Hono();
  const ownHost = new URL(publicOrigin).hostname;
  const limitCreate = createRateLimiter({ perMinute: 20 / 60, burst: 20 });
  const secret = Buffer.from(telegram.webhookSecret);
  const connectHint = `Connect your yoy.fyi account first: ${publicOrigin}/account/telegram`;

  app.post("/telegram/webhook", async (c: Context) => {
    const given = Buffer.from(c.req.header("x-telegram-bot-api-secret-token") ?? "");
    if (given.length !== secret.length || !crypto.timingSafeEqual(given, secret)) return c.text("Unauthorized", 401);
    const update = (await c.req.json().catch(() => null)) as { message?: Message } | null;
    const m = update?.message;
    // Always 200, or Telegram retries the update. Only private chats are served.
    if (!m || m.chat?.type !== "private" || typeof m.from?.id !== "number" || typeof m.chat.id !== "number") return c.json({ ok: true });
    try {
      await handle(m.from.id, m.chat.id, (m.text ?? "").trim());
    } catch (err) {
      console.error("telegram update failed", String(err));
    }
    return c.json({ ok: true });
  });

  const reply = (chatId: number, text: string) => telegram.api.call("sendMessage", { chat_id: chatId, text, link_preview_options: { is_disabled: true } });

  async function handle(fromId: number, chatId: number, text: string) {
    // Connecting takes two steps on the Telegram side: /start <token> names the account, and
    // /confirm links it. Someone who sends a victim their own connect link cannot link the
    // victim's Telegram without the victim reading whose account it is and confirming.
    const start = /^\/start(?:\s+([A-Za-z0-9_-]{1,64}))?$/.exec(text);
    if (start?.[1]) {
      const at = now();
      // Only the latest /start can be confirmed: earlier claims by this Telegram user are dropped.
      const [claimed] = await sql.begin(async (tx) => {
        await tx`update telegram_connect_tokens set claimed_by = null where claimed_by = ${fromId} and used_at is null`;
        return tx`
          update telegram_connect_tokens t set claimed_by = ${fromId}
          from users u
          where t.token_hash = ${sha256(start[1])} and t.used_at is null and t.expires_at > ${at} and u.id = t.user_id
          returning u.email`;
      });
      if (!claimed) return reply(chatId, `This connect link has expired. Open ${publicOrigin}/account/telegram and try again.`);
      return reply(
        chatId,
        `This connects your Telegram to the yoy.fyi account ${claimed.email}. Links you send here will belong to that account. If it is yours, send /confirm. If not, ignore this.`,
      );
    }
    if (text === "/confirm") {
      const at = now();
      const [used] = await sql`
        update telegram_connect_tokens set used_at = ${at}
        where claimed_by = ${fromId} and used_at is null and expires_at > ${at}
        returning user_id`;
      if (!used) return reply(chatId, `Nothing to confirm. Open ${publicOrigin}/account/telegram to connect.`);
      const [user] = await sql.begin(async (tx) => {
        await tx`update users set telegram_user_id = null where telegram_user_id = ${fromId}`;
        return tx`update users set telegram_user_id = ${fromId} where id = ${used.user_id} and disabled_at is null returning email`;
      });
      if (!user) return reply(chatId, "This account cannot be connected.");
      return reply(chatId, `Connected to ${user.email}. Send me a long link and I will shorten it.`);
    }

    const [user] = await sql`
      select u.id, s.id as service_id from users u join services s on s.owner_user_id = u.id
      where u.telegram_user_id = ${fromId} and u.disabled_at is null and s.disabled_at is null`;
    if (!user) return reply(chatId, connectHint);
    const url = URL_IN_TEXT.exec(text)?.[0];
    if (!url) return reply(chatId, "Send me a link that starts with https:// and I will shorten it.");
    if (!limitCreate(user.id).ok) return reply(chatId, "Too many new links. Try again in an hour.");

    const result = await createLink(sql, { ownHost, resolveHost, unsafeUrls }, user.service_id, { target_url: url }, null, "telegram");
    if (result.kind === "error") {
      const reason = result.details?.reason ? ` (${result.details.reason})` : "";
      return reply(chatId, `${result.code === "target_rejected" ? "That link is not allowed" : result.message}${reason}.`);
    }
    const shortUrl = `${publicOrigin}/${result.row.code}`;
    await telegram.api.sendPhoto(chatId, await qrPng(shortUrl, { fg: "#000000", bg: "#ffffff", caption: null }), shortUrl);
  }

  return app;
}
