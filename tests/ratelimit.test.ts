import { expect, test } from "bun:test";
import { createRateLimiter } from "../src/ratelimit";

test("allows a burst, then refills at the per-minute rate", () => {
  let t = 0;
  const limit = createRateLimiter({ perMinute: 60, burst: 3, now: () => t });

  expect([limit("a"), limit("a"), limit("a")].every((r) => r.ok)).toBe(true);
  const denied = limit("a");
  expect(denied.ok).toBe(false);
  expect(denied.retryAfterSeconds).toBe(1);

  t += 1000;
  expect(limit("a").ok).toBe(true);
  expect(limit("a").ok).toBe(false);
});

test("keys are independent", () => {
  const limit = createRateLimiter({ perMinute: 60, burst: 1, now: () => 0 });

  expect(limit("a").ok).toBe(true);
  expect(limit("b").ok).toBe(true);
  expect(limit("a").ok).toBe(false);
});

test("forgets idle keys once their bucket is full again", () => {
  let t = 0;
  const limit = createRateLimiter({ perMinute: 60, burst: 2, now: () => t });
  limit("a");
  t += 120_000;
  limit("b");

  expect(limit.size()).toBe(1);
});
