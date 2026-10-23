import { describe, expect, test } from "bun:test";
import { buildTarget } from "../src/target";

const none = new URLSearchParams();

describe("buildTarget", () => {
  test("returns the target unchanged when there is nothing to add", () => {
    expect(buildTarget("https://example.com/a?x=1#top", none, null, null)).toBe("https://example.com/a?x=1#top");
  });

  test("appends UTM defaults that the target does not already have", () => {
    const url = buildTarget("https://example.com/?utm_source=site", none, { utm_source: "ig", utm_medium: "bio" }, null);

    const params = new URL(url).searchParams;
    expect(params.get("utm_source")).toBe("site");
    expect(params.get("utm_medium")).toBe("bio");
  });

  test("forwards incoming query params without overwriting the target's own", () => {
    const incoming = new URLSearchParams("fbclid=FB1&x=from-visitor");
    const params = new URL(buildTarget("https://example.com/?x=1", incoming, null, null)).searchParams;

    expect(params.get("fbclid")).toBe("FB1");
    expect(params.getAll("x")).toEqual(["1"]);
  });

  test("incoming UTM params beat the link's UTM defaults", () => {
    const incoming = new URLSearchParams("utm_source=tg");
    const url = buildTarget("https://example.com/", incoming, { utm_source: "ig", utm_campaign: "fall" }, null);

    const params = new URL(url).searchParams;
    expect(params.get("utm_source")).toBe("tg");
    expect(params.get("utm_campaign")).toBe("fall");
  });

  test("appends yoy_sid when a click id is given, replacing any existing value", () => {
    const incoming = new URLSearchParams("yoy_sid=forged");
    const url = buildTarget("https://example.com/?yoy_sid=old", incoming, null, "click-1");

    expect(new URL(url).searchParams.getAll("yoy_sid")).toEqual(["click-1"]);
  });

  test("never forwards an incoming yoy_sid", () => {
    const incoming = new URLSearchParams("yoy_sid=forged");

    expect(buildTarget("https://example.com/", incoming, null, null)).toBe("https://example.com/");
  });

  test("keeps the fragment after the query", () => {
    expect(buildTarget("https://example.com/p#frag", none, { utm_source: "ig" }, null)).toBe(
      "https://example.com/p?utm_source=ig#frag",
    );
  });
});
