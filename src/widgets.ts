// MCP Apps (the open standard ChatGPT and Claude implement): two small interactive views that
// chats render under a tool's result, in a sandboxed iframe. A tool names a view in
// _meta.ui.resourceUri; the host reads it with resources/read and pushes the tool result to it
// over postMessage. Clients without MCP Apps just show the tool's normal text result.
// Spec: modelcontextprotocol/ext-apps, specification/2026-01-26/apps.mdx.

export const UI_MIME = "text/html;profile=mcp-app";
// The URI is a cache key for hosts: publish a new one after any breaking change to a view.
export const LINK_CARD_URI = "ui://yoy.fyi/link-card-v1";
export const CLICKS_CHART_URI = "ui://yoy.fyi/clicks-chart-v1";

// The host side of the protocol, shared by both views. `render(result)` is defined by the view.
// Everything from the server is put in with textContent, and the QR is an <img> with a data: URI
// (the default policy of the iframe allows data: images), so no server text is ever parsed as HTML.
const BRIDGE = `
const pending = new Map();
let nextId = 1;
const send = (msg) => window.parent.postMessage({ jsonrpc: "2.0", ...msg }, "*");
const request = (method, params) => new Promise((resolve) => { const id = nextId++; pending.set(id, resolve); send({ id, method, params }); });
window.addEventListener("message", (e) => {
  if (e.source !== window.parent) return;
  const m = e.data;
  if (!m || m.jsonrpc !== "2.0") return;
  if (m.method === undefined && m.id !== undefined) { pending.get(m.id)?.(m.result); pending.delete(m.id); return; }
  if (m.id !== undefined) { send({ id: m.id, result: {} }); return; } // a request from the host (ping, teardown): answer it
  if (m.method === "ui/notifications/tool-result") render(m.params || {});
});
request("ui/initialize", { protocolVersion: "2026-01-26", appInfo: { name: "yoy.fyi", version: "1.0.0" }, appCapabilities: {} })
  .then(() => send({ method: "ui/notifications/initialized" }));
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
`;

const STYLE = `
:root { color-scheme: light dark; --fg: #1d1d1f; --muted: #6e6e73; --line: #d2d2d7; --bg: #ffffff; --accent: #2563eb; }
@media (prefers-color-scheme: dark) { :root { --fg: #f5f5f7; --muted: #a1a1a6; --line: #3a3a3c; --bg: #1c1c1e; --accent: #60a5fa; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 12px; font: 14px/1.4 system-ui, sans-serif; color: var(--fg); background: transparent; }
.card { display: flex; gap: 14px; align-items: flex-start; flex-wrap: wrap; }
.qr { width: 120px; height: 120px; flex: none; border: 1px solid var(--line); border-radius: 8px; background: #fff; padding: 4px; }
.qr img { width: 100%; height: 100%; display: block; image-rendering: pixelated; }
.info { flex: 1; min-width: 200px; display: grid; gap: 6px; }
h1 { margin: 0; font-size: 16px; }
.row { display: flex; gap: 8px; align-items: center; }
.url { flex: 1; min-width: 0; font: 600 15px ui-monospace, monospace; color: var(--accent); overflow-wrap: anywhere; }
.meta { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
button { font: inherit; padding: 4px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--fg); cursor: pointer; }
.badge { font-size: 11px; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); }
svg.bars { width: 100%; height: 120px; display: block; }
svg.bars rect { fill: var(--accent); }
svg.bars text { fill: var(--muted); font-size: 10px; }
`;

