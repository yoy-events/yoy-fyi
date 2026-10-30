import { describe, expect, test } from "bun:test";
import { checkTarget } from "../src/target-policy";

const publicDns = async () => ["93.184.215.14"];
const check = (url: string, resolve = publicDns) => checkTarget(url, { ownHost: "yoy.fyi", resolve });

describe("checkTarget", () => {
  test("accepts public http and https URLs", async () => {
    expect(await check("https://example.com/a?b=1")).toBeNull();
    expect(await check("http://example.com")).toBeNull();
  });

  test("accepts public IP literals without a DNS lookup", async () => {
    const noDns = async (): Promise<string[]> => {
      throw new Error("should not resolve");
    };
    expect(await check("http://93.184.215.14/", noDns)).toBeNull();
    expect(await check("http://[2606:2800:21f:cb07:6820:80da:af6b:8b2c]/", noDns)).toBeNull();
    // Next to the Teredo prefix 2001::/32 but outside it.
    expect(await check("http://[2001:4860:4860::8888]/", noDns)).toBeNull();
  });

  test.each(["javascript:alert(1)", "data:text/html,hi", "ftp://example.com/", "mailto:a@b.c", "not a url"])(
    "rejects %s as scheme",
    async (url) => {
      expect(await check(url)).toBe("scheme");
    },
  );

  test("rejects credentials in the URL", async () => {
    expect(await check("https://user:pass@example.com/")).toBe("credentials");
    expect(await check("https://user@example.com/")).toBe("credentials");
  });

  test("rejects URLs longer than 2048 characters", async () => {
    expect(await check(`https://example.com/${"a".repeat(2048)}`)).toBe("too_long");
  });

  test.each(["https://yoy.fyi/abc", "https://YOY.FYI/abc", "https://a.yoy.fyi/x", "https://yoy.fyi./x"])(
    "rejects own host %s",
    async (url) => {
      expect(await check(url)).toBe("own_host");
    },
  );

  test("does not confuse a lookalike domain with the own host", async () => {
    expect(await check("https://notyoy.fyi/")).toBeNull();
  });

  test.each([
    "http://127.0.0.1/",
    "http://2130706433/",
    "http://10.1.2.3/",
    "http://172.16.0.1/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data",
    "http://100.64.0.1/",
    "http://0.0.0.0/",
    "http://[::1]/",
    "http://[fd00::1]/",
    "http://[fe80::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[2002:7f00:1::1]/", // 6to4 around 127.0.0.1
    "http://[2001:0:a00:1::1]/", // Teredo
    "http://localhost:3000/",
    "http://api.localhost/",
    "http://db.internal/",
    "http://printer.local/",
  ])("rejects private address %s", async (url) => {
    expect(await check(url)).toBe("private_address");
  });

  test("rejects a hostname that resolves to a private address", async () => {
    expect(await check("https://sneaky.example.com/", async () => ["93.184.215.14", "10.0.0.5"])).toBe(
      "private_address",
    );
  });

  test("rejects a hostname that does not resolve", async () => {
    const fail = async (): Promise<string[]> => {
      throw new Error("ENOTFOUND");
    };
    expect(await check("https://no-such-host.example/", fail)).toBe("unresolvable");
  });
});
