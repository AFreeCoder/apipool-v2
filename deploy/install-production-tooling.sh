#!/usr/bin/env bash
set -Eeuo pipefail

# 只能由 owner 经 SSH 显式调用。GitHub Actions Runner 不允许更新这套 root 工具链。

if [ "$(id -u)" -ne 0 ]; then
  echo "install-production-tooling.sh: 必须以 root 运行" >&2
  exit 77
fi

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_ROOT="$(realpath -e -- "${1:-$SCRIPT_DIR/..}")"
APP_DIR="/opt/apipool-v2"

for required in docker-compose.prod.yml deploy/deploy.sh deploy/backup.sh deploy/configure-caddy.sh deploy/cloudflare-ips.txt; do
  if [ ! -f "$SOURCE_ROOT/$required" ]; then
    echo "install-production-tooling.sh: 缺少源文件：$required" >&2
    exit 66
  fi
done

if find "$SOURCE_ROOT/deploy" -type l -print -quit | grep -q . \
  || [ -L "$SOURCE_ROOT/docker-compose.prod.yml" ]; then
  echo "install-production-tooling.sh: 部署件中不允许出现符号链接" >&2
  exit 77
fi

install -d -o root -g root -m 0755 "$APP_DIR" "$APP_DIR/deploy"
install -d -o root -g root -m 0700 "$APP_DIR/backups"

if [ -f "$APP_DIR/docker-compose.prod.yml" ] && [ -d "$APP_DIR/deploy" ]; then
  backup="$APP_DIR/backups/tooling-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
  tar -C "$APP_DIR" -czf "$backup" docker-compose.prod.yml deploy
  chown root:root "$backup"
  chmod 0600 "$backup"
  echo "[tooling] 旧工具链备份：$backup"
fi

install -o root -g root -m 0644 \
  "$SOURCE_ROOT/docker-compose.prod.yml" "$APP_DIR/docker-compose.prod.yml"

while IFS= read -r -d '' source_file; do
  relative_path="${source_file#"$SOURCE_ROOT/deploy/"}"
  mode=0644
  case "$relative_path" in
    *.sh) mode=0755 ;;
  esac
  install -D -o root -g root -m "$mode" \
    "$source_file" "$APP_DIR/deploy/$relative_path"
done < <(find "$SOURCE_ROOT/deploy" -type f -print0)

echo "[tooling] 已安装 root-owned 生产部署工具链"
