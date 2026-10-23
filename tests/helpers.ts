import { SQL } from "bun";
import { migrate } from "../src/migrate";

const adminUrl = process.env.TEST_ADMIN_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:55433/postgres";
const dbName = "yoy_fyi_test";

let ready: Promise<SQL> | undefined;

// One fresh database per test process, migrated once. Tests call reset() for isolation.
export function testDb(): Promise<SQL> {
  ready ??= (async () => {
    const admin = new SQL(adminUrl);
    await admin.unsafe(`drop database if exists ${dbName} with (force)`);
    await admin.unsafe(`create database ${dbName}`);
    await admin.close();
    const url = new URL(adminUrl);
    url.pathname = `/${dbName}`;
    const sql = new SQL(url.toString());
    await migrate(sql);
    return sql;
  })();
  return ready;
}

export async function reset(sql: SQL): Promise<void> {
  await sql`truncate clicks, links, services, daily_salts`;
}

export async function createService(sql: SQL, slug = "yoy"): Promise<string> {
  const id = Bun.randomUUIDv7();
  await sql`insert into services (id, slug, name) values (${id}, ${slug}, ${slug})`;
  return id;
}

type LinkInput = {
  code: string;
  target_url: string;
  utm_defaults?: Record<string, string>;
  pass_click_id?: boolean;
  expires_at?: Date;
  disabled_at?: Date;
};

export async function createLink(sql: SQL, serviceId: string, link: LinkInput): Promise<string> {
  const id = Bun.randomUUIDv7();
  await sql`insert into links (id, service_id, code, target_url, utm_defaults, pass_click_id, expires_at, disabled_at)
    values (${id}, ${serviceId}, ${link.code}, ${link.target_url}, ${link.utm_defaults ?? null},
            ${link.pass_click_id ?? false}, ${link.expires_at ?? null}, ${link.disabled_at ?? null})`;
  return id;
}
