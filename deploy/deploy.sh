#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APIPOOL_DEPLOY_DIR:-/opt/apipool-v2}"
COMPOSE_FILE="${APIPOOL_COMPOSE_FILE:-docker-compose.prod.yml}"
ENV_FILE="${APIPOOL_ENV_FILE:-.env.deploy}"
RELEASE_FILE="${APIPOOL_RELEASE_FILE:-release.env}"
LOCK_FILE="${APIPOOL_DEPLOY_LOCK:-/run/apipool-v2-deploy.lock}"
IMAGE_TAG="${1:-${IMAGE_TAG:-}}"

if [ -z "$IMAGE_TAG" ]; then
  echo "usage: $0 <image-tag>" >&2
  echo "example: $0 sha-$(git rev-parse HEAD 2>/dev/null || echo '<commit>')" >&2
  exit 64
fi

exec 9>"$LOCK_FILE"
flock -n 9 || {
  echo "[deploy] another deploy is running" >&2
  exit 75
}

cd "$APP_DIR"

for required in "$COMPOSE_FILE" "$ENV_FILE" deploy/backup.sh; do
  if [ ! -e "$required" ]; then
    echo "[deploy] missing $APP_DIR/$required" >&2
    exit 66
  fi
done

mkdir -p data/portal data/new-api backups
chown -R 1001:1001 data/portal
chmod 700 backups

old_tag=""
if [ -f "$RELEASE_FILE" ]; then
  old_tag="$(sed -n 's/^IMAGE_TAG=//p' "$RELEASE_FILE" | tail -1)"
fi

./deploy/backup.sh pre-deploy

tmp_release="$(mktemp)"
{
  echo "IMAGE_TAG=$IMAGE_TAG"
  echo "DEPLOYED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$tmp_release"
install -m 600 "$tmp_release" "$RELEASE_FILE"
rm -f "$tmp_release"

compose() {
  docker compose --env-file "$ENV_FILE" --env-file "$RELEASE_FILE" -f "$COMPOSE_FILE" "$@"
}

healthcheck() {
  echo "[deploy] waiting for New API"
  for _ in $(seq 1 60); do
    if curl -fsS http://127.0.0.1:3001/api/status >/dev/null 2>&1; then
      break
    fi
    sleep 2
  done
  curl -fsS http://127.0.0.1:3001/api/status >/dev/null

  echo "[deploy] waiting for portal"
  for _ in $(seq 1 60); do
    if curl -fsS http://127.0.0.1:3000/ >/dev/null 2>&1; then
      break
    fi
    sleep 2
  done
  curl -fsS http://127.0.0.1:3000/ >/dev/null

  if [ -n "${APIPOOL_PUBLIC_PORTAL_URL:-}" ]; then
    curl -fsS "$APIPOOL_PUBLIC_PORTAL_URL" >/dev/null
  fi
  if [ -n "${APIPOOL_PUBLIC_NEWAPI_STATUS_URL:-}" ]; then
    curl -fsS "$APIPOOL_PUBLIC_NEWAPI_STATUS_URL" >/dev/null
  fi
}

echo "[deploy] pulling images for tag $IMAGE_TAG"
compose pull
echo "[deploy] starting containers"
compose up -d --remove-orphans

if ! healthcheck; then
  echo "[deploy] healthcheck failed for $IMAGE_TAG" >&2
  if [ -n "$old_tag" ] && [ "$old_tag" != "$IMAGE_TAG" ]; then
    echo "[deploy] rolling back container image to $old_tag" >&2
    {
      echo "IMAGE_TAG=$old_tag"
      echo "DEPLOYED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    } > "$RELEASE_FILE"
    compose pull || true
    compose up -d --remove-orphans || true
  fi
  exit 1
fi

compose ps
echo "[deploy] deployed $IMAGE_TAG"
