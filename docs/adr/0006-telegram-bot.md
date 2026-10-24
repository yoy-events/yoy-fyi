# ADR-0006: Telegram bot

- Status: accepted (2026-10-24)
- Decider: Roman

## Context

Most of yoy.fyi's audience lives in Telegram. Sending a long link to a bot and getting the short link and its QR back is quicker there than opening the website, and works on a phone without a browser extension.

## Decision

- **Webhook, not polling:** Telegram posts updates to `POST /telegram/webhook`. The `X-Telegram-Bot-Api-Secret-Token` header must match a secret derived from the bot token, so only Telegram can call it. Every update is answered 200 so Telegram does not retry it.
- **Connecting an account:** on `/account/telegram` the signed-in user presses Connect and lands on `https://t.me/<bot>?start=<token>`. The token is one-time, 15 minutes, stored as a hash. `/start <token>` names the account it would connect to, and the Telegram user links it by sending `/confirm` (so a connect link sent to someone else cannot silently tie their Telegram to the sender's account); one Telegram user belongs to at most one account (connecting again moves it). Disconnect is on the same page.
- **Shortening:** in a private chat, the first `http(s)://` URL in a connected user's message becomes a link of their personal service with `created_via: "telegram"`, through the same `createLink` rules as the web (target policy, Safe Browsing). The reply is the QR as a photo with the short URL as its caption.
- **Abuse:** 20 links per hour per user from Telegram, blocked users get nothing, group chats are ignored.
- **Configuration:** one optional secret, `TELEGRAM_BOT_TOKEN`. At start the server calls `getMe` and `setWebhook`. Only one stage may carry the token, because each start points the bot's single webhook at itself.

## Consequences

- The bot token is a new secret on the VM; a leaked token lets someone impersonate the bot, not reach accounts (connecting needs a token issued to a signed-in user).
- A failed `setWebhook` at start is logged and the site runs without the bot.
