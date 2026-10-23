// The visitor's IP. Behind a proxy (Cloudflare Tunnel in production) the proxy's header is the
// only trustworthy source: the app is reachable only through that proxy, which overwrites it.
// Without a proxy (local dev) the socket address is used, and client-supplied headers never are.
export function clientIp(req: Request, socketAddress: string | undefined, proxyHeader: string | undefined): string | null {
  if (proxyHeader) return req.headers.get(proxyHeader) || null;
  return socketAddress ?? null;
}
