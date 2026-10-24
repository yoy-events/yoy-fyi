// yoy.fyi API client: one file, no dependencies, works wherever `fetch` and WebCrypto exist.
// Copy it into a project, or import it from this repo. Contract: https://yoy.fyi/v1/openapi.json

export type Tag = string;
export type Bots = "exclude" | "include" | "only";
export type Dimension = "referer_host" | "utm_source" | "utm_medium" | "utm_campaign" | "country" | "device" | "browser" | "os";

export type UtmDefaults = Partial<Record<"utm_source" | "utm_medium" | "utm_campaign" | "utm_term" | "utm_content", string>>;
export type ExternalRef = { service: string; entity_type: string; entity_id: string };

export type LinkCreate = {
  target_url: string;
  code?: string;
  title?: string;
  tags?: Tag[];
  utm_defaults?: UtmDefaults;
  pass_click_id?: boolean;
  expires_at?: string;
  external_ref?: ExternalRef;
};

export type LinkUpdate = {
  target_url?: string;
  title?: string | null;
  tags?: Tag[];
  utm_defaults?: UtmDefaults | null;
  pass_click_id?: boolean;
  expires_at?: string | null;
};

export type Link = {
  id: string;
  code: string;
  short_url: string;
  target_url: string;
  title: string | null;
  tags: Tag[];
  utm_defaults: UtmDefaults | null;
  pass_click_id: boolean;
  expires_at: string | null;
  external_ref: ExternalRef | null;
  status: "active" | "expired" | "disabled";
  created_at: string;
  updated_at: string;
  disabled_at: string | null;
  created_via: "api" | "admin" | "mcp" | "web";
};

export type LinkListQuery = {
  cursor?: string;
  limit?: number;
  tag?: Tag;
  code?: string;
  ext_service?: string;
  ext_entity_type?: string;
  ext_entity_id?: string;
  created_after?: string;
  created_before?: string;
  status?: Link["status"];
};

type AnalyticsScope = { from: string; to: string; link_id?: string; tag?: Tag; bots?: Bots };

export type Timeseries = {
  interval: "hour" | "day";
  from: string;
  to: string;
  bots: Bots;
  totals: { clicks: number; uniques_upper_bound: number; bot_clicks: number };
  points: { t: string; clicks: number; uniques: number }[];
};

export type Breakdown = {
  dimension: Dimension;
  from: string;
  to: string;
  bots: Bots;
  total_clicks: number;
  other_clicks: number;
  items: { value: string | null; clicks: number }[];
};

export type Me = {
  service: { id: string; slug: string; name: string };
  key: { id: string; name: string; prefix: string; scopes: string[]; created_at: string; last_used_at: string | null; revoked_at: string | null };
};

export class YoyFyiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "YoyFyiError";
  }
}

type ClientOptions = { apiKey: string; baseUrl?: string; fetch?: (url: string, init: RequestInit) => Promise<Response> };

export function createClient({ apiKey, baseUrl = "https://yoy.fyi", fetch: fetchFn = (url, init) => fetch(url, init) }: ClientOptions) {
  async function call<T>(method: string, path: string, opts: { body?: unknown; query?: object; headers?: Record<string, string> } = {}): Promise<T> {
    const url = new URL(path, baseUrl);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const res = await fetchFn(url.toString(), {
      method,
      headers: {
        authorization: `Bearer ${apiKey}`,
        ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
        ...opts.headers,
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const e = json?.error;
      throw new YoyFyiError(res.status, e?.code ?? "internal", e?.message ?? `HTTP ${res.status}`, e?.details);
    }
    return json as T;
  }

  return {
    me: () => call<Me>("GET", "/v1/me"),
    links: {
      // An Idempotency-Key (or external_ref) makes retries safe: the same request returns the same link.
      create: (body: LinkCreate, opts: { idempotencyKey?: string } = {}) =>
        call<Link>("POST", "/v1/links", {
          body,
          headers: opts.idempotencyKey ? { "idempotency-key": opts.idempotencyKey } : {},
        }),
      get: (id: string) => call<Link>("GET", `/v1/links/${encodeURIComponent(id)}`),
      list: (query: LinkListQuery = {}) => call<{ data: Link[]; next_cursor: string | null }>("GET", "/v1/links", { query }),
      update: (id: string, body: LinkUpdate) => call<Link>("PATCH", `/v1/links/${encodeURIComponent(id)}`, { body }),
      disable: (id: string) => call<Link>("POST", `/v1/links/${encodeURIComponent(id)}/disable`),
    },
    analytics: {
      timeseries: (query: AnalyticsScope & { interval: "hour" | "day" }) =>
        call<Timeseries>("GET", "/v1/analytics/timeseries", { query }),
      breakdown: (query: AnalyticsScope & { dimension: Dimension; limit?: number }) =>
        call<Breakdown>("GET", "/v1/analytics/breakdown", { query }),
    },
  };
}

// Checks a webhook's `Yoy-Signature` header against the raw request body. Pass the body exactly
// as received, before JSON parsing. Rejects signatures older or newer than five minutes.
export async function verifyWebhook(secret: string, signature: string, rawBody: string, now = Date.now()): Promise<boolean> {
  const parts = Object.fromEntries(signature.split(",").map((p) => p.split("=", 2) as [string, string]));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !parts.v1 || Math.abs(now / 1000 - t) > 300) return false;

  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${rawBody}`)));
  const expected = Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");

  if (expected.length !== parts.v1.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ parts.v1.charCodeAt(i);
  return diff === 0;
}
