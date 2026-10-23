import { SQL } from "bun";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { loadCountryLookup } from "./geo";
import { migrate } from "./migrate";

const config = loadConfig();
const sql = new SQL(config.databaseUrl);
await migrate(sql);

// Keep two months of click partitions ahead; inserts fail without one.
const ensurePartitions = () => sql`select ensure_click_partitions(2)`;
await ensurePartitions();
setInterval(() => ensurePartitions().catch((err) => console.error("partition maintenance failed", String(err))), 6 * 3600_000);

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
