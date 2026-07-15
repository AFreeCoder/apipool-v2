#!/bin/sh
# 网关切流逐态推进。故障处理只允许前滚或收敛 maintenance，绝不回 legacy。
set -eu

APP_DIR="${APIPOOL_DEPLOY_DIR:-/opt/apipool-v2}"
STATE_ENV_FILE="$APP_DIR/.env.deploy"
RELEASE_FILE="$APP_DIR/release.env"
LOCK_FILE="${APIPOOL_DEPLOY_LOCK:-/run/apipool-v2-deploy.lock}"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
. "$SCRIPT_DIR/lib.sh"

exec 9>"$LOCK_FILE"
flock -n 9 || {
  echo "cutover: 部署或另一切流进程正在运行" >&2
  exit 75
}

if [ ! -f "$STATE_ENV_FILE" ]; then
  echo "cutover: 缺少 $STATE_ENV_FILE" >&2
  exit 66
fi

current() {
  read_env_value "$1"
}

require_state() {
  key="$1"
  shift
  val="$(current "$key")"
  for want in "$@"; do
    [ "$val" = "$want" ] && return 0
  done
  if [ -z "$val" ]; then
    echo "cutover: $key 在 .env.deploy 中缺失或为空——状态文件可能损坏，禁止继续" >&2
  else
    echo "cutover: $key='$val' 不满足前态要求（需要: $*）——切流不可跳级，先执行上一步" >&2
  fi
  exit 78
}

release_image_tag() {
  [ -f "$RELEASE_FILE" ] || return 0
  sed -n 's/^IMAGE_TAG=//p' "$RELEASE_FILE" | tail -1
}

require_marker() {
  marker="$1"
  bind_release="${2:-false}"
  if [ ! -f "$marker" ]; then
    echo "cutover: 缺少 $(basename "$marker")，必须先完成对应 live smoke" >&2
    exit 78
  fi
  if [ "$bind_release" = true ]; then
    expected="$(release_image_tag)"
    actual="$(sed -n 's/^IMAGE_TAG=//p' "$marker" | tail -1)"
    if [ -z "$expected" ] || [ "$actual" != "$expected" ]; then
      echo "cutover: $(basename "$marker") IMAGE_TAG='$actual' 与当前发布 '$expected' 不匹配" >&2
      exit 78
    fi
  fi
}

probe_status() {
  url="$1"
  if ! status="$(curl -s -o /dev/null -w '%{http_code}' "$url" 2>/dev/null)"; then
    status=000
  fi
  printf '%s' "$status"
}

if [ -n "${APIPOOL_CUTOVER_PROBE_BASE:-}" ]; then
  API_BASE="${APIPOOL_CUTOVER_PROBE_BASE%/}/api2"
  NEWAPI_BASE="${APIPOOL_CUTOVER_PROBE_BASE%/}/newapi"
else
  API_BASE="${APIPOOL_CUTOVER_API_BASE:-https://api2.apipool.dev}"
  NEWAPI_BASE="${APIPOOL_CUTOVER_NEWAPI_BASE:-https://newapi.apipool.dev}"
fi

expect_probe() {
  label="$1"
  url="$2"
  expected="$3"
  actual="$(probe_status "$url")"
  if [ "$actual" != "$expected" ]; then
    echo "cutover: $label 探测失败：$url 期待 ${expected}，实际 $actual" >&2
    return 1
  fi
}

verify_isolation() {
  if ! expect_probe api2 "$API_BASE/v1/models" 503 ||
     ! expect_probe newapi "$NEWAPI_BASE/v1/models" 404; then
    echo "cutover: 实时隔离未生效，请重跑 maintenance 后再继续" >&2
    return 1
  fi
}

verify_portal() {
  expect_probe api2 "$API_BASE/v1/models" 401 &&
    expect_probe newapi "$NEWAPI_BASE/v1/models" 404
}

verify_final() {
  verify_portal && expect_probe api2-management "$API_BASE/api/status" 404
}

recreate() {
  (
    cd "$APP_DIR"
    docker compose --env-file .env.deploy --env-file release.env \
      -f docker-compose.prod.yml up -d
  )
}

recaddy() {
  APIPOOL_DEPLOY_ENV_FILE="$STATE_ENV_FILE" "$APP_DIR/deploy/configure-caddy.sh"
}

verify_container_env() {
  key="$1"
  expected="$2"
  actual="$(
    cd "$APP_DIR"
    docker compose --env-file .env.deploy --env-file release.env \
      -f docker-compose.prod.yml exec -T apipool-v2 printenv "$key"
  )"
  if [ "$actual" != "$expected" ]; then
    echo "cutover: 容器运行态 $key='$actual'，需要 '$expected'；请重跑 activate-wallet" >&2
    return 1
  fi
}

