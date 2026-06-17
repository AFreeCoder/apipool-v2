#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

MODE="${1:-daily}"
APP_DIR="${APIPOOL_DEPLOY_DIR:-/opt/apipool-v2}"
BACKUP_ROOT="${APIPOOL_BACKUP_ROOT:-$APP_DIR/backups}"
COMPOSE_FILE="${APIPOOL_COMPOSE_FILE:-docker-compose.prod.yml}"
ENV_FILE="${APIPOOL_ENV_FILE:-.env.deploy}"
RELEASE_FILE="${APIPOOL_RELEASE_FILE:-release.env}"
LOCK_FILE="${APIPOOL_BACKUP_LOCK:-/run/apipool-v2-backup.lock}"

case "$MODE" in
  pre-deploy) RETAIN="${APIPOOL_PRE_DEPLOY_BACKUP_RETAIN:-2}" ;;
  daily) RETAIN_DAYS="${APIPOOL_DAILY_BACKUP_RETAIN_DAYS:-7}" ;;
  *) echo "usage: $0 [pre-deploy|daily]" >&2; exit 64 ;;
esac

mkdir -p "$BACKUP_ROOT"

exec 9>"$LOCK_FILE"
flock -n 9 || {
  echo "[backup] another backup is running" >&2
  exit 75
}

cd "$APP_DIR"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
archive="$BACKUP_ROOT/${MODE}-${timestamp}.tar.gz"
staging="$(mktemp -d)"
paused=0

cleanup() {
  status=$?
  if [ "$paused" -eq 1 ]; then
    docker compose --env-file "$ENV_FILE" --env-file "$RELEASE_FILE" -f "$COMPOSE_FILE" unpause >/dev/null 2>&1 || true
  fi
  rm -rf "$staging"
  exit "$status"
}
trap cleanup EXIT

if [ "${APIPOOL_BACKUP_QUIESCE:-1}" = "1" ] && [ -f "$ENV_FILE" ] && [ -f "$COMPOSE_FILE" ]; then
  if docker compose --env-file "$ENV_FILE" --env-file "$RELEASE_FILE" -f "$COMPOSE_FILE" ps --services --filter status=running >/dev/null 2>&1; then
    running_services="$(docker compose --env-file "$ENV_FILE" --env-file "$RELEASE_FILE" -f "$COMPOSE_FILE" ps --services --filter status=running || true)"
    if [ -n "$running_services" ]; then
      # Freeze writes while copying SQLite files and any WAL/SHM sidecars.
      docker compose --env-file "$ENV_FILE" --env-file "$RELEASE_FILE" -f "$COMPOSE_FILE" pause $running_services >/dev/null
      paused=1
    fi
  fi
fi

mkdir -p "$staging/config" "$staging/data"

for path in "$ENV_FILE" "$RELEASE_FILE" "$COMPOSE_FILE" docker-compose.yml deploy; do
  if [ -e "$path" ]; then
    cp -a "$path" "$staging/config/"
  fi
done

if [ -d data ]; then
  cp -a data/. "$staging/data/"
fi

tar -C "$staging" -czf "$archive" .
chmod 600 "$archive"

if [ "$MODE" = "pre-deploy" ]; then
  count="$(find "$BACKUP_ROOT" -maxdepth 1 -type f -name "${MODE}-*.tar.gz" | wc -l | tr -d ' ')"
  if [ "$count" -gt "$RETAIN" ]; then
    find "$BACKUP_ROOT" -maxdepth 1 -type f -name "${MODE}-*.tar.gz" | sort | head -n "$((count - RETAIN))" | xargs -r rm -f
  fi
else
  find "$BACKUP_ROOT" -maxdepth 1 -type f -name "${MODE}-*.tar.gz" -mtime +"$((RETAIN_DAYS - 1))" -delete
fi

echo "[backup] wrote $archive"
