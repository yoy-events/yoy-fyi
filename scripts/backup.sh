#!/usr/bin/env bash
# Daily backup of the yoy-fyi database to Cloudflare R2. Runs as the `backup` service of
# compose.prod.yml, which sets PGHOST/PGUSER/PGDATABASE and the secrets from
# /etc/yoy-fyi/<stage>/{db,backup}.env. Without R2_BUCKET it only logs that backups are off.
#
# One file per UTC day, yoy_fyi-YYYY-MM-DD.sql.gz: a later run the same day replaces it, and only
# when pg_dump finished and the gzip is intact, so a failed run never overwrites a good backup.
# Files older than BACKUP_KEEP_DAYS (default 30) are deleted.
set -euo pipefail

log() { echo "backup: $*"; }

if [ -z "${R2_BUCKET:-}" ]; then
  log "R2_BUCKET is not set, backups are off"
  [ -n "${BACKUP_ONCE:-}" ] && exit 0
  exec sleep infinity
fi

export PGPASSWORD="${PGPASSWORD:-${POSTGRES_PASSWORD:-}}"
export RCLONE_CONFIG_R2_TYPE=s3
export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
export RCLONE_CONFIG_R2_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID:?}"
export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY:?}"
export RCLONE_CONFIG_R2_ENDPOINT="https://${R2_ACCOUNT_ID:?}.r2.cloudflarestorage.com"
export RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true

KEEP_DAYS="${BACKUP_KEEP_DAYS:-30}"

backup_once() {
  local name tmp
  name="yoy_fyi-$(date -u +%F).sql.gz"
  tmp="$(mktemp)"
  trap 'rm -f "$tmp"' RETURN
  pg_dump --no-owner --no-privileges | gzip -9 > "$tmp"
  gzip -t "$tmp"
  # A dump this small is an empty database or a failed dump, not a backup.
  [ "$(wc -c < "$tmp")" -gt 1024 ] || { log "dump is suspiciously small, not uploading"; return 1; }
  rclone copyto "$tmp" "r2:${R2_BUCKET}/${name}"
  rclone delete "r2:${R2_BUCKET}" --min-age "${KEEP_DAYS}d" --include "yoy_fyi-*.sql.gz"
  log "uploaded ${name} ($(wc -c < "$tmp" | tr -d " ") bytes)"
}

# Seconds until the next 03:00 UTC.
seconds_to_next_run() {
  local now next
  now="$(date -u +%s)"
  next="$(date -u -d "today 03:00" +%s)"
  [ "$next" -gt "$now" ] || next="$(date -u -d "tomorrow 03:00" +%s)"
  echo $((next - now))
}

if [ -n "${BACKUP_ONCE:-}" ]; then
  backup_once
  exit 0
fi

# A first backup shortly after every start, so a new stack is covered before the first 03:00.
sleep 30
while true; do
  backup_once || log "FAILED, will retry at the next run"
  sleep "$(seconds_to_next_run)"
done
