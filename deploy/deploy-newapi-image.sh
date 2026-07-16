#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

APP_DIR="${APIPOOL_DEPLOY_DIR:-/opt/apipool-v2}"
COMPOSE_FILE="${APIPOOL_COMPOSE_FILE:-docker-compose.prod.yml}"
ENV_FILE="${APIPOOL_ENV_FILE:-.env.deploy}"
RELEASE_FILE="${APIPOOL_RELEASE_FILE:-release.env}"
LOCK_FILE="${APIPOOL_DEPLOY_LOCK:-/run/apipool-v2-deploy.lock}"
IMAGE_REF="${1:-}"
LOCAL_IMAGE=0

if [[ "$IMAGE_REF" =~ ^ghcr\.io/afreecoder/apipool-new-api@sha256:[0-9a-f]{64}$ ]]; then
  :
elif [[ "$IMAGE_REF" =~ ^ghcr\.io/afreecoder/apipool-new-api:sha-[0-9a-f]{40}$ ]]; then
  LOCAL_IMAGE=1
else
  echo "usage: $0 ghcr.io/afreecoder/apipool-new-api@sha256:<digest>|ghcr.io/afreecoder/apipool-new-api:sha-<commit>" >&2
  exit 64
fi

exec 9>"$LOCK_FILE"
flock -n 9 || {
  echo "[newapi-deploy] another deployment is running" >&2
  exit 75
}

cd "$APP_DIR"

for required in "$COMPOSE_FILE" "$ENV_FILE" "$RELEASE_FILE" deploy/backup.sh; do
  if [ ! -e "$required" ]; then
    echo "[newapi-deploy] missing $APP_DIR/$required" >&2
    exit 66
  fi
done

if [ "$LOCAL_IMAGE" -eq 1 ]; then
  docker image inspect "$IMAGE_REF" >/dev/null
fi

compose() {
  docker compose --env-file "$ENV_FILE" --env-file "$RELEASE_FILE" -f "$COMPOSE_FILE" "$@"
}

set_newapi_image() {
  local image_ref="$1"
  local tmp_env=""
  tmp_env="$(mktemp)"
  awk -v image_ref="$image_ref" '
    BEGIN { replaced = 0 }
    /^NEWAPI_IMAGE=/ {
      print "NEWAPI_IMAGE=" image_ref
      replaced = 1
      next
    }
    { print }
    END {
      if (!replaced) {
        print "NEWAPI_IMAGE=" image_ref
      }
    }
  ' "$ENV_FILE" > "$tmp_env"
  install -m 600 "$tmp_env" "$ENV_FILE"
  rm -f "$tmp_env"
}

wait_for_newapi() {
  local container_id=""
  for _ in $(seq 1 60); do
    if curl -fsS http://127.0.0.1:3001/api/status >/dev/null 2>&1; then
      container_id="$(compose ps -q new-api)"
      if [ -n "$container_id" ] && [ "$(docker inspect --format '{{.State.Running}}' "$container_id")" = "true" ]; then
        return 0
      fi
    fi
    sleep 2
  done
  return 1
}

old_container_id="$(compose ps -q new-api)"
if [ -z "$old_container_id" ]; then
  echo "[newapi-deploy] current New API container is missing" >&2
  exit 69
fi

old_image_id="$(docker inspect --format '{{.Image}}' "$old_container_id")"
old_image_ref="$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$old_image_id" | sed -n '1p')"
if [ -z "$old_image_ref" ]; then
  old_image_ref="apipool-newapi-rollback:$(date -u +%Y%m%dT%H%M%SZ)"
  docker image tag "$old_image_id" "$old_image_ref"
fi

./deploy/backup.sh pre-deploy
archive=""
for candidate in "$APP_DIR"/backups/pre-deploy-*.tar.gz; do
  if [ ! -e "$candidate" ]; then
    continue
  fi
  if [ -z "$archive" ] || [ "$candidate" -nt "$archive" ]; then
    archive="$candidate"
  fi
done
test -s "$archive"
tar -tzf "$archive" | grep -E '(^|/)data/new-api/one-api.db$' >/dev/null

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
rollback_snapshot="$APP_DIR/backups/rollback-newapi-image-$timestamp.env"
printf 'NEWAPI_IMAGE=%s\n' "$old_image_ref" > "$rollback_snapshot"
chmod 600 "$rollback_snapshot"

changed=0
rollback() {
  local status=$?
  trap - ERR
  if [ "$changed" -eq 1 ]; then
    echo "[newapi-deploy] deployment failed; restoring $old_image_ref" >&2
    set_newapi_image "$old_image_ref"
    compose pull new-api >/dev/null 2>&1 || true
    compose up -d --no-deps new-api >/dev/null 2>&1 || true
    wait_for_newapi || true
  fi
  exit "$status"
}
trap rollback ERR

set_newapi_image "$IMAGE_REF"
changed=1

if [ "$LOCAL_IMAGE" -eq 0 ]; then
  compose pull new-api
fi
compose up -d --no-deps new-api
wait_for_newapi

new_container_id="$(compose ps -q new-api)"
new_config_image="$(docker inspect --format '{{.Config.Image}}' "$new_container_id")"
if [ "$new_config_image" != "$IMAGE_REF" ]; then
  echo "[newapi-deploy] running image mismatch: $new_config_image" >&2
  exit 1
fi

integrity="$(sqlite3 "$APP_DIR/data/new-api/one-api.db" 'PRAGMA integrity_check;')"
if [ "$integrity" != "ok" ]; then
  echo "[newapi-deploy] New API database integrity check failed: $integrity" >&2
  exit 1
fi

trap - ERR

echo "[newapi-deploy] image=$IMAGE_REF"
echo "[newapi-deploy] previous_image=$old_image_ref"
echo "[newapi-deploy] backup=$archive"
echo "[newapi-deploy] rollback_snapshot=$rollback_snapshot"
echo "[newapi-deploy] database_integrity=$integrity"
