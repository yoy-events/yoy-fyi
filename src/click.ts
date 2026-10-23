import type { SQL } from "bun";
import Bowser from "bowser";
import { isbotMatch } from "isbot";

const QUERY_FIELDS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "fbclid",
  "gclid",
  "fbc",
  "fbp",
] as const;

export type Click = {
  id: string;
  link_id: string;
  service_id: string;
  clicked_at: Date;
  referer: string | null;
  referer_host: string | null;
  ua_device: string | null;
  ua_browser: string | null;
  ua_os: string | null;
  is_bot: boolean;
  bot_name: string | null;
  country: string | null;
  visitor_hash: string | null;
} & Record<(typeof QUERY_FIELDS)[number], string | null>;

export function describeUserAgent(ua: string | null) {
  const botName = ua ? isbotMatch(ua) : null;
  if (botName) return { is_bot: true, bot_name: botName, ua_device: "bot", ua_browser: null, ua_os: null };
  if (!ua) return { is_bot: false, bot_name: null, ua_device: null, ua_browser: null, ua_os: null };
  const parsed = Bowser.parse(ua);
  return {
    is_bot: false,
    bot_name: null,
    ua_device: parsed.platform.type ?? "other",
    ua_browser: parsed.browser.name ?? null,
    ua_os: parsed.os.name ?? null,
  };
}

export function queryFields(query: URLSearchParams) {
  return Object.fromEntries(QUERY_FIELDS.map((k) => [k, query.get(k)])) as Record<
    (typeof QUERY_FIELDS)[number],
    string | null
  >;
}

export function refererHost(referer: string | null): string | null {
  if (!referer) return null;
  try {
    return new URL(referer).hostname || null;
  } catch {
    return null;
  }
}

export async function insertClick(sql: SQL, click: Click): Promise<void> {
  await sql`insert into clicks ${sql(click)}`;
}
