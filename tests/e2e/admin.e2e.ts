import { type Page, expect, test } from "@playwright/test";
import state from "./.state.json" with { type: "json" };

test.describe.configure({ mode: "serial" });

let page: Page;
const cspErrors: string[] = [];

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  page.on("console", (m) => {
    if (m.type() === "error" && m.text().includes("Content Security Policy")) cspErrors.push(m.text());
  });
});

test.afterAll(() => expect(cspErrors).toEqual([]));

const noHorizontalScroll = async () =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);

test("signs in through the emailed link", async () => {
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/login$/);

  await page.goto(`/admin/login/verify?token=${state.loginToken}`);
  await page.getByRole("button", { name: "Continue to admin" }).click();

  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole("heading", { name: "Services" })).toBeVisible();
  await expect(page.getByRole("link", { name: "e2e" })).toBeVisible();
  await noHorizontalScroll();
});

test("creates an API key and shows it once", async () => {
  await page.getByLabel("Service").fill("e2e");
  await page.getByLabel("Key name").fill("from-admin");
  await page.getByLabel("links:read").check();
  await page.getByRole("button", { name: "Create key" }).click();

  await expect(page.getByText(/yfi_[A-Za-z0-9]{8}_[A-Za-z0-9]{32}/)).toBeVisible();
  await expect(page.getByText("shown only once")).toBeVisible();
  await noHorizontalScroll();
});

test("creates a link from the service page and shows its analytics page", async () => {
  await page.goto("/admin/services/e2e");
  await page.getByLabel("Target URL").fill("https://example.com/e2e-landing");
  await page.getByLabel("Custom code (optional)").fill("e2e-link");
  await page.getByLabel("utm_source").fill("e2e");
  await page.getByRole("button", { name: "Create link" }).click();

  await expect(page.getByText("http://localhost:3998/e2e-link")).toBeVisible();
  const qr = page.getByRole("img", { name: /QR code/ });
  await expect(qr).toBeVisible();
  expect(await qr.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await expect(page.getByRole("heading", { name: "Daily" })).toBeVisible();
  await noHorizontalScroll();
});

test("the short link redirects to its target with UTM defaults", async ({ request }) => {
  const res = await request.get("/e2e-link", { maxRedirects: 0 });

  expect(res.status()).toBe(302);
  expect(res.headers().location).toBe("https://example.com/e2e-landing?utm_source=e2e");
});

test("disabling the link makes it answer 410", async ({ request }) => {
  await page.getByRole("button", { name: "Disable link" }).click();

  await expect(page.getByText("disabled", { exact: true })).toBeVisible();
  expect((await request.get("/e2e-link", { maxRedirects: 0 })).status()).toBe(410);
});

test("links created through the API show up in the admin", async ({ request }) => {
  const res = await request.post("/v1/links", {
    headers: { authorization: `Bearer ${state.apiKey}` },
    data: { target_url: "https://example.com/from-api", code: "from-api" },
  });
  expect(res.status()).toBe(201);

  await page.goto("/admin/services/e2e");
  await expect(page.getByRole("link", { name: "from-api" })).toBeVisible();
});
