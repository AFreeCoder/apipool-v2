#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APIPOOL_DEPLOY_DIR:-/opt/apipool-v2}"

if [ "$(id -u)" -ne 0 ]; then
  echo "server-bootstrap.sh must run as root" >&2
  exit 77
fi

install_docker_ce() {
  apt-get update
  apt-get install -y ca-certificates curl gnupg sqlite3
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc

  . /etc/os-release
  cat >/etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: ${VERSION_CODENAME}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF

  # Remove Debian-packaged Docker to align with Docker's official current stable packages.
  apt-get remove -y docker.io docker-compose docker-doc podman-docker containerd runc docker-buildx docker-cli 2>/dev/null || true
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
}

if ! dpkg-query -W -f='${Status}' docker-ce 2>/dev/null | grep -q "install ok installed"; then
  install_docker_ce
else
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  apt-get install -y sqlite3
  systemctl enable --now docker
fi

mkdir -p "$APP_DIR"/{data/portal,data/new-api,backups,deploy}
chown -R 1001:1001 "$APP_DIR/data/portal"
chmod 700 "$APP_DIR/backups"

# 首次引导只在整个文件不存在时创建显式 legacy 状态。已有文件即使缺行、
# 空值或非法也绝不修复，交给 configure-caddy fail-closed，避免重开后门。
if [ ! -e "$APP_DIR/.env.deploy" ]; then
  initial_env="$(mktemp "$APP_DIR/.env.deploy.init.XXXXXX")"
  printf '%s\n' 'APIPOOL_API_MODE=legacy' >"$initial_env"
  chmod 0600 "$initial_env"
  if [ ! -e "$APP_DIR/.env.deploy" ]; then
    mv "$initial_env" "$APP_DIR/.env.deploy"
  else
    rm -f "$initial_env"
  fi
fi

chmod 0755 "$APP_DIR/deploy/backup.sh" "$APP_DIR/deploy/deploy.sh"

# configure-caddy.sh fail-closed：New API 运营面保护变量（Basic Auth / IP 白名单）
# 存放在 .env.deploy。把文件路径交给它自己按字面量读取，**不要在这里 source**：
# bcrypt 哈希含 `$` 会被参数展开（`$2a$14$xxx` → `a4`），IP 白名单含空格会让
# shell 把第二个 IP 当命令执行，在 set -e 下直接中断自举。
[ -f "$APP_DIR/deploy/configure-caddy.sh" ] && chmod 0755 "$APP_DIR/deploy/configure-caddy.sh" && APIPOOL_DEPLOY_ENV_FILE="$APP_DIR/.env.deploy" "$APP_DIR/deploy/configure-caddy.sh"
install -m 0644 "$APP_DIR/deploy/systemd/apipool-v2-backup.service" /etc/systemd/system/apipool-v2-backup.service
install -m 0644 "$APP_DIR/deploy/systemd/apipool-v2-backup.timer" /etc/systemd/system/apipool-v2-backup.timer
systemctl daemon-reload
systemctl enable --now apipool-v2-backup.timer

docker --version
docker compose version
[ -x /usr/bin/caddy ] && caddy version
systemctl list-timers apipool-v2-backup.timer --no-pager
