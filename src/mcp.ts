// MCP over Streamable HTTP, stateless and tools-only (ADR-0003). Each tool dispatches in-process
// through the /v1 router with the caller's own credential, so validation, tenant isolation,
// idempotency, scopes and rate limits are exactly those of /v1.
import type { SQL } from "bun";
import type { Context } from "hono";
import { type Caller, authenticate } from "./keys";
import { authenticateOAuth } from "./oauth";
import { type RateLimit, createRateLimiter } from "./ratelimit";

// The /v1 router; only its in-process `request` is used.
type V1 = { request: (url: string, init: RequestInit, env: { createdVia: "mcp"; caller: Caller }) => Response | Promise<Response> };
type Deps = { sql: SQL; publicOrigin: string; v1: V1; now: () => Date; limit?: RateLimit };

// Newest first; an unknown requested version gets the newest.
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18"];
const HOURLY_MAX_MS = 7 * 86_400_000;

type Json = Record<string, unknown>;
type ToolResult = { content: { type: "text"; text: string }[]; structuredContent?: Json; isError?: boolean };
type Api = (method: string, path: string, opts?: { query?: Json; body?: Json; headers?: Record<string, string> }) => Promise<ToolResult>;

type Tool = {
  name: string;
  scope: string | null; // the OAuth scope the tool needs; null = any

  title: string;
  description: string;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: false };
  inputSchema: Json;
  outputSchema: Json;
  run: (args: Json, api: Api, caller: Caller & { sql: SQL }) => Promise<ToolResult>;
};

const toolError = (text: string): ToolResult => ({ isError: true, content: [{ type: "text", text }] });

const str = { type: "string" };
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const LINK = {
  type: "object",
  required: ["id", "code", "short_url", "target_url", "status"],
  properties: {
    id: str,
    code: str,
    short_url: str,
    target_url: str,
    title: { type: ["string", "null"] },
    tags: { type: "array", items: str },
    status: { enum: ["active", "expired", "disabled"] },
    created_via: { enum: ["api", "admin", "mcp", "web"] },
  },
};
const RANGE = {
  from: { type: "string", format: "date-time", description: "Range start (UTC), RFC 3339" },
  to: { type: "string", format: "date-time", description: "Range end (UTC), RFC 3339, exclusive" },
  link_id: { type: "string", description: "Limit to one link; default is every link of the service" },
  tag: { type: "string", description: "Limit to links with this tag" },
  bots: { enum: ["exclude", "include", "only"], description: "Default exclude" },
};
const LINK_FIELDS = {
  target_url: { type: "string", description: "http(s) URL the short link redirects to" },
  title: { type: "string" },
  tags: { type: "array", items: str },
  utm_defaults: {
    type: "object",
    description: "utm_source, utm_medium, utm_campaign, utm_term, utm_content added on redirect when absent",
  },
  pass_click_id: { type: "boolean", description: "Append yoy_sid=<click id> to the target" },
  expires_at: { type: "string", format: "date-time" },
};

const pick = (args: Json, keys: string[]) => Object.fromEntries(keys.filter((k) => args[k] !== undefined).map((k) => [k, args[k]]));
const id = (args: Json) => (typeof args.id === "string" && args.id ? encodeURIComponent(args.id) : null);

