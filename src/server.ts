import { SQL } from "bun";
import { createApp } from "./app";
import { clientIp } from "./client-ip";
import { loadConfig } from "./config";
import { resendSender } from "./email";
import { loadCountryLookup } from "./geo";
import { every } from "./jobs";
import { migrate } from "./migrate";
import { deliverDue, fanOut } from "./outbox";
import { dropExpiredClicks, rollupRecent } from "./rollup";
import { rescanLinks, safeBrowsing } from "./safe-browsing";
import { telegramApi } from "./telegram";
import { loadSecretKey } from "./secretbox";

const config = loadConfig();
const sql = new SQL(config.databaseUrl);
await migrate(sql);

// Keep two months of click partitions ahead; inserts fail without one.
await sql`select ensure_click_partitions(2)`;
every(sql, "partitions", 6 * 3600_000, async () => {
  await sql`select ensure_click_partitions(2)`;
  await dropExpiredClicks(sql);
  // The MCP call log is kept as long as raw clicks (13 months).
  await sql`delete from mcp_calls where at < now() - interval '13 months'`;
  await sql`delete from page_views where at < now() - interval '13 months'`;
  // Self-registered OAuth clients that never got a connection are dropped after a day.
  await sql`delete from oauth_clients c where c.kind = 'dcr' and c.created_at < now() - interval '1 day'
            and not exists (select 1 from oauth_grants g where g.client_id = c.client_id)`;
});
every(sql, "rollup", 5 * 60_000, () => rollupRecent(sql));

const webhookKey = await loadSecretKey(config.webhookEncKey);
const ownHost = new URL(config.publicOrigin).hostname;
every(sql, "webhook-fanout", 2_000, () => fanOut(sql, config.publicOrigin));
every(sql, "webhook-delivery", 2_000, () => deliverDue(sql, { key: webhookKey, ownHost }));

const unsafeUrls = config.safeBrowsingApiKey ? safeBrowsing(config.safeBrowsingApiKey) : undefined;
if (unsafeUrls) every(sql, "safe-browsing-rescan", 86_400_000, () => rescanLinks(sql, unsafeUrls, new Date()));
else console.warn("SAFE_BROWSING_API_KEY is not set: link targets are not checked against Safe Browsing");

// The webhook secret is derived from the token, so there is no second secret to keep.
async function startTelegram(token: string) {
  const api = telegramApi(token);
  const me = (await api.call("getMe", {})) as { username: string };
  const webhookSecret = new Bun.CryptoHasher("sha256").update(`yoy-fyi-webhook:${token}`).digest("hex");
  await api.call("setWebhook", { url: `${config.publicOrigin}/telegram/webhook`, secret_token: webhookSecret, allowed_updates: ["message"] });
  console.log(`telegram bot @${me.username} connected`);
  return { api, username: me.username, webhookSecret };
}
const telegram = config.telegramBotToken
  ? await startTelegram(config.telegramBotToken).catch((err) => {
      console.error("telegram bot not started", String(err));
      return undefined;
    })
  : undefined;

const app = createApp({
  sql,
  publicOrigin: config.publicOrigin,
  countryOf: await loadCountryLookup(config.geoipDbPath),
  webhookKey,
  unsafeUrls,
  telegram,
  indexable: config.indexable,
  openaiAppsChallenge: config.openaiAppsChallenge,
  admin: {
    email: config.adminEmail,
    sessionSecret: config.sessionSecret,
    sendEmail: resendSender(config.resendApiKey, config.mailFrom),
    google: config.google,
  },
});

const server = Bun.serve({
  port: config.port,
  fetch: (req, server) => app.fetch(req, { ip: clientIp(req, server.requestIP(req)?.address, config.clientIpHeader) }),
});
console.log(`yoy-fyi listening on :${server.port} as ${config.publicOrigin}`);
