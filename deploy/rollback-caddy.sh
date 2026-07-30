#!/usr/bin/env bash
set -Eeuo pipefail

# 仅回滚 APIPool v2 自己的 Caddy fragment。候选配置会连同 legacy/其他服务
# fragments 一起完整 validate，通过后才原子替换 live 文件。
CADDY_LOCK_FILE="${APIPOOL_CADDY_LOCK_FILE:-/run/apipool-caddy.lock}"
CADDY_ROOT_FILE="${APIPOOL_CADDY_ROOT_FILE:-/etc/caddy/Caddyfile}"
CADDY_SITES_DIR="${APIPOOL_CADDY_SITES_DIR:-/etc/caddy/sites-enabled}"
CADDY_FRAGMENT_FILE="$CADDY_SITES_DIR/apipool-v2.caddy"
CADDY_BACKUP_FILE="$CADDY_FRAGMENT_FILE.bak"
CADDY_IMPORT_LINE="import $CADDY_SITES_DIR/*.caddy"

if [ "$(id -u)" -ne 0 ]; then
  echo "rollback-caddy.sh must run as root" >&2
  exit 77
fi

for required_command in caddy flock; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "rollback-caddy.sh: missing required command: $required_command" >&2
    exit 69
  fi
done

lock_dir="$(dirname -- "$CADDY_LOCK_FILE")"
if [ ! -d "$lock_dir" ]; then
  install -d -m 0755 "$lock_dir"
fi
exec 8>"$CADDY_LOCK_FILE"
if ! flock -n 8; then
  echo "rollback-caddy.sh: another Caddy configuration update holds $CADDY_LOCK_FILE" >&2
  exit 75
fi

if [ ! -f "$CADDY_ROOT_FILE" ]; then
  echo "rollback-caddy.sh: missing root Caddyfile: $CADDY_ROOT_FILE" >&2
  exit 66
fi
if ! grep -Fqx "$CADDY_IMPORT_LINE" "$CADDY_ROOT_FILE"; then
  echo "rollback-caddy.sh: root Caddyfile does not use the shared import: $CADDY_IMPORT_LINE" >&2
  exit 78
fi
if [ ! -f "$CADDY_BACKUP_FILE" ]; then
  echo "rollback-caddy.sh: missing v2 fragment backup: $CADDY_BACKUP_FILE" >&2
  exit 66
fi

STAGING_DIR="$(mktemp -d)"
LIVE_TMP=""
cleanup() {
  if [ -n "$LIVE_TMP" ]; then
    rm -f -- "$LIVE_TMP"
  fi
  if [ -n "$STAGING_DIR" ] && [ -d "$STAGING_DIR" ]; then
    rm -rf -- "$STAGING_DIR"
  fi
}
trap cleanup EXIT

STAGED_SITES_DIR="$STAGING_DIR/sites-enabled"
STAGED_FRAGMENT_FILE="$STAGED_SITES_DIR/apipool-v2.caddy"
STAGED_ROOT_FILE="$STAGING_DIR/Caddyfile"
install -d -m 0755 "$STAGED_SITES_DIR"

for existing_fragment in "$CADDY_SITES_DIR"/*.caddy; do
  if [ ! -e "$existing_fragment" ] && [ ! -L "$existing_fragment" ]; then
    continue
  fi
  [ "$existing_fragment" = "$CADDY_FRAGMENT_FILE" ] && continue
  cp -a "$existing_fragment" "$STAGED_SITES_DIR/"
done

install -m 0644 "$CADDY_BACKUP_FILE" "$STAGED_FRAGMENT_FILE"
caddy fmt --overwrite "$STAGED_FRAGMENT_FILE"

# 保留根文件中的全局选项和其他共享指令，只让 import 指向候选 fragments。
awk -v live="$CADDY_IMPORT_LINE" -v staged="import $STAGED_SITES_DIR/*.caddy" '
  $0 == live { print staged; next }
  { print }
' "$CADDY_ROOT_FILE" >"$STAGED_ROOT_FILE"
caddy fmt --overwrite "$STAGED_ROOT_FILE"
caddy validate --config "$STAGED_ROOT_FILE" --adapter caddyfile

# validate 通过后再保留当前 live 版本，并在同目录原子替换。不要改写 .bak，
# 它是本次回滚的输入；.pre-rollback 可用于撤销一次误回滚。
if [ -f "$CADDY_FRAGMENT_FILE" ]; then
  cp -a "$CADDY_FRAGMENT_FILE" "$CADDY_FRAGMENT_FILE.pre-rollback"
fi
LIVE_TMP="$(mktemp "$CADDY_SITES_DIR/.apipool-v2.caddy.rollback.XXXXXX")"
install -m 0644 "$STAGED_FRAGMENT_FILE" "$LIVE_TMP"
mv -f -- "$LIVE_TMP" "$CADDY_FRAGMENT_FILE"
LIVE_TMP=""

systemctl reload caddy
echo "rollback-caddy.sh: restored $CADDY_BACKUP_FILE after full-tree validation"
