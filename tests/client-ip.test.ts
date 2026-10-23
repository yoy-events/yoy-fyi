import { describe, expect, test } from "bun:test";
import { clientIp } from "../src/client-ip";

const req = (headers: Record<string, string> = {}) => new Request("https://yoy.fyi/x", { headers });

describe("clientIp", () => {
  test("uses the configured proxy header", () => {
    expect(clientIp(req({ "cf-connecting-ip": "203.0.113.7" }), "172.18.0.4", "cf-connecting-ip")).toBe("203.0.113.7");
  });

  test("with a proxy header configured, a request without it has no client IP", () => {
    // The socket address would be the proxy's, which would put every visitor in one bucket.
    expect(clientIp(req(), "172.18.0.4", "cf-connecting-ip")).toBeNull();
  });

  test("without a proxy header, uses the socket address and ignores client-supplied headers", () => {
    const spoofed = req({ "cf-connecting-ip": "1.1.1.1", "fly-client-ip": "2.2.2.2", "x-forwarded-for": "3.3.3.3" });
    expect(clientIp(spoofed, "198.51.100.4", undefined)).toBe("198.51.100.4");
  });

  test("without a proxy header or socket address there is no client IP", () => {
    expect(clientIp(req(), undefined, undefined)).toBeNull();
  });
});
