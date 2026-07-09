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

chmod 0755 "$APP_DIR/deploy/backup.sh" "$APP_DIR/deploy/deploy.sh"

# configure-caddy.sh fail-closed：New API 运营面保护变量（Basic Auth / IP 白名单）
# 存放在 .env.deploy，必须在调用前载入，否则 Caddy 配置会被拒绝生成。
if [ -f "$APP_DIR/.env.deploy" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$APP_DIR/.env.deploy"
  set +a
fi

[ -f "$APP_DIR/deploy/configure-caddy.sh" ] && chmod 0755 "$APP_DIR/deploy/configure-caddy.sh" && "$APP_DIR/deploy/configure-caddy.sh"
install -m 0644 "$APP_DIR/deploy/systemd/apipool-v2-backup.service" /etc/systemd/system/apipool-v2-backup.service
install -m 0644 "$APP_DIR/deploy/systemd/apipool-v2-backup.timer" /etc/systemd/system/apipool-v2-backup.timer
systemctl daemon-reload
systemctl enable --now apipool-v2-backup.timer

docker --version
docker compose version
[ -x /usr/bin/caddy ] && caddy version
systemctl list-timers apipool-v2-backup.timer --no-pager
