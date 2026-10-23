#!/usr/bin/env bash
# Downloads the DB-IP Lite country database (CC BY 4.0, https://db-ip.com) to
# data/dbip-country-lite.mmdb. Tries this month's release, then last month's,
# because a new month's file appears a day or two after the month starts.
set -euo pipefail

out="${1:-data/dbip-country-lite.mmdb}"
mkdir -p "$(dirname "$out")"

for month in "$(date -u +%Y-%m)" "$(date -u -v-1m +%Y-%m 2>/dev/null || date -u -d '1 month ago' +%Y-%m)"; do
  url="https://download.db-ip.com/free/dbip-country-lite-${month}.mmdb.gz"
  if curl -fsSL "$url" | gunzip > "$out.tmp"; then
    mv "$out.tmp" "$out"
    echo "geoip: $url -> $out"
    exit 0
  fi
done

rm -f "$out.tmp"
echo "geoip: no release found" >&2
exit 1
