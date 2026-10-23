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
import { loadSecretKey } from "./secretbox";

const config = loadConfig();
const sql = new SQL(config.databaseUrl);
await migrate(sql);

// Keep two months of click partitions ahead; inserts fail without one.
await sql`select ensure_click_partitions(2)`;
every(sql, "partitions", 6 * 3600_000, async () => {
  await sql`select ensure_click_partitions(2)`;
  await dropExpiredClicks(sql);
});
every(sql, "rollup", 5 * 60_000, () => rollupRecent(sql));

const webhookKey = await loadSecretKey(config.webhookEncKey);
const ownHost = new URL(config.publicOrigin).hostname;
every(sql, "webhook-fanout", 2_000, () => fanOut(sql, config.publicOrigin));
every(sql, "webhook-delivery", 2_000, () => deliverDue(sql, { key: webhookKey, ownHost }));

const app = createApp({
  sql,
  publicOrigin: config.publicOrigin,
  countryOf: await loadCountryLookup(config.geoipDbPath),
  webhookKey,
  admin: {
    email: config.adminEmail,
    sessionSecret: config.sessionSecret,
    sendEmail: resendSender(config.resendApiKey, config.mailFrom),
  },
});

const server = Bun.serve({
  port: config.port,
  fetch: (req, server) => app.fetch(req, { ip: clientIp(req, server.requestIP(req)?.address, config.clientIpHeader) }),
});
console.log(`yoy-fyi listening on :${server.port} as ${config.publicOrigin}`);
