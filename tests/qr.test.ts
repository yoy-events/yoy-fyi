// QR styling: colours for SVG and PNG, a caption frame for SVG; valid, invalid and empty input.
import { describe, expect, test } from "bun:test";
import { qrOptions, qrSvg } from "../src/qr";

const q = (params: Record<string, string>) => qrOptions(new URLSearchParams(params));

describe("qrOptions", () => {
  test("empty means black on white with no caption", () => {
    expect(q({})).toEqual({ fg: "#000000", bg: "#ffffff", caption: null });
    expect(q({ fg: "", bg: "", caption: "  " })).toEqual({ fg: "#000000", bg: "#ffffff", caption: null });
  });

  test("valid colours and caption are kept, colours lower-cased", () => {
    expect(q({ fg: "#1A2B3C", bg: "#FFEECC", caption: "Scan me" })).toEqual({ fg: "#1a2b3c", bg: "#ffeecc", caption: "Scan me" });
  });

  test.each([
    ["a named colour", { fg: "red" }, "fg"],
    ["a short hex", { fg: "#123" }, "fg"],
    ["a bad background", { bg: "#zzzzzz" }, "bg"],
    ["too little contrast", { fg: "#dddddd", bg: "#ffffff" }, "contrast"],
    ["light on dark (scanners expect dark on light)", { fg: "#ffffff", bg: "#000000" }, "contrast"],
    ["a caption over 40 characters", { caption: "c".repeat(41) }, "caption"],
  ])("%s is an error naming the problem", (_, params, word) => {
    const r = q(params as Record<string, string>);
    expect("error" in r && r.error).toContain(word);
  });
});

describe("qrSvg", () => {
  test("uses the colours", async () => {
    const svg = await qrSvg("https://yoy.fyi/abc", { fg: "#112233", bg: "#ffeecc", caption: null });
    expect(svg).toContain('stroke="#112233"');
    expect(svg).toContain('fill="#ffeecc"');
    expect(svg).not.toContain("<text");
  });

  test("a caption adds an escaped text line below the code, inside the picture", async () => {
    const svg = await qrSvg("https://yoy.fyi/abc", { fg: "#000000", bg: "#ffffff", caption: "Scan <me> & go" });
    const [, w, h] = /viewBox="0 0 (\d+) (\d+(?:\.\d+)?)"/.exec(svg)!;
    expect(Number(h)).toBeGreaterThan(Number(w));
    expect(svg).toContain(">Scan &lt;me&gt; &amp; go</text>");
    expect(svg.match(/<svg/g)).toHaveLength(1);
  });
});
