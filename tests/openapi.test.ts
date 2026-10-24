import { beforeAll, expect, test } from "bun:test";
import type { SQL } from "bun";
import { createApp } from "../src/app";
import { testDb } from "./helpers";

let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  const sql: SQL = await testDb();
  app = createApp({ sql, publicOrigin: "https://yoy.fyi", countryOf: () => null });
});

test("GET /v1/openapi.json serves the contract as JSON without an API key", async () => {
  const res = await app.request("https://yoy.fyi/v1/openapi.json");

  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toStartWith("application/json");
  const spec = await res.json();
  expect(spec.openapi).toStartWith("3.1");
  expect(Object.keys(spec.paths)).toContain("/v1/links");
});
