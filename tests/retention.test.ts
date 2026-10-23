import { beforeAll, expect, test } from "bun:test";
import type { SQL } from "bun";
import { dropExpiredClicks } from "../src/rollup";
import { addClick, createLink, createService, reset, testDb } from "./helpers";

let sql: SQL;

beforeAll(async () => {
  sql = await testDb();
  await reset(sql);
});

const partitions = async () =>
  (await sql`select c.relname from pg_inherits i join pg_class c on c.oid = i.inhrelid
             where i.inhparent = 'clicks'::regclass order by c.relname`).map((r: { relname: string }) => r.relname);

test("drops whole monthly partitions older than 13 full months and keeps rollups", async () => {
  const serviceId = await createService(sql);
  const linkId = await createLink(sql, serviceId, { code: "ret", target_url: "https://example.com/" });
  for (const at of ["2025-07-15T00:00:00Z", "2025-08-31T23:59:59Z", "2025-09-01T00:00:00Z"]) {
    await addClick(sql, { link_id: linkId, service_id: serviceId, clicked_at: at });
  }
  await sql`insert into link_stats_daily values (${linkId}, ${serviceId}, '2025-08-01T00:00:00Z', false, 1, 1)`;

  const dropped = await dropExpiredClicks(sql, new Date("2026-10-23T12:00:00Z"));

  expect(dropped).toEqual(["clicks_2025_07", "clicks_2025_08"]);
  expect(await partitions()).not.toContain("clicks_2025_08");
  expect(await partitions()).toContain("clicks_2025_09");
  const [{ count }] = await sql`select count(*)::int as count from clicks`;
  expect(count).toBe(1);
  const [{ kept }] = await sql`select count(*)::int as kept from link_stats_daily`;
  expect(kept).toBe(1);
});
