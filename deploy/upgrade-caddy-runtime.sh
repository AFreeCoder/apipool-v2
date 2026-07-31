#!/usr/bin/env bash
set -Eeuo pipefail

# 共享 Caddy 运行时只能由 owner 经 SSH 显式升级。脚本使用同机候选实例和
# nftables REDIRECT 接管新连接，不修改 DNS，也不把已落后的旧 VPS 当回退源。

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/caddy-runtime-lib.sh
. "$SCRIPT_DIR/caddy-runtime-lib.sh"

usage() {
  cat >&2 <<EOF
usage:
  $0 --preflight <candidate-binary>
  $0 --candidate-test <candidate-binary>
  $0 --apply <candidate-binary>
EOF
  exit 64
}

[ "$#" -eq 2 ] || usage
MODE="$1"
case "$MODE" in
  --preflight | --candidate-test | --apply) ;;
  *) usage ;;
esac

if [ "$(id -u)" -ne 0 ]; then
  echo "upgrade-caddy-runtime.sh: must run as root" >&2
  exit 77
fi

INPUT_BINARY="$(realpath -e -- "$2")"
verify_caddy_binary "$INPUT_BINARY"

APP_DIR="${APIPOOL_DEPLOY_DIR:-/opt/apipool-v2}"
ENV_FILE="$APP_DIR/.env.deploy"
CADDY_ROOT_FILE="/etc/caddy/Caddyfile"
CADDY_SITES_DIR="/etc/caddy/sites-enabled"
CADDY_V2_FRAGMENT="$CADDY_SITES_DIR/apipool-v2.caddy"
CADDY_LEGACY_FRAGMENT="$CADDY_SITES_DIR/apipool-legacy.caddy"
DROPIN_DIR="/etc/systemd/system/caddy.service.d"
DROPIN_FILE="$DROPIN_DIR/10-apipool-runtime.conf"
CLI_FILE="/usr/local/bin/caddy"
RUN_DIR="/run/apipool-caddy-upgrade"
CANDIDATE_STATE_DIR="/var/lib/apipool-caddy-candidate"
CANDIDATE_UNIT="apipool-caddy-candidate.service"
CANDIDATE_STREAM_UNIT="apipool-caddy-stream-test.service"
CANDIDATE_LOG="/var/log/caddy/apipool.dev.candidate.log"
CADDY_ACCESS_LOG="/var/log/caddy/apipool.dev.log"
PRODUCTION_AUTOSAVE="/var/lib/caddy/.config/caddy/autosave.json"
LEGACY_WRITER_CONTRACT="/opt/sub2api/deploy/caddy-runtime-contract"
LEGACY_WRITER_CONTRACT_ID="apipool-caddy-runtime-v1"
CANDIDATE_STREAM_PORT="19090"
CUTOVER_TABLE="apipool_caddy_cutover"
CUTOVER_COMMENT="apipool-caddy-cutover"
BACKUP_DIR="$APP_DIR/backups"

RUNNER_SERVICES=(
  actions.runner.AFreeCoder-apipool-v2.apipool-prod-deploy.service
  actions.runner.AFreeCoder-apipool.sub2api-prod-deploy.service
  actions.runner.AFreeCoder-new-api.new-api-prod-deploy.service
)

for command in \
  apt-mark awk chmod chown cmp cp curl date dpkg-query find flock grep install \
  journalctl nft python3 realpath runuser sed seq sha256sum sleep ss stat systemctl systemd-run tar; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "upgrade-caddy-runtime.sh: missing command: $command" >&2
    exit 69
  fi
done
for path in "$ENV_FILE" "$CADDY_ROOT_FILE" "$CADDY_V2_FRAGMENT" \
  "$CADDY_LEGACY_FRAGMENT" \
  "$SCRIPT_DIR/configure-caddy.sh" "$SCRIPT_DIR/systemd/caddy-apipool.conf"; do
  if [ ! -f "$path" ] || [ -L "$path" ]; then
    echo "upgrade-caddy-runtime.sh: missing or unsafe required file: $path" >&2
    exit 66
  fi
done
if [ -e "$RUN_DIR" ] || [ -L "$RUN_DIR" ]; then
  echo "upgrade-caddy-runtime.sh: stale run directory exists: $RUN_DIR" >&2
  exit 75
fi
if systemctl list-unit-files "$CANDIDATE_UNIT" --no-legend 2>/dev/null | grep -q . \
  || systemctl status "$CANDIDATE_UNIT" >/dev/null 2>&1; then
  echo "upgrade-caddy-runtime.sh: candidate unit already exists" >&2
  exit 75
fi
if systemctl list-unit-files "$CANDIDATE_STREAM_UNIT" --no-legend 2>/dev/null | grep -q . \
  || systemctl status "$CANDIDATE_STREAM_UNIT" >/dev/null 2>&1; then
  echo "upgrade-caddy-runtime.sh: stream test unit already exists" >&2
  exit 75
fi
if nft list table inet "$CUTOVER_TABLE" >/dev/null 2>&1; then
  echo "upgrade-caddy-runtime.sh: stale nft cutover table exists" >&2
  exit 75
fi

install -d -o root -g caddy -m 0710 "$RUN_DIR"
ROLLBACK_DIR="$RUN_DIR/rollback"
TARGET_STAGE_DIR="$RUN_DIR/target"
CANDIDATE_CONFIG_DIR="$RUN_DIR/candidate"
NFT_FILE="$RUN_DIR/cutover.nft"
install -d -m 0700 "$ROLLBACK_DIR" "$TARGET_STAGE_DIR"
install -d -o root -g caddy -m 0750 "$CANDIDATE_CONFIG_DIR"

