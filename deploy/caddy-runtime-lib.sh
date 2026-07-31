#!/usr/bin/env bash

CADDY_RUNTIME_SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/caddy-runtime.env
. "$CADDY_RUNTIME_SCRIPT_DIR/caddy-runtime.env"

APIPOOL_CADDY_BIN="${APIPOOL_CADDY_BIN_OVERRIDE:-$APIPOOL_CADDY_BIN}"

write_managed_caddy_root() {
  local destination="$1"
  local import_line="$2"
  cat >"$destination" <<EOF
# Shared Caddy entrypoint. Service-owned configs live in sites-enabled.
{
	grace_period $APIPOOL_CADDY_GRACE_PERIOD
}

$import_line
EOF
}

verify_caddy_binary() {
  local binary="${1:-$APIPOOL_CADDY_BIN}"
  local actual_sha=""
  local actual_version=""

  if [ ! -f "$binary" ] || [ ! -x "$binary" ] || [ -L "$binary" ]; then
    echo "caddy-runtime: missing or unsafe runtime binary: $binary" >&2
    return 69
  fi

  actual_version="$("$binary" version)"
  if [ "${APIPOOL_CADDY_TEST_MODE:-false}" = "true" ]; then
    case "$actual_version" in
      "$APIPOOL_CADDY_VERSION" | "$APIPOOL_CADDY_VERSION "*) return 0 ;;
      *)
        echo "caddy-runtime: test runtime version mismatch: $actual_version" >&2
        return 65
        ;;
    esac
  fi

  actual_sha="$(sha256sum "$binary" | awk '{print $1}')"
  if [ "$actual_sha" != "$APIPOOL_CADDY_BINARY_SHA256" ]; then
    echo "caddy-runtime: binary checksum mismatch: $actual_sha" >&2
    return 65
  fi
  if [ "$actual_version" != "$APIPOOL_CADDY_VERSION" ]; then
    echo "caddy-runtime: version mismatch" >&2
    return 65
  fi
  if ! "$binary" build-info | grep -Fqx $'go\t'"$APIPOOL_CADDY_GO_VERSION"; then
    echo "caddy-runtime: Go toolchain mismatch" >&2
    return 65
  fi
  if ! "$binary" build-info | grep -Fqx $'dep\tgithub.com/caddyserver/caddy/v2\t'"$APIPOOL_CADDY_VERSION"$'\t'; then
    echo "caddy-runtime: Caddy module version mismatch" >&2
    return 65
  fi
  if [ "$("$binary" list-modules --skip-standard --json)" != "[]" ]; then
    echo "caddy-runtime: non-standard modules are not allowed" >&2
    return 65
  fi
}

active_caddy_pid() {
  systemctl show caddy --property MainPID --value 2>/dev/null || true
}

verify_active_caddy_runtime() {
  local pid=""
  local expected=""
  local running=""

  if ! systemctl is-active --quiet caddy; then
    echo "caddy-runtime: caddy.service is not active" >&2
    return 70
  fi

  pid="$(active_caddy_pid)"
  if [ -z "$pid" ] || [ "$pid" = "0" ]; then
    # 单元测试会用最小 systemctl fixture；真实 systemd 必须提供 MainPID。
    if [ "${APIPOOL_CADDY_TEST_MODE:-false}" = "true" ]; then
      return 0
    fi
    echo "caddy-runtime: caddy.service has no MainPID" >&2
    return 70
  fi

  expected="$(realpath -e -- "$APIPOOL_CADDY_BIN")"
  running="$(readlink -f -- "/proc/$pid/exe" 2>/dev/null || true)"
  if [ "$running" != "$expected" ]; then
    echo "caddy-runtime: active process is not the managed runtime" >&2
    return 70
  fi
}

reload_caddy_safely() {
  local config_file="$1"
  local pid_before=""
  local pid_after=""
  local started_at=""

  verify_caddy_binary "$APIPOOL_CADDY_BIN"
  verify_active_caddy_runtime
  "$APIPOOL_CADDY_BIN" validate --config "$config_file" --adapter caddyfile

  pid_before="$(active_caddy_pid)"
  started_at="$(date --iso-8601=seconds 2>/dev/null || date)"
  systemctl reload caddy
  sleep "${APIPOOL_CADDY_RELOAD_STABILITY_SECONDS_OVERRIDE:-$APIPOOL_CADDY_RELOAD_STABILITY_SECONDS}"

  verify_active_caddy_runtime
  pid_after="$(active_caddy_pid)"
  if [ -n "$pid_before" ] && [ "$pid_before" != "0" ] && [ "$pid_after" != "$pid_before" ]; then
    echo "caddy-runtime: MainPID changed during reload" >&2
    return 70
  fi

  if [ "${APIPOOL_CADDY_TEST_MODE:-false}" != "true" ] \
    && journalctl -u caddy --since "$started_at" --no-pager -o cat \
      | grep -Eq 'panic:|missing cancel error|Main process exited|Failed with result'; then
    echo "caddy-runtime: crash signature detected after reload" >&2
    return 70
  fi
}
