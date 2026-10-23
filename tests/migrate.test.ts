import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { migrate } from "../src/migrate";

const adminUrl = process.env.TEST_ADMIN_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:55433/postgres";
const dbName = "yoy_fyi_migrate_test";
const admin = new SQL(adminUrl);
let sql: SQL;

beforeAll(async () => {
  await admin.unsafe(`drop database if exists ${dbName} with (force)`);
  await admin.unsafe(`create database ${dbName}`);
  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  sql = new SQL(url.toString());
});

afterAll(async () => {
  await sql.close();
  await admin.unsafe(`drop database if exists ${dbName} with (force)`);
  await admin.close();
});

test("creates the schema and records each migration once", async () => {
  await migrate(sql);
  await migrate(sql);

  const tables = await sql`select tablename from pg_tables where schemaname = 'public' order by tablename`;
  expect(tables.map((r: { tablename: string }) => r.tablename)).toEqual(
    expect.arrayContaining(["clicks", "daily_salts", "links", "schema_migrations", "services"]),
  );
  const [{ count }] = await sql`select count(*)::int as count from schema_migrations`;
  const files = Array.from(new Bun.Glob("*.sql").scanSync("migrations"));
  expect(count).toBe(files.length);
});

test("clicks get a partition for the current month", async () => {
  const [row] = await sql`
    insert into clicks (id, link_id, service_id, clicked_at, is_bot)
    values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), now(), false)
    returning tableoid::regclass::text as partition`;
  expect(row.partition).toMatch(/^clicks_\d{4}_\d{2}$/);
});
