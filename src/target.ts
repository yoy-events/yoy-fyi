const CLICK_ID_PARAM = "yoy_sid";

// Precedence: the target's own params, then the visitor's query params, then the link's
// UTM defaults. Nothing earlier in that list is overwritten. A visitor cannot set yoy_sid.
export function buildTarget(
  target: string,
  incoming: URLSearchParams,
  utmDefaults: Record<string, string> | null,
  clickId: string | null,
): string {
  const url = new URL(target);
  const params = url.searchParams;
  const before = params.toString();

  const own = new Set(params.keys());
  for (const [key, value] of incoming) {
    if (!own.has(key) && key !== CLICK_ID_PARAM) params.append(key, value);
  }
  for (const [key, value] of Object.entries(utmDefaults ?? {})) {
    if (!params.has(key)) params.append(key, value);
  }
  if (clickId) params.set(CLICK_ID_PARAM, clickId);

  return params.toString() === before ? target : url.toString();
}
