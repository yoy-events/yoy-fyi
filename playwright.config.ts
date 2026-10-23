import { defineConfig, devices } from "@playwright/test";

const PORT = 3998;

// Run with `bun run test:e2e`, which seeds a fresh database first (tests/e2e/seed.ts).
export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "*.e2e.ts",
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    ...devices["Pixel 7"],
    viewport: { width: 375, height: 812 },
  },
  webServer: {
    command: "bun src/server.ts",
    url: `http://localhost:${PORT}/health`,
    reuseExistingServer: false,
    env: {
      PORT: String(PORT),
      PUBLIC_ORIGIN: `http://localhost:${PORT}`,
      DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:55433/yoy_fyi_e2e",
      ADMIN_EMAIL: "e2e@example.com",
      MAIL_FROM: "e2e@example.com",
      SESSION_SECRET: "e2e-session-secret-that-is-long-enough",
      RESEND_API_KEY: "re_unused_in_e2e",
      WEBHOOK_ENC_KEY: Buffer.alloc(32, 7).toString("base64"),
    },
  },
});