const TOOLS: Tool[] = [
  {
    name: "whoami",
    scope: null,
    title: "Show the connected service",
    description: "Returns the yoy.fyi service this connection acts for and the scopes it holds.",
    annotations: READ,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: {
      type: "object",
      required: ["service", "scopes"],
      properties: { service: { type: "object" }, scopes: { type: "array", items: str } },
    },
    // Answered from the caller itself: an OAuth grant has no API-key row for /v1/me to show.
    run: async (_, __, { sql, serviceId, scopes }) => {
      const [service] = await sql`select id, slug, name from services where id = ${serviceId}`;
      const data = { service, scopes };
      return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
    },
  },
  {
    name: "list_links",
    scope: "links:read",
    title: "List short links",
    description: "Lists this service's short links, newest first, with optional filters. Returns next_cursor for the next page.",
    annotations: READ,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        tag: str,
        code: str,
        status: { enum: ["active", "expired", "disabled"] },
        ext_service: str,
        ext_entity_type: str,
        ext_entity_id: str,
        created_after: { type: "string", format: "date-time" },
        created_before: { type: "string", format: "date-time" },
        cursor: str,
        limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
      },
    },
    outputSchema: {
      type: "object",
      required: ["data", "next_cursor"],
      properties: { data: { type: "array", items: LINK }, next_cursor: { type: ["string", "null"] } },
    },
    run: (args, api) => {
      const limit = args.limit ?? 20;
      if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 50) {
        return Promise.resolve(toolError("validation_failed: limit must be an integer from 1 to 50."));
      }
      const query = pick(args, ["tag", "code", "status", "ext_service", "ext_entity_type", "ext_entity_id", "created_after", "created_before", "cursor"]);
      return api("GET", "/links", { query: { ...query, limit } });
    },
  },
  {
    name: "get_link",
    scope: "links:read",
    title: "Get a short link",
    description: "Returns one short link of this service, looked up by id or by code (exactly one of them).",
    annotations: READ,
    inputSchema: { type: "object", additionalProperties: false, properties: { id: str, code: str } },
    outputSchema: LINK,
    run: async (args, api) => {
      if ((args.id === undefined) === (args.code === undefined)) return toolError("validation_failed: pass exactly one of id or code.");
      if (args.id !== undefined) return id(args) ? api("GET", `/links/${id(args)}`) : toolError("validation_failed: id must be a non-empty string.");
      const found = await api("GET", "/links", { query: { code: args.code, limit: 1 } });
      if (found.isError) return found;
      const link = (found.structuredContent as { data: Json[] }).data[0];
      if (!link) return toolError("not_found: no link of this service has that code.");
      return { content: [{ type: "text", text: JSON.stringify(link) }], structuredContent: link };
    },
  },
  {
    name: "create_link",
    scope: "links:write",
    title: "Create a short link",
    description:
      "Creates a yoy.fyi short link to target_url for this service. Repeating a call with the same idempotency_key, or the same external_ref, returns the existing link instead of creating another.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["target_url"],
      properties: {
        ...LINK_FIELDS,
        code: { type: "string", description: "Custom code; generated when omitted" },
        external_ref: {
          type: "object",
          required: ["service", "entity_type", "entity_id"],
          properties: { service: str, entity_type: str, entity_id: str },
        },
        idempotency_key: { type: "string", description: "1-255 characters" },
      },
    },
    outputSchema: LINK,
    run: (args, api) => {
      const { idempotency_key, ...body } = args;
      const headers: Record<string, string> = typeof idempotency_key === "string" ? { "idempotency-key": idempotency_key } : {};
      return api("POST", "/links", { body, headers });
    },
  },
  {
    name: "update_link",
    scope: "links:write",
    title: "Update a short link",
    description:
      "Changes a short link's target_url, title, tags, utm_defaults, pass_click_id or expires_at. A new target_url changes where an existing, possibly already shared link goes.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: { id: str, ...LINK_FIELDS },
    },
    outputSchema: LINK,
    run: (args, api) => {
      const { id: _, ...body } = args;
      return id(args) ? api("PATCH", `/links/${id(args)}`, { body }) : Promise.resolve(toolError("validation_failed: id is required."));
    },
  },
  {
    name: "disable_link",
    scope: "links:write",
    title: "Disable a short link",
    description: "Disables a short link: it then answers 410 to visitors. Its code is never reused.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: "object", additionalProperties: false, required: ["id"], properties: { id: str } },
    outputSchema: LINK,
    run: (args, api) =>
      id(args) ? api("POST", `/links/${id(args)}/disable`) : Promise.resolve(toolError("validation_failed: id is required.")),
  },
  {
    name: "get_click_timeseries",
    scope: "analytics:read",
    title: "Get clicks over time",
    description: "Returns click and unique-visitor counts per UTC hour or day. Hourly ranges are limited to 7 days here.",
    annotations: READ,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["from", "to", "interval"],
      properties: { ...RANGE, interval: { enum: ["hour", "day"] } },
    },
    outputSchema: {
      type: "object",
      required: ["interval", "from", "to", "totals", "points"],
      properties: { totals: { type: "object" }, points: { type: "array", items: { type: "object" } } },
    },
    run: (args, api) => {
      const span = Date.parse(String(args.to)) - Date.parse(String(args.from));
      if (args.interval === "hour" && span > HOURLY_MAX_MS) {
        return Promise.resolve(toolError("range_too_large: hourly ranges are limited to 7 days; use interval day."));
      }
      return api("GET", "/analytics/timeseries", { query: pick(args, ["from", "to", "interval", "link_id", "tag", "bots"]) });
    },
  },
  {
    name: "get_click_breakdown",
    scope: "analytics:read",
    title: "Get top click sources",
    description:
      "Returns the top values of one dimension (referer_host, utm_source, utm_medium, utm_campaign, country, device, browser, os) with click counts.",
    annotations: READ,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["from", "to", "dimension"],
      properties: {
        ...RANGE,
        dimension: { enum: ["referer_host", "utm_source", "utm_medium", "utm_campaign", "country", "device", "browser", "os"] },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 10 },
      },
    },
    outputSchema: {
      type: "object",
      required: ["dimension", "total_clicks", "other_clicks", "items"],
      properties: { items: { type: "array", items: { type: "object" } } },
    },
    run: (args, api) =>
      api("GET", "/analytics/breakdown", { query: { limit: 10, ...pick(args, ["from", "to", "dimension", "link_id", "tag", "bots", "limit"]) } }),
  },
];

