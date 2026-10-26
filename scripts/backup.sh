#!/usr/bin/env bash
# Daily backup of the yoy-fyi database to any S3-compatible bucket (Cloudflare R2, Backblaze B2,
# MinIO...). Runs as the `backup` service of compose.prod.yml, which sets PGHOST/PGUSER/PGDATABASE
# and the secrets from /etc/yoy-fyi/<stage>/{db,backup}.env: S3_ENDPOINT, S3_BUCKET, S3_KEY_ID,
# S3_SECRET and optionally S3_PROVIDER (rclone's name, default Other). Without S3_BUCKET it only
# logs that backups are off.
#
# One file per UTC day, yoy_fyi-YYYY-MM-DD.sql.gz: a later run the same day replaces it, and only
# when pg_dump finished and the gzip is intact, so a failed run never overwrites a good backup.
# Files older than BACKUP_KEEP_DAYS (default 30) are deleted.
set -euo pipefail

log() { echo "backup: $*"; }

if [ -z "${S3_BUCKET:-}" ]; then
  log "S3_BUCKET is not set, backups are off"
  [ -n "${BACKUP_ONCE:-}" ] && exit 0
  exec sleep infinity
fi

export PGPASSWORD="${PGPASSWORD:-${POSTGRES_PASSWORD:-}}"
export RCLONE_CONFIG_REMOTE_TYPE=s3
export RCLONE_CONFIG_REMOTE_PROVIDER="${S3_PROVIDER:-Other}"
export RCLONE_CONFIG_REMOTE_ACCESS_KEY_ID="${S3_KEY_ID:?}"
export RCLONE_CONFIG_REMOTE_SECRET_ACCESS_KEY="${S3_SECRET:?}"
export RCLONE_CONFIG_REMOTE_ENDPOINT="${S3_ENDPOINT:?}"
export RCLONE_CONFIG_REMOTE_NO_CHECK_BUCKET=true

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
  rclone copyto "$tmp" "remote:${S3_BUCKET}/${name}"
  rclone delete "remote:${S3_BUCKET}" --min-age "${KEEP_DAYS}d" --include "yoy_fyi-*.sql.gz"
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
