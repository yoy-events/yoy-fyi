// Google Safe Browsing (Lookup API v4): link targets are checked when created or changed, and
// once a day for every active link, so a target that turns malicious later is taken down.
import type { SQL } from "bun";

// Returns the subset of `urls` that Safe Browsing lists as unsafe.
export type UnsafeUrls = (urls: string[]) => Promise<Set<string>>;

const ENDPOINT = "https://safebrowsing.googleapis.com/v4/threatMatches:find";
const BATCH = 500; // the API's limit of threat entries per request

// Fails open: when the API is down or over quota, nothing is flagged and the error is logged.
// The daily rescan catches what slipped through.
export function safeBrowsing(apiKey: string, post: (url: string, init: RequestInit) => Promise<Response> = fetch): UnsafeUrls {
  return async (urls) => {
    const unsafe = new Set<string>();
    for (let i = 0; i < urls.length; i += BATCH) {
      const batch = urls.slice(i, i + BATCH);
      try {
        const res = await post(`${ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: AbortSignal.timeout(5000),
          body: JSON.stringify({
            client: { clientId: "yoy-fyi", clientVersion: "1" },
            threatInfo: {
              threatTypes: ["MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE", "POTENTIALLY_HARMFUL_APPLICATION"],
              platformTypes: ["ANY_PLATFORM"],
              threatEntryTypes: ["URL"],
              threatEntries: batch.map((url) => ({ url })),
            },
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { matches?: { threat?: { url?: string } }[] };
        for (const m of body.matches ?? []) if (m.threat?.url) unsafe.add(m.threat.url);
      } catch (err) {
        console.error("safe browsing check failed", String(err));
      }
    }
    return unsafe;
  };
}

// Takes down links whose target is now listed as unsafe: active ones, and ones only their owner
// disabled (so the owner cannot simply enable them again). Returns how many it took down.
export async function rescanLinks(sql: SQL, unsafeUrls: UnsafeUrls, now: Date): Promise<number> {
  const rows: { target_url: string }[] = await sql`
    select distinct target_url from links
    where (disabled_at is null or disabled_by = 'owner') and (expires_at is null or expires_at > ${now})`;
  if (rows.length === 0) return 0;
  const unsafe = [...(await unsafeUrls(rows.map((r) => r.target_url)))];
  if (unsafe.length === 0) return 0;
  const disabled = await sql`
    update links set disabled_at = coalesce(disabled_at, ${now}), disabled_by = 'safe_browsing', updated_at = ${now}
    where (disabled_at is null or disabled_by = 'owner') and target_url in ${sql(unsafe)}
    returning id, code, target_url`;
  for (const l of disabled) console.warn("link disabled: unsafe target", { id: l.id, code: l.code, target_url: l.target_url });
  return disabled.length;
}
