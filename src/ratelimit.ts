type Options = { perMinute: number; burst: number; now?: () => number };
export type RateLimit = { perMinute: number; burst: number };

// In-memory token buckets: correct while there is one machine (ADR-0001).
export function createRateLimiter({ perMinute, burst, now = Date.now }: Options) {
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
    const bucket = buckets.get(key) ?? { tokens: burst, at: t };
    refill(bucket, t);
    buckets.set(key, bucket);
    if (bucket.tokens < 1) return { ok: false, retryAfterSeconds: Math.ceil((1 - bucket.tokens) / perMs / 1000) };
    bucket.tokens -= 1;
    return { ok: true, retryAfterSeconds: 0 };
  };

  return Object.assign(take, { size: () => buckets.size });
}
