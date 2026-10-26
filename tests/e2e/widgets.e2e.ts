// The MCP Apps views, run for real: each one is loaded into a sandboxed iframe, a page playing the
// host answers its ui/initialize and pushes a tool result, and the test reads what the view drew.
import { readFileSync } from "node:fs";
import { type FrameLocator, type Page, expect, test } from "@playwright/test";

const state: { apiKey: string } = JSON.parse(readFileSync(new URL("./.state.json", import.meta.url), "utf8"));

const mcp = async (page: Page, method: string, params: unknown) =>
  (
    await (
      await page.request.post("/mcp", {
        headers: { authorization: `Bearer ${state.apiKey}`, "content-type": "application/json" },
        data: { jsonrpc: "2.0", id: 1, method, params },
      })
    ).json()
  ).result;

// Loads a view into an iframe and returns once the host has seen ui/initialize and ui/notifications/initialized.
async function mount(page: Page, uri: string): Promise<FrameLocator> {
  const { contents } = await mcp(page, "resources/read", { uri });
  expect(contents[0].mimeType).toBe("text/html;profile=mcp-app");
  await page.goto("about:blank"); // a page with no CSP of its own: a srcdoc iframe inherits its parent's
  await page.evaluate((html) => {
    const w = window as unknown as { seen: string[] };
    w.seen = [];
    window.addEventListener("message", (e) => {
      const m = e.data;
      if (!m || m.jsonrpc !== "2.0") return;
      w.seen.push(m.method ?? "response");
      if (m.method === "ui/initialize") (e.source as Window).postMessage({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2026-01-26", hostCapabilities: {}, hostInfo: { name: "test", version: "1" }, hostContext: {} } }, "*");
    });
    const f = document.createElement("iframe");
    f.id = "view";
    f.setAttribute("sandbox", "allow-scripts");
    f.srcdoc = html;
    document.body.append(f);
  }, contents[0].text);
  await expect.poll(() => page.evaluate(() => (window as unknown as { seen: string[] }).seen)).toEqual(["ui/initialize", "ui/notifications/initialized"]);
  return page.frameLocator("#view");
}

const push = (page: Page, result: unknown) =>
  page.evaluate((r) => (document.getElementById("view") as HTMLIFrameElement).contentWindow!.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: r }, "*"), result);

test("the link card shows the title, short URL, QR code and status from a real create_link result", async ({ page }) => {
  const view = await mount(page, "ui://yoy.fyi/link-card-v1");
  const result = await mcp(page, "tools/call", { name: "create_link", arguments: { target_url: "https://example.com/widget", title: "Widget <b>test</b>", tags: ["demo"] } });
  expect(result._meta.qr_png).toMatch(/^data:image\/png;base64,/);
  await push(page, result);

  await expect(view.locator("h1")).toHaveText("Widget <b>test</b>"); // text, not parsed as HTML
  await expect(view.locator("h1 b")).toHaveCount(0);
  await expect(view.locator(".url")).toHaveText(result.structuredContent.short_url);
  await expect(view.locator(".meta").first()).toContainText("https://example.com/widget");
  await expect(view.locator(".badge")).toContainText("active");
  await expect(view.locator(".qr img")).toHaveAttribute("src", /^data:image\/png;base64,/);
  await expect(view.locator("button")).toHaveText("Copy");
});

test("the link card shows the tool's text when there is no link", async ({ page }) => {
  const view = await mount(page, "ui://yoy.fyi/link-card-v1");
  await push(page, { content: [{ type: "text", text: "validation_failed: nope" }], isError: true });
  await expect(view.locator("#root")).toHaveText("validation_failed: nope");
});

test("the link card ignores a QR that is not a PNG data URI", async ({ page }) => {
  const view = await mount(page, "ui://yoy.fyi/link-card-v1");
  await push(page, { structuredContent: { short_url: "https://yoy.fyi/x", code: "x", target_url: "https://a.example/", status: "active", tags: [] }, _meta: { qr_png: "https://evil.example/x.png" } });
  await expect(view.locator(".url")).toHaveText("https://yoy.fyi/x");
  await expect(view.locator("img")).toHaveCount(0);
});

test("the clicks chart draws one bar per point and the total", async ({ page }) => {
  const view = await mount(page, "ui://yoy.fyi/clicks-chart-v1");
  const points = Array.from({ length: 7 }, (_, i) => ({ t: `2026-10-${String(20 + i).padStart(2, "0")}T00:00:00.000Z`, clicks: i * 2, uniques: i }));
  await push(page, { structuredContent: { interval: "day", totals: { clicks: 42 }, points } });
  await expect(view.locator("h1")).toHaveText("42 clicks");
  await expect(view.locator("svg.bars rect")).toHaveCount(7);
  await expect(view.locator("svg.bars text").first()).toHaveText("2026-10-20");
  await expect(view.locator(".meta")).toHaveText("Peak 12 clicks");
});

test("the chart falls back to the tool's text when there are no points", async ({ page }) => {
  const view = await mount(page, "ui://yoy.fyi/clicks-chart-v1");
  await push(page, { structuredContent: { points: [] }, content: [{ type: "text", text: "no clicks yet" }] });
  await expect(view.locator("#root")).toHaveText("no clicks yet");
});