const page = (title: string, body: string, script: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${STYLE}</style></head><body>${body}<script>${BRIDGE}${script}</script></body></html>`;

const LINK_CARD = page(
  "yoy.fyi link",
  `<div id="root" class="meta">…</div>`,
  `
function render(result) {
  const link = result.structuredContent;
  const root = document.getElementById("root");
  root.className = "";
  root.replaceChildren();
  if (!link || !link.short_url) { root.className = "meta"; root.textContent = (result.content && result.content[0] && result.content[0].text) || ""; return; }
  const card = el("div", "card");
  const png = result._meta && result._meta.qr_png;
  if (typeof png === "string" && png.startsWith("data:image/png;base64,")) {
    const q = el("div", "qr");
    const img = el("img");
    img.alt = "QR code for " + link.short_url;
    img.src = png;
    q.append(img);
    card.append(q);
  }
  const info = el("div", "info");
  info.append(el("h1", "", link.title || link.code));
  const row = el("div", "row");
  const url = el("div", "url", link.short_url);
  const copy = el("button", "", "Copy");
  copy.onclick = async () => {
    try { await navigator.clipboard.writeText(link.short_url); copy.textContent = "Copied"; }
    catch { const r = document.createRange(); r.selectNodeContents(url); const s = getSelection(); s.removeAllRanges(); s.addRange(r); copy.textContent = "Select and copy"; }
    setTimeout(() => (copy.textContent = "Copy"), 2000);
  };
  row.append(url, copy);
  info.append(row, el("div", "meta", "→ " + link.target_url));
  const tags = Array.isArray(link.tags) && link.tags.length ? " · " + link.tags.join(", ") : "";
  info.append(el("span", "badge", link.status + tags));
  card.append(info);
  root.append(card);
}
`,
);

const CLICKS_CHART = page(
  "yoy.fyi clicks",
  `<div id="root" class="meta">…</div>`,
  `
function render(result) {
  const data = result.structuredContent;
  const root = document.getElementById("root");
  root.replaceChildren();
  if (!data || !Array.isArray(data.points) || data.points.length === 0) { root.className = "meta"; root.textContent = (result.content && result.content[0] && result.content[0].text) || ""; return; }
  root.className = "";
  const total = data.totals && typeof data.totals.clicks === "number" ? data.totals.clicks : data.points.reduce((n, p) => n + p.clicks, 0);
  root.append(el("h1", "", total + " clicks"));
  const W = 600, H = 100, n = data.points.length;
  const max = Math.max(1, ...data.points.map((p) => p.clicks));
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 " + W + " " + (H + 16));
  svg.setAttribute("class", "bars");
  svg.setAttribute("preserveAspectRatio", "none");
  data.points.forEach((p, i) => {
    const h = Math.round((p.clicks / max) * H);
    const r = document.createElementNS(NS, "rect");
    r.setAttribute("x", String((i * W) / n));
    r.setAttribute("y", String(H - h));
    r.setAttribute("width", String(Math.max(W / n - 1, 1)));
    r.setAttribute("height", String(h));
    const t = document.createElementNS(NS, "title");
    t.textContent = String(p.t).slice(0, 16).replace("T", " ") + ": " + p.clicks;
    r.append(t);
    svg.append(r);
  });
  const label = (x, anchor, text) => { const t = document.createElementNS(NS, "text"); t.setAttribute("x", String(x)); t.setAttribute("y", String(H + 13)); t.setAttribute("text-anchor", anchor); t.textContent = text; svg.append(t); };
  label(0, "start", String(data.points[0].t).slice(0, 10));
  label(W, "end", String(data.points[n - 1].t).slice(0, 10));
  root.append(svg, el("div", "meta", "Peak " + max + " clicks"));
}
`,
);

export const VIEWS = [
  { uri: LINK_CARD_URI, name: "Short link card", description: "A short link with its QR code and a copy button.", html: LINK_CARD },
  { uri: CLICKS_CHART_URI, name: "Clicks chart", description: "A bar chart of clicks over time.", html: CLICKS_CHART },
] as const;

export const viewResources = () => VIEWS.map(({ uri, name, description }) => ({ uri, name, description, mimeType: UI_MIME }));

export function readView(uri: unknown) {
  const view = VIEWS.find((v) => v.uri === uri);
  if (!view) return null;
  return {
    contents: [
      {
        uri: view.uri,
        mimeType: UI_MIME,
        text: view.html,
        // No network access at all: the views draw from the tool result only.
        _meta: { ui: { prefersBorder: true, permissions: { clipboardWrite: {} } } },
      },
    ],
  };
}
