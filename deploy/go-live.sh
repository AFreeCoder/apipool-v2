#!/bin/sh
# 最终态上线验收：路由与钱包语义已固定，只保留 checkout 开放门禁。
set -eu

APP_DIR="${APIPOOL_DEPLOY_DIR:-/opt/apipool-v2}"
STATE_ENV_FILE="$APP_DIR/.env.deploy"
RELEASE_FILE="$APP_DIR/release.env"
LOCK_FILE="${APIPOOL_DEPLOY_LOCK:-/run/apipool-v2-deploy.lock}"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
. "$SCRIPT_DIR/lib.sh"

exec 9>"$LOCK_FILE"
flock -n 9 || {
  echo "go-live: 部署或另一上线进程正在运行" >&2
  exit 75
}

if [ ! -f "$STATE_ENV_FILE" ]; then
  echo "go-live: 缺少 $STATE_ENV_FILE" >&2
  exit 66
fi
for required in "$RELEASE_FILE" "$APP_DIR/docker-compose.prod.yml" "$APP_DIR/deploy/live-smoke.sh"; do
  if [ ! -f "$required" ]; then
    echo "go-live: 缺少 $required" >&2
    exit 66
  fi
done

current() {
  read_env_value "$1"
}

release_image_tag() {
  [ -f "$RELEASE_FILE" ] || return 0
  sed -n 's/^IMAGE_TAG=//p' "$RELEASE_FILE" | tail -1
}

require_checkout_closed() {
  value="$(current APIPOOL_CHECKOUT_ENABLED)"
  if [ "$value" != false ]; then
    echo "go-live: APIPOOL_CHECKOUT_ENABLED 必须显式为 false，当前为 '$value'" >&2
    exit 78
  fi
}

require_restore_evidence() {
  if [ "$#" -ne 2 ] || [ "${1:-}" != --evidence ] || [ -z "${2:-}" ]; then
    echo "go-live: open-checkout 必须提供 --evidence <备份恢复演练证据>" >&2
    exit 78
  fi

  RESTORE_EVIDENCE="$2"
  if [ ! -f "$RESTORE_EVIDENCE" ] || [ ! -r "$RESTORE_EVIDENCE" ] || [ ! -s "$RESTORE_EVIDENCE" ]; then
    echo "go-live: 备份恢复演练证据必须存在、可读且非空：$RESTORE_EVIDENCE" >&2
    exit 78
  fi
}

require_marker() {
  marker="$1"
  expected="$(release_image_tag)"
  if [ ! -f "$marker" ]; then
    echo "go-live: 缺少 $(basename "$marker")，必须先执行 verify" >&2
    exit 78
  fi
  actual="$(sed -n 's/^IMAGE_TAG=//p' "$marker" | tail -1)"
  if [ -z "$expected" ] || [ "$actual" != "$expected" ]; then
    echo "go-live: $(basename "$marker") IMAGE_TAG='$actual' 与当前发布 '$expected' 不匹配" >&2
    exit 78
  fi
}

probe_status() {
  url="$1"
  if ! status="$(curl -s -o /dev/null -w '%{http_code}' "$url" 2>/dev/null)"; then
    status=000
  fi
  printf '%s' "$status"
}

if [ -n "${APIPOOL_GO_LIVE_PROBE_BASE:-}" ]; then
  PORTAL_BASE="${APIPOOL_GO_LIVE_PROBE_BASE%/}/app"
  API_BASE="${APIPOOL_GO_LIVE_PROBE_BASE%/}/api2"
  NEWAPI_BASE="${APIPOOL_GO_LIVE_PROBE_BASE%/}/newapi"
else
  PORTAL_BASE="${APIPOOL_GO_LIVE_PORTAL_BASE:-https://app.apipool.dev}"
  API_BASE="${APIPOOL_GO_LIVE_API_BASE:-https://api2.apipool.dev}"
  NEWAPI_BASE="${APIPOOL_GO_LIVE_NEWAPI_BASE:-https://newapi.apipool.dev}"
fi

expect_probe() {
  label="$1"
  url="$2"
  expected="$3"
  actual="$(probe_status "$url")"
  if [ "$actual" != "$expected" ]; then
    echo "go-live: $label 探测失败：$url 期待 ${expected}，实际 $actual" >&2
    return 1
  fi
}

verify_routes() {
  expect_probe app "$PORTAL_BASE/v1/models" 401 &&
    expect_probe api2 "$API_BASE/v1/models" 401 &&
    expect_probe newapi "$NEWAPI_BASE/v1/models" 404 &&
    expect_probe api2-management "$API_BASE/api/status" 404
}

recreate() {
  (
    cd "$APP_DIR"
    docker compose --env-file .env.deploy --env-file release.env \
      -f docker-compose.prod.yml up -d
  )
}

