// WebMCP: gives a browser's built-in agent yoy.fyi tools while the user is signed in on this site
// (Chrome's document.modelContext, experimental in 2026). Each tool calls /account/agent/* with
// the user's own session. Browsers without WebMCP skip all of this. See src/webmcp.tsx.
(() => {
  const mc = document.modelContext || navigator.modelContext;
  if (!mc || typeof mc.registerTool !== "function") return;

  // Results go back as JSON text; errors as a sentence the agent can relay.
  const call = async (method, path, body) => {
    const res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return `Error ${res.status}: ${data.error || "request failed"}`;
    return JSON.stringify(data);
  };
  const enc = encodeURIComponent;
  const id = { type: "string", description: "The link id (from list_links or create_link)." };

  const tools = [
    {
      name: "create_link",
      description:
        "Create a real yoy.fyi short link for a long URL, for the signed-in user. Returns the short URL and its QR code as a PNG data URI. Never invent short URLs; use this.",
      inputSchema: {
        type: "object",
        required: ["target_url"],
        properties: {
          target_url: { type: "string", description: "The http(s) URL the short link goes to." },
          title: { type: "string" },
          code: { type: "string", description: "Custom code, 1-64 of A-Z a-z 0-9 _ -; random when omitted." },
          tags: { type: "array", items: { type: "string" } },
        },
      },
      annotations: { untrustedContentHint: true },
      execute: (input) => call("POST", "/account/agent/links", input),
    },
    {
      name: "list_links",
      description: "List the signed-in user's short links, newest first (up to 50), optionally searching code, title and target or filtering by tag.",
      inputSchema: { type: "object", properties: { q: { type: "string" }, tag: { type: "string" } } },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: (input = {}) => {
        const qs = new URLSearchParams();
        if (input.q) qs.set("q", input.q);
        if (input.tag) qs.set("tag", input.tag);
        return call("GET", `/account/agent/links?${qs}`);
      },
    },
    {
      name: "get_link",
      description: "Get one of the user's short links with its clicks in the last 30 days, top sources and countries, and its QR code.",
      inputSchema: { type: "object", required: ["id"], properties: { id } },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: (input) => call("GET", `/account/agent/links/${enc(input.id)}`),
    },
    {
      name: "disable_link",
      description: "Disable one of the user's short links: it stops redirecting. The user can enable it again on the link's page.",
      inputSchema: { type: "object", required: ["id"], properties: { id } },
      annotations: { consequentialHint: true },
      execute: (input) => call("POST", `/account/agent/links/${enc(input.id)}/disable`),
    },
  ];

  for (const tool of tools) {
    try {
      Promise.resolve(mc.registerTool(tool)).catch(() => {});
    } catch {
      // An older or different implementation of the API: leave the page as it is.
    }
  }
})();
