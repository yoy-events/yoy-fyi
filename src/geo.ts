import { type CountryResponse, Reader } from "mmdb-lib";

// Loads the DB-IP Lite country database into memory. Throws when the file is missing so a
// deploy without it fails at boot instead of silently recording no countries.
export async function loadCountryLookup(path: string): Promise<(ip: string) => string | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`GeoIP database not found at ${path}`);
  const reader = new Reader<CountryResponse>(Buffer.from(await file.arrayBuffer()));

  return (ip) => {
    try {
      return reader.get(ip)?.country?.iso_code ?? null;
    } catch {
      return null;
    }
  };
}
