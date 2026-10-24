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
  await sql`truncate clicks, links, api_keys, services, daily_salts, link_stats_hourly, link_stats_daily, link_dims_daily, webhook_deliveries, webhooks, admin_login_tokens, oauth_grants, oauth_codes, oauth_pending, oauth_clients, telegram_connect_tokens, users`;
  await sql`update outbox_cursor set last_click_id = '00000000-0000-0000-0000-000000000000', last_clicked_at = '2000-01-01Z'`;
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

type ClickInput = {
  link_id: string;
  service_id: string;
  clicked_at: string;
  is_bot?: boolean;
  visitor_hash?: string;
  referer_host?: string;
  country?: string;
  ua_device?: string;
  ua_browser?: string;
  ua_os?: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
};

// Inserts a raw click directly, creating its month's partition when needed.
export async function addClick(sql: SQL, click: ClickInput): Promise<void> {
  await sql`select create_click_partition(${click.clicked_at}::timestamptz)`;
  await sql`insert into clicks ${sql({ id: Bun.randomUUIDv7(), is_bot: false, ...click })}`;
}

// A fresh AES-256 key for webhook secrets, base64 like WEBHOOK_ENC_KEY.
export const testWebhookKey = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");

export const ADMIN_EMAIL = "roman@example.com";

// Admin wiring for tests: captures sent emails instead of calling Resend.
export function testAdmin() {
  const sent: { to: string; subject: string; text: string }[] = [];
  return {
    sent,
    admin: {
      email: ADMIN_EMAIL,
      sessionSecret: "test-session-secret-at-least-32-characters",
      sendEmail: async (mail: { to: string; subject: string; text: string }) => void sent.push(mail),
    },
  };
}