// securitySchemes tells ChatGPT which OAuth scope each tool needs.
const listed = TOOLS.map(({ run: _, scope, ...tool }) => ({
  ...tool,
  securitySchemes: [{ type: "oauth2", scopes: scope ? [scope] : [] }],
}));

const rpcError = (c: Context, status: 200 | 400, id: unknown, code: number, message: string) =>
  c.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, status);

export function mcpRoutes({ sql, publicOrigin, v1, now, limit = { perMinute: 120, burst: 60 } }: Deps) {
  const limitCalls = createRateLimiter(limit);
  const resourceMetadata = `${publicOrigin}/.well-known/oauth-protected-resource/mcp`;

  const apiFor =
    (caller: Caller): Api =>
    async (method, path, opts = {}) => {
      // The /v1 router is mounted at /v1, so its own routes start at "/".
      const url = new URL(`${publicOrigin}${path}`);
      for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
      const res = await v1.request(
        url.toString(),
        {
          method,
          headers: { "content-type": "application/json", ...opts.headers },
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        },
        { createdVia: "mcp", caller },
      );
      const json = (await res.json()) as Json;
      if (!res.ok) {
        const e = (json.error ?? {}) as { code?: string; message?: string; details?: unknown };
        const details = e.details ? ` ${JSON.stringify(e.details)}` : "";
        return toolError(`${e.code ?? "internal"}: ${e.message ?? `HTTP ${res.status}`}${details}`);
      }
      return { content: [{ type: "text", text: JSON.stringify(json) }], structuredContent: json };
    };

  return async (c: Context) => {
    const origin = c.req.header("origin");
    if (origin && origin !== publicOrigin) return c.json({ error: { code: "forbidden", message: "Origin not allowed." } }, 403);

    const authorization = c.req.header("authorization") ?? "";
    const caller: Caller | null = (await authenticateOAuth(sql, authorization, now())) ?? (await authenticate(sql, authorization));
    if (!caller) {
      c.header("WWW-Authenticate", `Bearer resource_metadata="${resourceMetadata}"`);
      return c.json({ error: { code: "unauthorized", message: "Missing, unknown or revoked credential." } }, 401);
    }
    const quota = limitCalls(caller.keyId);
    if (!quota.ok) {
      c.header("Retry-After", String(quota.retryAfterSeconds));
      return c.json({ error: { code: "rate_limited", message: "Too many MCP calls for this credential." } }, 429);
    }

    let msg: unknown;
    try {
      msg = JSON.parse(await c.req.text());
    } catch {
      return rpcError(c, 400, null, -32700, "Parse error");
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) return rpcError(c, 400, null, -32600, "Invalid request: send one JSON-RPC object.");
    const { jsonrpc, id: reqId, method, params } = msg as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: Json };
    if (jsonrpc !== "2.0" || typeof method !== "string") return rpcError(c, 400, reqId, -32600, "Invalid request");
    if (reqId === undefined) return c.body(null, 202); // a notification: nothing to answer

    const ok = (result: unknown) => c.json({ jsonrpc: "2.0", id: reqId, result });
    switch (method) {
      case "initialize": {
        const asked = params?.protocolVersion;
        return ok({
          protocolVersion: PROTOCOL_VERSIONS.includes(asked as string) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: "yoy.fyi", version: "1.0.0" },
          instructions: "Short links and click analytics for one yoy.fyi service.",
        });
      }
      case "ping":
        return ok({});
      case "tools/list":
        return ok({ tools: listed });
      case "tools/call": {
        const tool = TOOLS.find((t) => t.name === params?.name);
        const args = params?.arguments ?? {};
        if (!tool) return rpcError(c, 200, reqId, -32602, `Unknown tool: ${String(params?.name)}`);
        if (typeof args !== "object" || Array.isArray(args)) return rpcError(c, 200, reqId, -32602, "arguments must be an object");
        const result = await tool.run(args as Json, apiFor(caller), { ...caller, sql });
        console.log(JSON.stringify({ mcp: tool.name, service: caller.serviceId, ok: !result.isError }));
        return ok(result);
      }
      default:
        return rpcError(c, 200, reqId, -32601, `Method not found: ${method}`);
    }
  };
}
