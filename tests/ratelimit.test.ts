import { expect, test } from "bun:test";
import { createRateLimiter, rateLimitKey } from "../src/ratelimit";

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

test("never holds more than maxKeys buckets, evicting the oldest", () => {
  const limit = createRateLimiter({ perMinute: 60, burst: 1, now: () => 0, maxKeys: 2 });
  limit("a");
  limit("b");
  limit("c");

  expect(limit.size()).toBe(2);
  expect(limit("c").ok).toBe(false);
});

test("keys IPv6 clients by /64 and IPv4-mapped addresses as IPv4", () => {
  expect(rateLimitKey("2001:db8:1:2:aaaa::1")).toBe(rateLimitKey("2001:db8:1:2:ffff:ffff:ffff:ffff"));
  expect(rateLimitKey("2001:db8:1:2::1")).not.toBe(rateLimitKey("2001:db8:1:3::1"));
  expect(rateLimitKey("2001:db8::1")).toBe(rateLimitKey("2001:0db8:0:0:9::"));
  expect(rateLimitKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
  expect(rateLimitKey("203.0.113.7")).toBe("203.0.113.7");
});