compose() {
  (
    cd "$APP_DIR"
    docker compose --env-file .env.deploy --env-file release.env \
      -f docker-compose.prod.yml "$@"
  )
}

recreate_portal() {
  compose up -d apipool-v2
}

container_checkout() {
  compose exec -T apipool-v2 printenv APIPOOL_CHECKOUT_ENABLED
}

verify_container_checkout() {
  expected="$1"
  if ! actual="$(container_checkout)"; then
    echo "go-live: 无法读取容器运行态 APIPOOL_CHECKOUT_ENABLED" >&2
    exit 75
  fi
  if [ "$actual" != "$expected" ]; then
    echo "go-live: 容器运行态 APIPOOL_CHECKOUT_ENABLED='$actual'，需要 '$expected'" >&2
    exit 75
  fi
}

emergency_stop_portal() {
  echo "go-live: 无法确认 checkout 已冻结，紧急停止门户容器" >&2
  if ! compose stop apipool-v2; then
    echo "go-live: 紧急停止门户容器失败" >&2
    return 1
  fi
  if ! running="$(compose ps --status running --services apipool-v2)"; then
    echo "go-live: 无法验证门户容器停止状态" >&2
    return 1
  fi
  if [ -n "$running" ]; then
    echo "go-live: 门户容器仍在运行，checkout 状态未知" >&2
    return 1
  fi
  echo "go-live: 门户容器已停止，checkout 已通过停服冻结" >&2
}

confirm_open() {
  evidence="$1"
  printf '%s\n' "当前镜像的网关、异步图片与充值 smoke 已通过；备份恢复演练证据：$evidence；即将开放 checkout。" >&2
  printf '%s' "输入 yes 确认继续: " >&2
  answer=""
  read -r answer || true
  if [ "$answer" != yes ]; then
    echo "go-live: 操作员未确认" >&2
    exit 78
  fi
}

command="${1:-}"
case "$command" in
  verify)
    require_checkout_closed
    verify_routes
    "$APP_DIR/deploy/live-smoke.sh"
    "$APP_DIR/deploy/live-smoke.sh" --recharge
    "$APP_DIR/deploy/live-smoke.sh" --gateway
    "$APP_DIR/deploy/live-smoke.sh" --image
    require_marker "$APP_DIR/.live-smoke-recharge-ok"
    require_marker "$APP_DIR/.live-smoke-gateway-ok"
    require_marker "$APP_DIR/.live-smoke-image-ok"
    verify_routes
    echo "go-live: 当前发布的公网路由、MVP、充值、长上下文网关和异步图片 smoke 全部通过"
    ;;
  open-checkout)
    require_checkout_closed
    shift
    require_restore_evidence "$@"
    require_marker "$APP_DIR/.live-smoke-recharge-ok"
    require_marker "$APP_DIR/.live-smoke-gateway-ok"
    require_marker "$APP_DIR/.live-smoke-image-ok"
    verify_routes
    confirm_open "$RESTORE_EVIDENCE"
    set_env_values APIPOOL_CHECKOUT_ENABLED=true
    recreate
    verify_container_checkout true
    echo "go-live: checkout 已开放"
    ;;
  close-checkout)
    set_env_values APIPOOL_CHECKOUT_ENABLED=false
    recreate_result=0
    recreate_portal || recreate_result="$?"
    if actual="$(container_checkout 2>/dev/null)" && [ "$actual" = false ]; then
      if [ "$recreate_result" -ne 0 ]; then
        echo "go-live: 门户重建命令失败，但已确认运行态 checkout=false" >&2
      fi
      echo "go-live: checkout 已冻结"
    else
      emergency_stop_portal || true
      exit 75
    fi
    ;;
  status)
    running_checkout=unavailable
    if actual="$(container_checkout 2>/dev/null)"; then
      running_checkout="$actual"
    fi
    printf 'APIPOOL_CHECKOUT_CONFIGURED=%s\n' "$(current APIPOOL_CHECKOUT_ENABLED)"
    printf 'APIPOOL_CHECKOUT_RUNNING=%s\n' "$running_checkout"
    printf 'IMAGE_TAG=%s\n' "$(release_image_tag)"
    printf 'app=%s\n' "$(probe_status "$PORTAL_BASE/v1/models")"
    printf 'api2=%s\n' "$(probe_status "$API_BASE/v1/models")"
    printf 'newapi=%s\n' "$(probe_status "$NEWAPI_BASE/v1/models")"
    printf 'api2-management=%s\n' "$(probe_status "$API_BASE/api/status")"
    ;;
  *)
    echo "usage: $0 <verify|open-checkout --evidence PATH|close-checkout|status>" >&2
    exit 64
    ;;
esac
