type Options = { perMinute: number; burst: number; now?: () => number; maxKeys?: number };
export type RateLimit = { perMinute: number; burst: number };

// One client controls a whole IPv6 /64, so it shares one bucket. IPv4-mapped IPv6 is IPv4.
export function rateLimitKey(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1]!;
  if (!ip.includes(":")) return ip;
  const [head = "", tail] = ip.toLowerCase().split("%")[0]!.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  return `${groups
    .slice(0, 4)
    .map((g) => g.padStart(4, "0"))
    .join(":")}::/64`;
}

// In-memory token buckets: correct while there is one machine (ADR-0001). At most `maxKeys`
// buckets are held; past that the oldest is evicted, which bounds memory under a flood.
export function createRateLimiter({ perMinute, burst, now = Date.now, maxKeys = 100_000 }: Options) {
  const perMs = perMinute / 60_000;
  const buckets = new Map<string, { tokens: number; at: number }>();
  let sweptAt = now();

  const refill = (b: { tokens: number; at: number }, t: number) => {
    b.tokens = Math.min(burst, b.tokens + (t - b.at) * perMs);
    b.at = t;
  };

  const take = (key: string): { ok: boolean; retryAfterSeconds: number } => {
    const t = now();
    if (t - sweptAt >= 60_000) {
      for (const [k, b] of buckets) {
        refill(b, t);
        if (b.tokens >= burst) buckets.delete(k);
      }
      sweptAt = t;
    }
    let bucket = buckets.get(key);
    if (!bucket) {
      if (buckets.size >= maxKeys) buckets.delete(buckets.keys().next().value!);
      bucket = { tokens: burst, at: t };
      buckets.set(key, bucket);
    }
    refill(bucket, t);
    if (bucket.tokens < 1) return { ok: false, retryAfterSeconds: Math.ceil((1 - bucket.tokens) / perMs / 1000) };
    bucket.tokens -= 1;
    return { ok: true, retryAfterSeconds: 0 };
  };

  return Object.assign(take, { size: () => buckets.size });
}
