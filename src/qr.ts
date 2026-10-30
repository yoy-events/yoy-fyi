// QR codes for short links, in the owner's colours and optionally with a caption under the code
// ("Scan me"). The caption exists only in the SVG: rendering text into the PNG would need fonts.
import QRCode from "qrcode";

export type QrStyle = { fg: string; bg: string; caption: string | null };

const HEX = /^#[0-9a-f]{6}$/;
const MAX_CAPTION = 40;
// Characters XML does not allow at all, even escaped; the caption drops them.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
const NOT_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g;

// WCAG relative luminance.
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};

// Reads fg, bg and caption from a query. Scanners need dark modules on a light background with
// clear contrast, so other combinations are refused.
// What is wrong with a style; the pages and tools word it in their own language.
export type QrError = "fg" | "bg" | "contrast" | "caption";

export function qrOptions(query: URLSearchParams): QrStyle | { error: QrError } {
  const fg = (query.get("fg") || "#000000").toLowerCase();
  const bg = (query.get("bg") || "#ffffff").toLowerCase();
  const caption = (query.get("caption") ?? "").replace(NOT_XML, "").trim() || null;
  if (!HEX.test(fg)) return { error: "fg" };
  if (!HEX.test(bg)) return { error: "bg" };
  if (luminance(fg) >= luminance(bg) || (luminance(bg) + 0.05) / (luminance(fg) + 0.05) < 3) {
    return { error: "contrast" };
  }
  if (caption && caption.length > MAX_CAPTION) return { error: "caption" };
  return { fg, bg, caption };
}

const escapeXml = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);

export async function qrSvg(url: string, { fg, bg, caption }: QrStyle): Promise<string> {
  const svg = await QRCode.toString(url, { type: "svg", margin: 2, color: { dark: fg, light: bg } });
  if (!caption) return svg;
  // Extend the picture by four modules and write the caption there, sized to fit the width.
  const size = Number(/viewBox="0 0 (\d+) /.exec(svg)![1]);
  const inner = svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  const fontSize = Math.min(2.6, (size - 4) / (caption.length * 0.62));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size + 4}" shape-rendering="crispEdges"><rect width="${size}" height="${size + 4}" fill="${bg}"/>${inner}<text x="${size / 2}" y="${size + 1.5}" font-family="Helvetica, Arial, sans-serif" font-weight="700" font-size="${fontSize.toFixed(2)}" text-anchor="middle" fill="${fg}">${escapeXml(caption)}</text></svg>`;
}

export const qrPng = async (url: string, { fg, bg }: QrStyle, width = 1024) =>
  new Uint8Array(await QRCode.toBuffer(url, { type: "png", width, margin: 2, color: { dark: fg, light: bg } }));
