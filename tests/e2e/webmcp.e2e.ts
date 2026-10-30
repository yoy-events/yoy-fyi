// /static/webmcp.js in a real browser: with a stand-in document.modelContext it registers the four
// tools with the right annotations, and each tool calls the site's agent endpoints. Without the API
// it does nothing.
import { type Page, expect, test } from "@playwright/test";

type Registered = { name: string; annotations?: Record<string, boolean>; execute: (input: unknown) => Promise<string> };

// A page of ours (so the script's same-origin fetches resolve), with the endpoints answered here.
async function load(page: Page, withApi: boolean) {
  if (withApi) {
    await page.addInitScript(() => {
      const w = window as unknown as { registered: unknown[] };
      w.registered = [];
      Object.defineProperty(document, "modelContext", { value: { registerTool: (t: unknown) => w.registered.push(t) } });
    });
  }
  const calls: string[] = [];
  await page.route("**/account/agent/**", async (route) => {
    const r = route.request();
    calls.push(`${r.method()} ${new URL(r.url()).pathname}${new URL(r.url()).search} ${r.postData() ?? ""}`.trim());
    await route.fulfill({ status: r.url().includes("nope") ? 404 : 200, json: r.url().includes("nope") ? { error: "Link not found." } : { ok: true } });
  });
  await page.goto("/privacy");
  await page.addScriptTag({ url: "/static/webmcp.js" });
  return calls;
}

test("registers the four tools with their annotations", async ({ page }) => {
  await load(page, true);
  const tools = await page.evaluate(() => (window as unknown as { registered: Registered[] }).registered.map((t) => ({ name: t.name, annotations: t.annotations })));
  expect(tools).toEqual([
    { name: "create_link", annotations: { untrustedContentHint: true } },
    { name: "list_links", annotations: { readOnlyHint: true, untrustedContentHint: true } },
    { name: "get_link", annotations: { readOnlyHint: true, untrustedContentHint: true } },
    { name: "disable_link", annotations: { consequentialHint: true } },
  ]);
});

test("each tool calls its endpoint and returns the answer as text, errors as a sentence", async ({ page }) => {
  const calls = await load(page, true);
  const results = await page.evaluate(async () => {
    const t = Object.fromEntries((window as unknown as { registered: Registered[] }).registered.map((x) => [x.name, x]));
    return [
      await t.create_link!.execute({ target_url: "https://example.com/" }),
      await t.list_links!.execute({ q: "gig", tag: "music" }),
      await t.get_link!.execute({ id: "abc/../x" }),
      await t.disable_link!.execute({ id: "nope" }),
    ];
  });
  expect(results.slice(0, 3)).toEqual(['{"ok":true}', '{"ok":true}', '{"ok":true}']);
  expect(results[3]).toBe("Error 404: Link not found.");
  expect(calls).toEqual([
    'POST /account/agent/links {"target_url":"https://example.com/"}',
    "GET /account/agent/links ?q=gig&tag=music".replace(" ?", "?"),
    "GET /account/agent/links/abc%2F..%2Fx",
    "POST /account/agent/links/nope/disable",
  ]);
});

test("without document.modelContext the script does nothing and throws nothing", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const calls = await load(page, false);
  expect(errors).toEqual([]);
  expect(calls).toEqual([]);
});
