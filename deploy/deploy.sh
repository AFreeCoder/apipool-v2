#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APIPOOL_DEPLOY_DIR:-/opt/apipool-v2}"
COMPOSE_FILE="${APIPOOL_COMPOSE_FILE:-docker-compose.prod.yml}"
ENV_FILE="${APIPOOL_ENV_FILE:-.env.deploy}"
RELEASE_FILE="${APIPOOL_RELEASE_FILE:-release.env}"
LOCK_FILE="${APIPOOL_DEPLOY_LOCK:-/run/apipool-v2-deploy.lock}"
IMAGE_TAG="${1:-${IMAGE_TAG:-}}"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
STATE_ENV_FILE="$APP_DIR/$ENV_FILE"
PORTAL_DB_PATH="${APIPOOL_PORTAL_DB_PATH:-$APP_DIR/data/portal/portal.db}"

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

for required in \
  "$COMPOSE_FILE" \
  "$ENV_FILE" \
  deploy/backup.sh \
  deploy/configure-caddy.sh \
  deploy/live-smoke.sh \
  deploy/cloudflare-ips.txt \
  deploy/lib.sh; do
  if [ ! -e "$required" ]; then
    echo "[deploy] missing $APP_DIR/$required" >&2
    exit 66
  fi
done
. "$SCRIPT_DIR/lib.sh"

compose() {
  docker compose --env-file "$ENV_FILE" --env-file "$RELEASE_FILE" -f "$COMPOSE_FILE" "$@"
}

portal_group_state() {
  if [ ! -f "$PORTAL_DB_PATH" ] || ! command -v sqlite3 >/dev/null 2>&1; then
    echo unknown
    return
  fi

  local state=""
  state="$(sqlite3 "$PORTAL_DB_PATH" "
    select case
      when exists (select 1 from catalog_group where slug = 'discount')
       and not exists (select 1 from catalog_group where slug = 'codex-discount')
      then 'consolidated'
      when exists (select 1 from catalog_group where slug = 'codex-discount')
       and not exists (select 1 from catalog_group where slug = 'discount')
      then 'legacy'
      else 'unknown' end;
  " 2>/dev/null || true)"
  case "$state" in
    consolidated | legacy) echo "$state" ;;
    *) echo unknown ;;
  esac
}

mkdir -p data/portal data/new-api backups
chown -R 1001:1001 data/portal
chmod 700 backups

old_tag=""
if [ -f "$RELEASE_FILE" ]; then
  old_tag="$(sed -n 's/^IMAGE_TAG=//p' "$RELEASE_FILE" | tail -1)"
fi

portal_group_state_before="$(portal_group_state)"

# checkout 已开放的常规发布先冻结新 checkout，再替换镜像。结算路径继续可用，
# 以便新镜像跑受控充值 smoke；失败时保持冻结。
gated=0
checkout="$(read_env_value APIPOOL_CHECKOUT_ENABLED)"
if [ "$checkout" = true ]; then
  gated=1
  echo "[deploy] freezing checkout before replacing the portal image"
  set_env_values APIPOOL_CHECKOUT_ENABLED=false
  if [ ! -f "$RELEASE_FILE" ]; then
    echo "[deploy] recharge gate requires existing $RELEASE_FILE" >&2
    exit 66
  fi
  compose up -d
  running_checkout="$(compose exec -T apipool-v2 printenv APIPOOL_CHECKOUT_ENABLED)"
  if [ "$running_checkout" != false ]; then
    echo "[deploy] checkout freeze did not reach the running container" >&2
    exit 75
  fi
fi

# 重新生成并校验 Caddy 配置。放在动任何东西之前：configure-caddy.sh 是
# fail-closed 的（New API 运营面未配保护时退出 78），在这里失败等于零副作用
# 中止；放到后面则会留下已备份、已换镜像的半成品状态。
#
# 没有这一步，运维在 .env.deploy 里配好 Basic Auth 也不会生效——
# /etc/caddy/sites-enabled/apipool-v2.caddy 会一直停留在上次发布生成的版本。
echo "[deploy] applying Caddy configuration"
APIPOOL_DEPLOY_ENV_FILE="$APP_DIR/$ENV_FILE" ./deploy/configure-caddy.sh

./deploy/backup.sh pre-deploy

tmp_release="$(mktemp)"
{
  echo "IMAGE_TAG=$IMAGE_TAG"
  echo "DEPLOYED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$tmp_release"
install -m 600 "$tmp_release" "$RELEASE_FILE"
rm -f "$tmp_release"

healthcheck() {
  echo "[deploy] waiting for NewAPI metadata filter"
  local filter_container_id=""
  local filter_health=""
  for _ in $(seq 1 60); do
    filter_container_id="$(compose ps -q newapi-metadata-filter)"
    if [ -n "$filter_container_id" ]; then
      filter_health="$(docker inspect --format '{{.State.Health.Status}}' "$filter_container_id" 2>/dev/null || true)"
      if [ "$filter_health" = "healthy" ]; then
        break
      fi
    fi
    sleep 2
  done
  if [ -z "$filter_container_id" ] || [ "$filter_health" != "healthy" ]; then
    echo "[deploy] NewAPI metadata filter is not healthy" >&2
    return 1
  fi

  echo "[deploy] waiting for New API"
  for _ in $(seq 1 60); do
    if curl -fsS http://127.0.0.1:3001/api/status >/dev/null 2>&1; then
      break
    fi
    sleep 2
  done
  curl -fsS http://127.0.0.1:3001/api/status >/dev/null || return 1

  echo "[deploy] waiting for portal"
  for _ in $(seq 1 60); do
    if curl -fsS http://127.0.0.1:3000/ >/dev/null 2>&1; then
      break
    fi
    sleep 2
  done
  curl -fsS http://127.0.0.1:3000/ >/dev/null || return 1

  if [ -n "${APIPOOL_PUBLIC_PORTAL_URL:-}" ]; then
    curl -fsS "$APIPOOL_PUBLIC_PORTAL_URL" >/dev/null || return 1
  fi
  if [ -n "${APIPOOL_PUBLIC_NEWAPI_STATUS_URL:-}" ]; then
    curl -fsS "$APIPOOL_PUBLIC_NEWAPI_STATUS_URL" >/dev/null || return 1
  fi
}

echo "[deploy] pulling images for tag $IMAGE_TAG"
compose pull
echo "[deploy] starting containers"
compose up -d --remove-orphans

if ! healthcheck; then
  echo "[deploy] healthcheck failed for $IMAGE_TAG" >&2
  portal_group_state_after="$(portal_group_state)"
  if ! { [ "$portal_group_state_before" = consolidated ] && [ "$portal_group_state_after" = consolidated ]; } &&
    ! { [ "$portal_group_state_before" = legacy ] && [ "$portal_group_state_after" = legacy ]; }; then
    echo "[deploy] Portal group state is migration-sensitive or unknown (before=$portal_group_state_before after=$portal_group_state_after); image-only rollback is forbidden" >&2
    echo "[deploy] restore the latest pre-deploy archive together with the previous IMAGE_TAG (docs/07-runbook.md section 5)" >&2
    exit 78
  fi
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
if [ "$gated" -eq 1 ]; then
  if ./deploy/live-smoke.sh --recharge; then
    set_env_values APIPOOL_CHECKOUT_ENABLED=true
    compose up -d
  else
    echo "[deploy] RECHARGE SMOKE FAILED on $IMAGE_TAG — checkout stays frozen (fail-closed)" >&2
    exit 75
  fi
fi
echo "[deploy] deployed $IMAGE_TAG"
