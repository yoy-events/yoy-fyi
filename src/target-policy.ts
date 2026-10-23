import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

export type TargetRejection = "scheme" | "credentials" | "too_long" | "own_host" | "private_address" | "unresolvable";

type Options = { ownHost: string; resolve?: (host: string) => Promise<string[]> };

// Separate lists: a BlockList may match IPv4 addresses against IPv4-mapped IPv6 rules.
const blockedV4 = new BlockList();
const blockedV6 = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedV4.addSubnet(net, bits, "ipv4");
}
for (const [net, bits] of [
  ["::", 127], // :: and ::1
  ["::ffff:0:0", 96], // IPv4-mapped: never needed in a public link
  ["64:ff9b::", 96], // NAT64
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blockedV6.addSubnet(net, bits, "ipv6");
}

const isBlocked = (ip: string) => (isIP(ip) === 6 ? blockedV6.check(ip, "ipv6") : blockedV4.check(ip, "ipv4"));
const PRIVATE_NAMES = /(^|\.)(localhost|internal|local)$/;

const resolveAll = async (host: string) => (await lookup(host, { all: true })).map((a) => a.address);

// Returns why a link target is unacceptable, or null when it is fine. DNS can change after
// this check; that is accepted because the browser follows the redirect, not this server.
export async function checkTarget(raw: string, { ownHost, resolve = resolveAll }: Options): Promise<TargetRejection | null> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "scheme";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "scheme";
  if (url.username || url.password) return "credentials";
  if (raw.length > 2048) return "too_long";

  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (host === ownHost || host.endsWith(`.${ownHost}`)) return "own_host";
  if (isIP(host)) return isBlocked(host) ? "private_address" : null;
  if (PRIVATE_NAMES.test(host)) return "private_address";

  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    return "unresolvable";
  }
  if (addresses.length === 0) return "unresolvable";
  return addresses.some(isBlocked) ? "private_address" : null;
}
