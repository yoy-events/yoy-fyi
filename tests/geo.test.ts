import { expect, test } from "bun:test";
import { loadCountryLookup } from "../src/geo";

// Needs the real database: run `bun run geoip:fetch` once.
const countryOf = await loadCountryLookup("data/dbip-country-lite.mmdb");

// Exact countries of well-known IPs move between monthly releases, so assert the shape.
test("resolves a public IPv4 and IPv6 address to an ISO country code", () => {
  expect(countryOf("8.8.8.8")).toMatch(/^[A-Z]{2}$/);
  expect(countryOf("2001:4860:4860::8888")).toMatch(/^[A-Z]{2}$/);
});

test("returns null for private, unparseable or empty input", () => {
  expect(countryOf("10.0.0.1")).toBeNull();
  expect(countryOf("not-an-ip")).toBeNull();
  expect(countryOf("")).toBeNull();
});

test("refuses to start without the database file", async () => {
  expect(loadCountryLookup("data/missing.mmdb")).rejects.toThrow("data/missing.mmdb");
});