confirm_step() {
  summary="$1"
  printf '%s\n' "$summary" >&2
  printf '%s' "输入 yes 确认继续: " >&2
  answer=""
  read -r answer || true
  if [ "$answer" != yes ]; then
    echo "cutover: 操作员未确认" >&2
    exit 78
  fi
}

command="${1:-}"
case "$command" in
  env-set-batch)
    shift
    [ "$#" -gt 0 ] || exit 64
    set_env_values "$@"
    ;;
  preflight)
    expect_probe portal-direct http://127.0.0.1:3000/v1/models 401
    "$APP_DIR/deploy/live-smoke.sh"
    echo "cutover: preflight 通过"
    ;;
  maintenance)
    require_state APIPOOL_API_MODE legacy maintenance portal ''
    set_env_values APIPOOL_API_MODE=maintenance APIPOOL_CHECKOUT_ENABLED=false
    recreate
    recaddy
    verify_isolation
    echo "cutover: 已进入 maintenance，推理与收款均隔离"
    ;;
  activate-wallet)
    require_state APIPOOL_API_MODE maintenance
    require_state APIPOOL_CHECKOUT_ENABLED false
    verify_isolation
    if [ "${2:-}" != --evidence ] || [ -z "${3:-}" ] || [ ! -f "$3" ]; then
      echo "cutover: activate-wallet 必须提供存在的 --evidence <备份恢复演练证据>" >&2
      exit 78
    fi
    confirm_step "备份恢复演练证据：$3；即将原子开启钱包写入与展示。"
    set_env_values WALLET_LEDGER_WRITE_ENABLED=true WALLET_DISPLAY_ENABLED=true
    recreate
    verify_container_env WALLET_LEDGER_WRITE_ENABLED true
    verify_container_env WALLET_DISPLAY_ENABLED true
    "$APP_DIR/deploy/live-smoke.sh" --recharge
    require_marker "$APP_DIR/.cutover-recharge-ok" true
    echo "cutover: 钱包已激活，当前发布的充值 smoke 已通过"
    ;;
  portal)
    require_state APIPOOL_API_MODE maintenance
    require_state APIPOOL_CHECKOUT_ENABLED false
    require_state WALLET_LEDGER_WRITE_ENABLED true
    require_state WALLET_DISPLAY_ENABLED true
    require_marker "$APP_DIR/.cutover-recharge-ok" true
    verify_isolation
    verify_container_env WALLET_LEDGER_WRITE_ENABLED true
    verify_container_env WALLET_DISPLAY_ENABLED true
    set_env_values APIPOOL_API_MODE=portal
    recaddy
    if ! verify_portal; then
      set_env_values APIPOOL_API_MODE=maintenance APIPOOL_CHECKOUT_ENABLED=false
      recaddy || true
      verify_isolation || true
      echo "cutover: portal 切换失败，已收敛 maintenance" >&2
      exit 75
    fi
    echo "cutover: api2 已切到门户网关，newapi /v1 保持封锁"
    ;;
  finalize)
    require_state APIPOOL_API_MODE portal
    require_state WALLET_LEDGER_WRITE_ENABLED true
    require_state WALLET_DISPLAY_ENABLED true
    require_marker "$APP_DIR/.cutover-smoke-ok" false
    require_marker "$APP_DIR/.cutover-recharge-ok" true
    confirm_step "网关 smoke：$(cat "$APP_DIR/.cutover-smoke-ok")；充值 smoke：$(cat "$APP_DIR/.cutover-recharge-ok")"
    verify_final
    set_env_values APIPOOL_CHECKOUT_ENABLED=true
    recreate
    echo "cutover: checkout 已开放，切流完成"
    ;;
  status)
    printf 'APIPOOL_API_MODE=%s\n' "$(current APIPOOL_API_MODE)"
    printf 'APIPOOL_CHECKOUT_ENABLED=%s\n' "$(current APIPOOL_CHECKOUT_ENABLED)"
    printf 'WALLET_LEDGER_WRITE_ENABLED=%s\n' "$(current WALLET_LEDGER_WRITE_ENABLED)"
    printf 'WALLET_DISPLAY_ENABLED=%s\n' "$(current WALLET_DISPLAY_ENABLED)"
    printf 'api2=%s\n' "$(probe_status "$API_BASE/v1/models")"
    printf 'newapi=%s\n' "$(probe_status "$NEWAPI_BASE/v1/models")"
    printf 'api2-management=%s\n' "$(probe_status "$API_BASE/api/status")"
    ;;
  *)
    echo "usage: $0 <preflight|maintenance|activate-wallet|portal|finalize|status>" >&2
    exit 64
    ;;
esac
