import { SQL } from "bun";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { loadCountryLookup } from "./geo";
import { every } from "./jobs";
import { migrate } from "./migrate";
import { dropExpiredClicks, rollupRecent } from "./rollup";

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

const app = createApp({
  sql,
  publicOrigin: config.publicOrigin,
  countryOf: await loadCountryLookup(config.geoipDbPath),
});

const server = Bun.serve({
  port: config.port,
  fetch: (req, server) => app.fetch(req, { ip: server.requestIP(req)?.address }),
});
console.log(`yoy-fyi listening on :${server.port} as ${config.publicOrigin}`);