RUNNERS_STOPPED=0
CANDIDATE_STARTED=0
STREAM_TEST_STARTED=0
STREAM_CURL_PID=0
NAT_ACTIVE=0
SYSTEM_TOUCHED=0
LIVE_FILES_CHANGED=0
DROPIN_CHANGED=0
APT_HOLD_CHANGED=0
COMMITTED=0

file_fingerprint() {
  local path="$1"
  if [ -L "$path" ]; then
    echo "unsafe:$path"
    return 77
  fi
  if [ -f "$path" ]; then
    sha256sum "$path" | awk '{print "sha256:" $1}'
  elif [ -e "$path" ]; then
    echo "unsafe:$path"
    return 77
  else
    echo absent
  fi
}

PRODUCTION_AUTOSAVE_BEFORE="$(file_fingerprint "$PRODUCTION_AUTOSAVE")"

assert_production_autosave_unchanged() {
  local current=""
  current="$(file_fingerprint "$PRODUCTION_AUTOSAVE")"
  if [ "$current" != "$PRODUCTION_AUTOSAVE_BEFORE" ]; then
    echo "[caddy-upgrade] candidate changed the production autosave" >&2
    return 70
  fi
}

verify_legacy_writer_contract() {
  local owner=""
  local mode=""
  local contract=""
  if [ ! -f "$LEGACY_WRITER_CONTRACT" ] || [ -L "$LEGACY_WRITER_CONTRACT" ]; then
    echo "[caddy-upgrade] upgraded legacy writer contract is not installed" >&2
    return 78
  fi
  owner="$(stat -c '%u' "$LEGACY_WRITER_CONTRACT")"
  mode="$(stat -c '%a' "$LEGACY_WRITER_CONTRACT")"
  if [ "$owner" != "0" ] || (( (8#$mode & 8#022) != 0 )); then
    echo "[caddy-upgrade] legacy writer contract is not root-owned and immutable" >&2
    return 78
  fi
  contract="$(awk -F= '
    $1 == "APIPOOL_CADDY_RUNTIME_CONTRACT" { value = $2; count++ }
    /^[[:space:]]*($|#)/ { next }
    $1 != "APIPOOL_CADDY_RUNTIME_CONTRACT" { unexpected = 1 }
    END {
      if (count == 1 && !unexpected) print value
    }
  ' "$LEGACY_WRITER_CONTRACT")"
  if [ "$contract" != "$LEGACY_WRITER_CONTRACT_ID" ]; then
    echo "[caddy-upgrade] legacy writer contract version mismatch" >&2
    return 78
  fi
}

remove_filter_rules() {
  local handle=""
  while IFS= read -r handle; do
    [ -n "$handle" ] || continue
    nft delete rule inet apipool_ingress input handle "$handle" >/dev/null 2>&1 || true
  done < <(
    nft -a list chain inet apipool_ingress input 2>/dev/null \
      | awk -v comment="$CUTOVER_COMMENT" \
        'index($0, "comment \"" comment "\"") { print $NF }'
  )
}

remove_cutover_nat() {
  if nft list table inet "$CUTOVER_TABLE" >/dev/null 2>&1; then
    if ! nft delete table inet "$CUTOVER_TABLE"; then
      echo "[caddy-upgrade] could not remove the cutover NAT table" >&2
      return 70
    fi
  fi
  NAT_ACTIVE=0
}

restore_runners() {
  local service=""
  local failed=0
  if [ "$RUNNERS_STOPPED" -eq 1 ]; then
    for service in "${RUNNER_SERVICES[@]}"; do
      if ! systemctl start "$service" \
        || ! systemctl is-active --quiet "$service"; then
        echo "[caddy-upgrade] runner did not recover: $service" >&2
        failed=1
      fi
    done
    if [ "$failed" -eq 0 ]; then
      RUNNERS_STOPPED=0
    fi
  fi
  return "$failed"
}

stop_candidate() {
  local stopped_at=""
  if [ "$CANDIDATE_STARTED" -eq 1 ] \
    || systemctl status "$CANDIDATE_UNIT" >/dev/null 2>&1; then
    stopped_at="$(date --iso-8601=seconds)"
    if ! systemctl stop "$CANDIDATE_UNIT"; then
      echo "[caddy-upgrade] candidate did not stop cleanly" >&2
      return 70
    fi
    if journalctl -u "$CANDIDATE_UNIT" --since "$stopped_at" --no-pager -o cat \
      | grep -Eq 'timed out|status=9/KILL|Failed with result'; then
      echo "[caddy-upgrade] candidate drain was forced or timed out" >&2
      return 70
    fi
    if ss -Hlnut \
      | awk -v http="$APIPOOL_CADDY_CANDIDATE_HTTP_PORT" \
          -v https="$APIPOOL_CADDY_CANDIDATE_HTTPS_PORT" \
          '$5 ~ ":(" http "|" https ")$" { found = 1 } END { exit found }'; then
      :
    else
      echo "[caddy-upgrade] candidate listeners remain after stop" >&2
      return 70
    fi
    systemctl reset-failed "$CANDIDATE_UNIT" >/dev/null 2>&1 || true
    CANDIDATE_STARTED=0
  fi
}

stop_stream_test() {
  if [ "$STREAM_CURL_PID" -gt 0 ]; then
    kill "$STREAM_CURL_PID" >/dev/null 2>&1 || true
    wait "$STREAM_CURL_PID" >/dev/null 2>&1 || true
    STREAM_CURL_PID=0
  fi
  if [ "$STREAM_TEST_STARTED" -eq 1 ] \
    || systemctl status "$CANDIDATE_STREAM_UNIT" >/dev/null 2>&1; then
    systemctl stop "$CANDIDATE_STREAM_UNIT" >/dev/null 2>&1 || true
    systemctl reset-failed "$CANDIDATE_STREAM_UNIT" >/dev/null 2>&1 || true
    STREAM_TEST_STARTED=0
  fi
}

restore_file_or_absence() {
  local saved="$1"
  local absent_marker="$2"
  local destination="$3"
  if [ -f "$saved" ] || [ -L "$saved" ]; then
    rm -f -- "$destination"
    cp -a -- "$saved" "$destination"
  elif [ -f "$absent_marker" ]; then
    rm -f -- "$destination"
  fi
}

restore_runtime_files() {
  if [ "$DROPIN_CHANGED" -eq 1 ]; then
    restore_file_or_absence \
      "$ROLLBACK_DIR/caddy-apipool.conf" \
      "$ROLLBACK_DIR/caddy-apipool.conf.absent" \
      "$DROPIN_FILE"
    restore_file_or_absence \
      "$ROLLBACK_DIR/caddy-cli" \
      "$ROLLBACK_DIR/caddy-cli.absent" \
      "$CLI_FILE"
    systemctl daemon-reload
    DROPIN_CHANGED=0
  fi
  if [ "$APT_HOLD_CHANGED" -eq 1 ]; then
    apt-mark unhold caddy >/dev/null 2>&1 || true
    APT_HOLD_CHANGED=0
  fi
}

rollback_on_error() {
  local rc="$1"
  local candidate_stopped=1
  trap - EXIT ERR INT TERM
  set +e
  echo "[caddy-upgrade] failure detected; restoring previous runtime" >&2

  # 新连接先回到仍在运行的旧主实例；若主实例已被触碰，则候选继续接流，
  # 直到旧配置和 unit 恢复并成功启动。
  if [ "$SYSTEM_TOUCHED" -eq 0 ]; then
    if ! remove_cutover_nat; then
      echo "[caddy-upgrade] candidate remains active because NAT rollback failed" >&2
      echo "[caddy-upgrade] runners remain paused; recovery files remain in $RUN_DIR" >&2
      exit "$rc"
    fi
  fi

  if [ "$SYSTEM_TOUCHED" -eq 1 ]; then
    systemctl stop caddy >/dev/null 2>&1 || true
    if [ "$LIVE_FILES_CHANGED" -eq 1 ]; then
      install -m 0644 "$ROLLBACK_DIR/Caddyfile" "$CADDY_ROOT_FILE"
      install -m 0644 "$ROLLBACK_DIR/apipool-v2.caddy" "$CADDY_V2_FRAGMENT"
      install -m 0644 "$ROLLBACK_DIR/apipool-legacy.caddy" "$CADDY_LEGACY_FRAGMENT"
    fi
    restore_runtime_files
    systemctl start caddy >/dev/null 2>&1 || true
    if systemctl is-active --quiet caddy; then
      if ! remove_cutover_nat; then
        echo "[caddy-upgrade] candidate remains active because NAT rollback failed" >&2
        echo "[caddy-upgrade] runners remain paused; recovery files remain in $RUN_DIR" >&2
        exit "$rc"
      fi
    else
      echo "[caddy-upgrade] rollback could not restart caddy; candidate remains the recovery path" >&2
      echo "[caddy-upgrade] runners remain paused; recovery files remain in $RUN_DIR" >&2
      exit "$rc"
    fi
  else
    restore_runtime_files
  fi

  stop_stream_test
  if ! stop_candidate; then
    candidate_stopped=0
    echo "[caddy-upgrade] candidate and recovery files require manual cleanup" >&2
  fi
  if [ "$candidate_stopped" -eq 1 ]; then
    remove_filter_rules
  fi
  restore_runners || true
  if [ "$NAT_ACTIVE" -eq 0 ] && [ "$candidate_stopped" -eq 1 ]; then
    rm -f -- "$CANDIDATE_LOG" "$CANDIDATE_LOG".*
    rm -rf -- "$CANDIDATE_STATE_DIR" "$RUN_DIR"
  fi
  exit "$rc"
}

on_exit() {
  local rc="$?"
  if [ "$rc" -ne 0 ] && [ "$COMMITTED" -eq 0 ]; then
    rollback_on_error "$rc"
  fi
}
trap on_exit EXIT
trap 'exit 130' INT TERM

atomic_install() {
  local source_file="$1"
  local target_file="$2"
  local target_dir=""
  local target_name=""
  local tmp=""
  target_dir="$(dirname -- "$target_file")"
  target_name="$(basename -- "$target_file")"
  tmp="$(mktemp "$target_dir/.${target_name}.upgrade.XXXXXX")"
  install -m 0644 "$source_file" "$tmp"
  mv -f -- "$tmp" "$target_file"
}

write_candidate_root() {
  local destination="$1"
  local import_line="$2"
  cat >"$destination" <<EOF
{
	admin $APIPOOL_CADDY_CANDIDATE_ADMIN
	http_port $APIPOOL_CADDY_CANDIDATE_HTTP_PORT
	https_port $APIPOOL_CADDY_CANDIDATE_HTTPS_PORT
	grace_period $APIPOOL_CADDY_GRACE_PERIOD
	persist_config off
	storage file_system {
		root $CANDIDATE_STATE_DIR/storage
	}
}

$import_line
EOF
}

ensure_legacy_stream_close_delay() {
  local fragment="$1"
  if grep -Eq '^[[:space:]]*stream_close_delay[[:space:]]+' "$fragment"; then
    if ! grep -Eq "^[[:space:]]*stream_close_delay[[:space:]]+$APIPOOL_CADDY_STREAM_CLOSE_DELAY[[:space:]]*$" \
      "$fragment"; then
      echo "[caddy-upgrade] legacy stream_close_delay is unmanaged" >&2
      return 78
    fi
    return 0
  fi
  if ! grep -Eq '^[[:space:]]*flush_interval[[:space:]]+-1[[:space:]]*$' "$fragment"; then
    echo "[caddy-upgrade] legacy proxy shape cannot be hardened safely" >&2
    return 78
  fi
  sed -i \
    "/^[[:space:]]*flush_interval[[:space:]]/a\\
\t\tstream_close_delay $APIPOOL_CADDY_STREAM_CLOSE_DELAY" \
    "$fragment"
  grep -Eq "^[[:space:]]*stream_close_delay[[:space:]]+$APIPOOL_CADDY_STREAM_CLOSE_DELAY[[:space:]]*$" \
    "$fragment"
}

prepare_candidate_state() {
  local binary="$1"
  if [ -e "$CANDIDATE_STATE_DIR" ] || [ -L "$CANDIDATE_STATE_DIR" ]; then
    echo "[caddy-upgrade] stale candidate state exists: $CANDIDATE_STATE_DIR" >&2
    return 75
  fi
  install -d -o caddy -g caddy -m 0700 \
    "$CANDIDATE_STATE_DIR" "$CANDIDATE_STATE_DIR/storage" \
    "$CANDIDATE_STATE_DIR/home" "$CANDIDATE_STATE_DIR/config" \
    "$CANDIDATE_STATE_DIR/data"
  cp -a -- /var/lib/caddy/.local/share/caddy/. "$CANDIDATE_STATE_DIR/storage/"
  chown -R caddy:caddy "$CANDIDATE_STATE_DIR"
  runuser -u caddy -- \
    "$binary" validate --config "$CANDIDATE_CONFIG_DIR/Caddyfile" --adapter caddyfile
}

start_candidate() {
  local binary="$1"
  # /run 在目标机以 noexec 挂载；候选二进制放入独立且会清理的 /var/lib 状态目录。
  local service_binary="$CANDIDATE_STATE_DIR/caddy"
  install -o root -g caddy -m 0750 "$binary" "$service_binary"
  if ! systemd-run \
    --unit="$CANDIDATE_UNIT" \
    --service-type=notify \
    --property=User=caddy \
    --property=Group=caddy \
    --property=PrivateTmp=true \
    --property=NoNewPrivileges=true \
    --property=TimeoutStartSec=30s \
    --property="TimeoutStopSec=$APIPOOL_CADDY_TIMEOUT_STOP_SEC" \
    --setenv="HOME=$CANDIDATE_STATE_DIR/home" \
    --setenv="XDG_CONFIG_HOME=$CANDIDATE_STATE_DIR/config" \
    --setenv="XDG_DATA_HOME=$CANDIDATE_STATE_DIR/data" \
    "$service_binary" run --environ --config "$CANDIDATE_CONFIG_DIR/Caddyfile"; then
    # systemd-run 可能已创建失败的 transient unit；统一清理必须能看到它。
    CANDIDATE_STARTED=1
    return 70
  fi
  CANDIDATE_STARTED=1
  for _ in $(seq 1 30); do
    systemctl is-active --quiet "$CANDIDATE_UNIT" && break
    sleep 1
  done
  systemctl is-active --quiet "$CANDIDATE_UNIT"
}

probe_candidate() {
  local host="$1"
  local path="$2"
  local expected="$3"
  local headers="$RUN_DIR/headers"
  local code=""
  code="$(curl --silent --show-error --max-time 15 \
    --resolve "$host:$APIPOOL_CADDY_CANDIDATE_HTTPS_PORT:127.0.0.1" \
    --dump-header "$headers" --output /dev/null --write-out '%{http_code}' \
    "https://$host:$APIPOOL_CADDY_CANDIDATE_HTTPS_PORT$path")"
  if [ "$code" != "$expected" ]; then
    echo "[caddy-upgrade] candidate probe failed: $host$path -> $code" >&2
    return 1
  fi
  if ! grep -Eiq '^x-apipool-caddy-cutover:[[:space:]]*candidate' "$headers"; then
    echo "[caddy-upgrade] candidate marker missing: $host$path" >&2
    return 1
  fi
  if grep -Eiq "^alt-svc:.*:${APIPOOL_CADDY_CANDIDATE_HTTPS_PORT}([\";]|$)" "$headers" \
    || ! grep -Eiq '^alt-svc:.*:443([";]|$)' "$headers"; then
    echo "[caddy-upgrade] candidate advertised an unsafe Alt-Svc port: $host$path" >&2
    return 1
  fi
}

verify_candidate_routes() {
  probe_candidate apipool.dev /health 200
  probe_candidate app.apipool.dev / 403
  probe_candidate api2.apipool.dev /v1/models 401
  probe_candidate newapi.apipool.dev / 403
}

probe_public_candidate() {
  local host="$1"
  local path="$2"
  local expected="$3"
  local transport="${4:-tcp}"
  local headers="$RUN_DIR/public-${host}.headers"
  local code=""
  local -a curl_transport=()
  if [ "$transport" = "http3" ]; then
    curl_transport=(--http3-only)
  fi
  code="$(curl --silent --show-error --max-time 8 "${curl_transport[@]}" \
    --dump-header "$headers" --output /dev/null --write-out '%{http_code}' \
    "https://$host$path")"
  [ "$code" = "$expected" ] || return 1
  grep -Eiq '^x-apipool-caddy-cutover:[[:space:]]*candidate' "$headers" || return 1
  ! grep -Eiq "^alt-svc:.*:${APIPOOL_CADDY_CANDIDATE_HTTPS_PORT}([\";]|$)" "$headers"
}

verify_external_candidate_paths() {
  local http_code=""
  local deadline=$((SECONDS + APIPOOL_CADDY_EXTERNAL_GATE_TIMEOUT_SECONDS))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if probe_public_candidate apipool.dev /health 200 \
      && probe_public_candidate app.apipool.dev / 200 \
      && probe_public_candidate api.apipool.dev /health 200 \
      && probe_public_candidate api2.apipool.dev /v1/models 401 \
      && probe_public_candidate newapi.apipool.dev / 200 \
      && probe_public_candidate api2.apipool.dev /v1/models 401 http3; then
      http_code="$(curl --silent --show-error --max-time 8 \
        --output /dev/null --write-out '%{http_code}' http://api2.apipool.dev/)"
      if [ "$http_code" = "308" ]; then
        echo "[caddy-upgrade] Cloudflare, qingyun, direct TCP/HTTP, and direct HTTP/3 reached candidate"
        return 0
      fi
    fi
    sleep 1
  done
  echo "[caddy-upgrade] real external entrypoint gate did not reach candidate" >&2
  return 70
}

verify_no_recent_websocket_upgrades() {
  local active_since=""
  local active_since_epoch=""
  local now_epoch=""
  local required_since=""
  local result=""
  local count=""
  local oldest=""
  local files=""
  if [ ! -f "$CADDY_ACCESS_LOG" ] || [ -L "$CADDY_ACCESS_LOG" ]; then
    echo "[caddy-upgrade] legacy access log is unavailable for websocket gate" >&2
    return 70
  fi
  active_since="$(systemctl show caddy --property ActiveEnterTimestamp --value)"
  active_since_epoch="$(date -d "$active_since" +%s)"
  now_epoch="$(date +%s)"
  required_since=$((now_epoch - APIPOOL_CADDY_WEBSOCKET_LOOKBACK_SECONDS))
  if [ "$active_since_epoch" -gt "$required_since" ]; then
    required_since="$active_since_epoch"
  fi

  result="$(python3 - "$CADDY_ACCESS_LOG" "$required_since" <<'PY'
import glob
import gzip
import json
import os
import sys

path = sys.argv[1]
required_since = float(sys.argv[2])
stem, _ = os.path.splitext(path)
paths = [path]
paths.extend(glob.glob(stem + "-*.log"))
paths.extend(glob.glob(stem + "-*.log.gz"))
paths = sorted(set(paths))
count = 0
oldest = None
for candidate in paths:
    opener = gzip.open if candidate.endswith(".gz") else open
    with opener(candidate, mode="rt", encoding="utf-8") as stream:
        for line in stream:
            try:
                record = json.loads(line)
                timestamp = float(record.get("ts", 0))
            except (TypeError, ValueError):
                continue
            if timestamp <= 0:
                continue
            oldest = timestamp if oldest is None else min(oldest, timestamp)
            if timestamp >= required_since and record.get("status") == 101:
                count += 1
print(count, int(oldest or 0), len(paths))
PY
)"
  read -r count oldest files <<<"$result"
  if [ -z "$oldest" ] || [ "$oldest" -eq 0 ] || [ "$files" -eq 0 ]; then
    echo "[caddy-upgrade] websocket history is empty or unreadable" >&2
    return 70
  fi
  # Caddy 启动后第一条健康/业务访问可能略晚；允许五分钟日志起始容差。
  if [ "$oldest" -gt $((required_since + 300)) ]; then
    echo "[caddy-upgrade] websocket history does not cover the required window" >&2
    return 70
  fi
  if [ "$count" != "0" ]; then
    echo "[caddy-upgrade] recent websocket upgrades make the old-runtime drain unsafe: $count" >&2
    return 70
  fi
  echo "[caddy-upgrade] no websocket upgrade found in $files active/rotated logs since $required_since"
}

reload_candidate_safely() {
  local binary="$1"
  local pid_before=""
  local pid_after=""
  local started_at=""
  pid_before="$(systemctl show "$CANDIDATE_UNIT" --property MainPID --value)"
  started_at="$(date --iso-8601=seconds)"
  runuser -u caddy -- \
    "$binary" reload --force --address "$APIPOOL_CADDY_CANDIDATE_ADMIN" \
      --config "$CANDIDATE_CONFIG_DIR/Caddyfile" --adapter caddyfile
  sleep "$APIPOOL_CADDY_RELOAD_STABILITY_SECONDS"
  systemctl is-active --quiet "$CANDIDATE_UNIT"
  pid_after="$(systemctl show "$CANDIDATE_UNIT" --property MainPID --value)"
  if [ -z "$pid_before" ] || [ "$pid_before" = "0" ] || [ "$pid_after" != "$pid_before" ]; then
    echo "[caddy-upgrade] candidate MainPID changed during reload" >&2
    return 70
  fi
  if journalctl -u "$CANDIDATE_UNIT" --since "$started_at" --no-pager -o cat \
    | grep -Eq 'panic:|missing cancel error|Main process exited|Failed with result|config is unchanged'; then
    echo "[caddy-upgrade] candidate crash signature detected after reload" >&2
    return 70
  fi
}

run_stream_reload_test() {
  local server_script="$RUN_DIR/stream-server.py"
  local output="$RUN_DIR/stream-output"
  cat >"$server_script" <<PY
import socket
import time

server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
server.bind(("127.0.0.1", $CANDIDATE_STREAM_PORT))
server.listen(1)
connection, _ = server.accept()
with connection:
    request = b""
    while b"\r\n\r\n" not in request:
        chunk = connection.recv(4096)
        if not chunk:
            raise RuntimeError("client disconnected before request headers")
        request += chunk
    connection.sendall(
        b"HTTP/1.1 200 OK\r\n"
        b"Content-Type: text/plain\r\n"
        b"Content-Length: 13\r\n"
        b"Connection: close\r\n\r\n"
        b"before\n"
    )
    time.sleep(8)
    connection.sendall(b"after\n")
server.close()
PY
  chmod 0644 "$server_script"
  systemd-run \
    --unit="$CANDIDATE_STREAM_UNIT" \
    --service-type=simple \
    --property=User=caddy \
    --property=Group=caddy \
    --property=PrivateTmp=true \
    --property=NoNewPrivileges=true \
    /usr/bin/python3 "$server_script"
  STREAM_TEST_STARTED=1

  curl --silent --show-error --fail --no-buffer --max-time 20 \
    --retry 20 --retry-connrefused --retry-delay 0 \
    --resolve "caddy-stream-test.invalid:$APIPOOL_CADDY_CANDIDATE_HTTP_PORT:127.0.0.1" \
    "http://caddy-stream-test.invalid:$APIPOOL_CADDY_CANDIDATE_HTTP_PORT/" \
    >"$output" &
  STREAM_CURL_PID=$!
  for _ in $(seq 1 50); do
    grep -Fq before "$output" 2>/dev/null && break
    sleep 0.1
  done
  grep -Fq before "$output"
  reload_candidate_safely "$1"
  wait "$STREAM_CURL_PID"
  STREAM_CURL_PID=0
  if [ "$(cat "$output")" != $'before\nafter' ]; then
    echo "[caddy-upgrade] long stream did not survive candidate reload" >&2
    return 70
  fi
  stop_stream_test
}

remove_candidate_stream_route() {
  rm -f -- "$CANDIDATE_CONFIG_DIR/sites-enabled/runtime-stream-test.caddy"
  reload_candidate_safely "$1"
}

prepare_staged_configs() {
  local rendered_v2="$TARGET_STAGE_DIR/apipool-v2.caddy"
  local target_sites="$TARGET_STAGE_DIR/sites-enabled"
  local candidate_sites="$CANDIDATE_CONFIG_DIR/sites-enabled"
  local fragment=""
  local name=""
  local tmp=""

  install -d -m 0755 "$target_sites"
  install -d -o root -g caddy -m 0750 "$candidate_sites"
  APIPOOL_DEPLOY_ENV_FILE="$ENV_FILE" \
    "$SCRIPT_DIR/configure-caddy.sh" --print-config >"$rendered_v2"
  "$INPUT_BINARY" fmt --overwrite "$rendered_v2"

  for fragment in "$CADDY_SITES_DIR"/*.caddy; do
    if [ ! -e "$fragment" ] && [ ! -L "$fragment" ]; then
      continue
    fi
    [ "$fragment" = "$CADDY_V2_FRAGMENT" ] && continue
    cp -a -- "$fragment" "$target_sites/"
  done
  install -m 0644 "$rendered_v2" "$target_sites/apipool-v2.caddy"
  ensure_legacy_stream_close_delay "$target_sites/apipool-legacy.caddy"

  write_managed_caddy_root \
    "$TARGET_STAGE_DIR/Caddyfile" "import $target_sites/*.caddy"
  write_managed_caddy_root \
    "$TARGET_STAGE_DIR/Caddyfile.live" "import $CADDY_SITES_DIR/*.caddy"
  "$INPUT_BINARY" fmt --overwrite "$TARGET_STAGE_DIR/Caddyfile"
  "$INPUT_BINARY" fmt --overwrite "$TARGET_STAGE_DIR/Caddyfile.live"
  "$INPUT_BINARY" validate \
    --config "$TARGET_STAGE_DIR/Caddyfile" --adapter caddyfile

  for fragment in "$target_sites"/*.caddy; do
    name="$(basename -- "$fragment")"
    tmp="$CANDIDATE_CONFIG_DIR/.${name}.tmp"
    awk '
      /^[^[:space:]#].*\{[[:space:]]*$/ {
        print
        print "\theader X-APIPool-Caddy-Cutover candidate"
        print "\theader >Alt-Svc \"h3=\\\":443\\\"; ma=2592000\""
        next
      }
      { print }
    ' "$fragment" >"$tmp"
    if [ "$name" = "apipool-legacy.caddy" ]; then
      sed \
        -e 's#/var/log/caddy/apipool\.dev\.log#/var/log/caddy/apipool.dev.candidate.log#g' \
        "$tmp" >"$candidate_sites/$name"
    else
      install -m 0644 "$tmp" "$candidate_sites/$name"
    fi
    "$INPUT_BINARY" fmt --overwrite "$candidate_sites/$name"
  done

  cat >"$candidate_sites/runtime-stream-test.caddy" <<EOF
http://caddy-stream-test.invalid {
	reverse_proxy 127.0.0.1:$CANDIDATE_STREAM_PORT {
		flush_interval -1
		stream_close_delay $APIPOOL_CADDY_STREAM_CLOSE_DELAY
	}
}
EOF
  "$INPUT_BINARY" fmt --overwrite "$candidate_sites/runtime-stream-test.caddy"

  write_candidate_root \
    "$CANDIDATE_CONFIG_DIR/Caddyfile" "import $candidate_sites/*.caddy"
  "$INPUT_BINARY" fmt --overwrite "$CANDIDATE_CONFIG_DIR/Caddyfile"
  install -o caddy -g caddy -m 0640 /dev/null "$CANDIDATE_LOG"
  "$INPUT_BINARY" validate \
    --config "$CANDIDATE_CONFIG_DIR/Caddyfile" --adapter caddyfile
  chown -R root:caddy "$CANDIDATE_CONFIG_DIR"
  find "$CANDIDATE_CONFIG_DIR" -type d -exec chmod 0750 {} +
  find "$CANDIDATE_CONFIG_DIR" -type f -exec chmod 0640 {} +
}

cat >"$NFT_FILE" <<EOF
insert rule inet apipool_ingress input ct status dnat tcp dport { $APIPOOL_CADDY_CANDIDATE_HTTP_PORT, $APIPOOL_CADDY_CANDIDATE_HTTPS_PORT } accept comment "$CUTOVER_COMMENT"
insert rule inet apipool_ingress input ct status dnat udp dport $APIPOOL_CADDY_CANDIDATE_HTTPS_PORT accept comment "$CUTOVER_COMMENT"

table inet $CUTOVER_TABLE {
	chain prerouting {
		type nat hook prerouting priority -110; policy accept;
		tcp dport 80 counter redirect to :$APIPOOL_CADDY_CANDIDATE_HTTP_PORT
		tcp dport 443 counter redirect to :$APIPOOL_CADDY_CANDIDATE_HTTPS_PORT
		udp dport 443 counter redirect to :$APIPOOL_CADDY_CANDIDATE_HTTPS_PORT
	}
}
EOF

if [ "$MODE" = "--preflight" ]; then
  prepare_staged_configs
  nft --check --file "$NFT_FILE"
  printf '[caddy-upgrade] preflight passed: version=%s go=%s sha256=%s\n' \
    "$APIPOOL_CADDY_VERSION" "$APIPOOL_CADDY_GO_VERSION" "$APIPOOL_CADDY_BINARY_SHA256"
  COMMITTED=1
  rm -f -- "$CANDIDATE_LOG" "$CANDIDATE_LOG".*
  rm -rf -- "$RUN_DIR"
  exit 0
fi

if [ "$MODE" = "--candidate-test" ]; then
  prepare_staged_configs
  nft --check --file "$NFT_FILE"
  prepare_candidate_state "$INPUT_BINARY"
  start_candidate "$INPUT_BINARY"
  verify_candidate_routes
  run_stream_reload_test "$INPUT_BINARY"
  remove_candidate_stream_route "$INPUT_BINARY"
  assert_production_autosave_unchanged
  stop_candidate
  remove_filter_rules
  rm -rf -- "$CANDIDATE_STATE_DIR"
  rm -f -- "$CANDIDATE_LOG" "$CANDIDATE_LOG".*
  COMMITTED=1
  rm -rf -- "$RUN_DIR"
  printf '[caddy-upgrade] isolated candidate passed routes and two safe reloads\n'
  exit 0
fi

# 应用模式先冻结全部生产发布入口并获取三套部署锁，再读取 live 配置，
# 避免候选树在校验后、真正切流前被另一次发布改写。
exec 10>"/run/apipool-caddy.lock"
flock -n 10 || { echo "[caddy-upgrade] Caddy config lock is busy" >&2; exit 75; }
exec 11>"/run/apipool-v2-deploy.lock"
flock -n 11 || { echo "[caddy-upgrade] APIPool v2 deploy lock is busy" >&2; exit 75; }
exec 12>"/run/sub2api-deploy.lock"
flock -n 12 || { echo "[caddy-upgrade] legacy deploy lock is busy" >&2; exit 75; }
exec 13>"/run/new-api-deploy.lock"
flock -n 13 || { echo "[caddy-upgrade] New API deploy lock is busy" >&2; exit 75; }

verify_legacy_writer_contract

for service in "${RUNNER_SERVICES[@]}"; do
  if ! systemctl is-active --quiet "$service"; then
    echo "[caddy-upgrade] runner is not active before cutover: $service" >&2
    exit 70
  fi
done
RUNNERS_STOPPED=1
for service in "${RUNNER_SERVICES[@]}"; do
  systemctl stop "$service"
done
echo "[caddy-upgrade] production runners paused; containers remain running"

prepare_staged_configs
nft --check --file "$NFT_FILE"

install -d -m 0700 "$BACKUP_DIR"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_stage="$RUN_DIR/backup-stage"
backup_archive="$BACKUP_DIR/caddy-runtime-$timestamp.tar.gz"
install -d -m 0700 "$backup_stage"
cp -a -- /etc/caddy "$backup_stage/etc-caddy"
cp -a -- /var/lib/caddy "$backup_stage/var-lib-caddy"
cp -a -- /usr/lib/systemd/system/caddy.service "$backup_stage/caddy.service"
cp -a -- "$CADDY_ROOT_FILE" "$ROLLBACK_DIR/Caddyfile"
cp -a -- "$CADDY_V2_FRAGMENT" "$ROLLBACK_DIR/apipool-v2.caddy"
cp -a -- "$CADDY_LEGACY_FRAGMENT" "$ROLLBACK_DIR/apipool-legacy.caddy"
nft -a list ruleset >"$backup_stage/nft-ruleset.txt"
if [ -e "$DROPIN_FILE" ] || [ -L "$DROPIN_FILE" ]; then
  cp -a -- "$DROPIN_FILE" "$ROLLBACK_DIR/caddy-apipool.conf"
else
  : >"$ROLLBACK_DIR/caddy-apipool.conf.absent"
fi
if [ -e "$CLI_FILE" ] || [ -L "$CLI_FILE" ]; then
  cp -a -- "$CLI_FILE" "$ROLLBACK_DIR/caddy-cli"
else
  : >"$ROLLBACK_DIR/caddy-cli.absent"
fi
tar -C "$backup_stage" -czf "$backup_archive" .
chown root:root "$backup_archive"
chmod 0600 "$backup_archive"
tar -tzf "$backup_archive" >/dev/null
echo "[caddy-upgrade] restricted sensitive-material backup created: $backup_archive"

install -d -o root -g root -m 0755 "$APIPOOL_CADDY_RUNTIME_DIR"
install -o root -g root -m 0755 "$INPUT_BINARY" "$APIPOOL_CADDY_BIN"
verify_caddy_binary "$APIPOOL_CADDY_BIN"
DROPIN_CHANGED=1
install -o root -g root -m 0755 "$APIPOOL_CADDY_BIN" "$CLI_FILE"
install -d -o root -g root -m 0755 "$DROPIN_DIR"
install -o root -g root -m 0644 \
  "$SCRIPT_DIR/systemd/caddy-apipool.conf" "$DROPIN_FILE"
systemctl daemon-reload
if dpkg-query -W -f='${Status}' caddy 2>/dev/null | grep -q 'install ok installed' \
  && ! apt-mark showhold | grep -Fxq caddy; then
  apt-mark hold caddy >/dev/null
  APT_HOLD_CHANGED=1
fi

prepare_candidate_state "$APIPOOL_CADDY_BIN"
start_candidate "$APIPOOL_CADDY_BIN"
verify_candidate_routes
run_stream_reload_test "$APIPOOL_CADDY_BIN"
remove_candidate_stream_route "$APIPOOL_CADDY_BIN"
assert_production_autosave_unchanged
echo "[caddy-upgrade] isolated candidate passed TLS, routing, and origin-ACL probes"

nft --file "$NFT_FILE"
NAT_ACTIVE=1
echo "[caddy-upgrade] new TCP/UDP connections redirected to candidate"

for _ in $(seq 1 30); do
  packets="$(nft list table inet "$CUTOVER_TABLE" \
    | awk '/counter packets/ {
        for (i = 1; i <= NF; i++) {
          if ($i == "packets") total += $(i + 1)
        }
      }
      END { print total + 0 }')"
  if [ "$packets" -gt 0 ]; then
    break
  fi
  sleep 1
done
if [ "${packets:-0}" -le 0 ]; then
  echo "[caddy-upgrade] no external traffic reached the candidate" >&2
  exit 70
fi
systemctl is-active --quiet "$CANDIDATE_UNIT"
verify_external_candidate_paths
verify_no_recent_websocket_upgrades

old_pid="$(active_caddy_pid)"
old_established="$(ss -Hntp state established \
  | grep -Fc "pid=$old_pid," || true)"
echo "[caddy-upgrade] old runtime graceful-drain starting with $old_established established sockets"

SYSTEM_TOUCHED=1
stop_started_at="$(date --iso-8601=seconds)"
echo "[caddy-upgrade] gracefully draining Caddy 2.6.2; candidate is serving new connections"
systemctl stop caddy
if journalctl -u caddy --since "$stop_started_at" --no-pager -o cat \
  | grep -Eq "timed out|status=9/KILL|Failed with result"; then
  echo "[caddy-upgrade] old Caddy did not drain cleanly" >&2
  exit 70
fi
systemctl is-active --quiet "$CANDIDATE_UNIT"

LIVE_FILES_CHANGED=1
atomic_install "$TARGET_STAGE_DIR/apipool-v2.caddy" "$CADDY_V2_FRAGMENT"
atomic_install \
  "$TARGET_STAGE_DIR/sites-enabled/apipool-legacy.caddy" \
  "$CADDY_LEGACY_FRAGMENT"
atomic_install "$TARGET_STAGE_DIR/Caddyfile.live" "$CADDY_ROOT_FILE"

systemctl start caddy
verify_active_caddy_runtime
"$APIPOOL_CADDY_BIN" validate --config "$CADDY_ROOT_FILE" --adapter caddyfile

probe_main() {
  local host="$1"
  local path="$2"
  local expected="$3"
  local code=""
  code="$(curl --silent --show-error --max-time 15 \
    --resolve "$host:443:127.0.0.1" \
    --output /dev/null --write-out '%{http_code}' "https://$host$path")"
  if [ "$code" != "$expected" ]; then
    echo "[caddy-upgrade] main probe failed: $host$path -> $code" >&2
    return 1
  fi
}

probe_main apipool.dev /health 200
probe_main app.apipool.dev / 403
probe_main api2.apipool.dev /v1/models 401
probe_main newapi.apipool.dev / 403
reload_caddy_safely "$CADDY_ROOT_FILE"
echo "[caddy-upgrade] managed Caddy passed start, local routes, and forced reload"

remove_cutover_nat
COMMITTED=1
echo "[caddy-upgrade] new connections returned to managed ports 80/443"
if ! stop_candidate; then
  restore_runners || true
  echo "[caddy-upgrade] managed runtime is active; candidate cleanup requires manual follow-up" >&2
  trap - EXIT INT TERM
  exit 70
fi
remove_filter_rules

rm -rf -- "$CANDIDATE_STATE_DIR"
rm -f -- "$CANDIDATE_LOG" "$CANDIDATE_LOG".*
if ! restore_runners; then
  echo "[caddy-upgrade] runtime upgrade succeeded, but one or more runners remain stopped" >&2
  trap - EXIT INT TERM
  exit 70
fi

trap - EXIT INT TERM
rm -rf -- "$RUN_DIR"
printf '[caddy-upgrade] complete version=%s go=%s sha256=%s backup=%s\n' \
  "$APIPOOL_CADDY_VERSION" "$APIPOOL_CADDY_GO_VERSION" \
  "$APIPOOL_CADDY_BINARY_SHA256" "$backup_archive"
