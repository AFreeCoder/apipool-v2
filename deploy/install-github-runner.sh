#!/usr/bin/env bash
set -Eeuo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "install-github-runner.sh must run as root" >&2
  exit 77
fi

for required_command in curl sha256sum tar runuser visudo nft systemctl systemd-run getent; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "install-github-runner.sh: missing command: $required_command" >&2
    exit 69
  fi
done

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_USER="apipool-runner"
RUNNER_HOME="/opt/actions-runner-apipool"
RUNNER_NAME="apipool-prod-deploy"
RUNNER_LABEL="apipool-prod-deploy"
REPOSITORY_URL="https://github.com/AFreeCoder/apipool-v2"
RUNNER_VERSION="${APIPOOL_RUNNER_VERSION:-2.335.1}"
RUNNER_SHA256="${APIPOOL_RUNNER_SHA256:-4ef2f25285f0ae4477f1fe1e346db76d2f3ebf03824e2ddd1973a2819bf6c8cf}"
RUNNER_ARCHIVE="actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz"
RUNNER_URL="https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/${RUNNER_ARCHIVE}"
EGRESS_CONFIG="/etc/nftables.d/apipool-runner-egress.nft"
EGRESS_SERVICE="/etc/systemd/system/apipool-runner-egress.service"

if [ ! -f "$SCRIPT_DIR/runner-deploy.sh" ]; then
  echo "install-github-runner.sh: missing $SCRIPT_DIR/runner-deploy.sh" >&2
  exit 66
fi

registration_token=""
IFS= read -r registration_token || true
if [ -z "$registration_token" ]; then
  echo "install-github-runner.sh: registration token is required on stdin" >&2
  exit 78
fi

if ! id "$RUNNER_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$RUNNER_HOME" --create-home --shell /usr/sbin/nologin "$RUNNER_USER"
fi

runner_passwd="$(getent passwd "$RUNNER_USER")"
runner_home_actual="$(printf '%s\n' "$runner_passwd" | cut -d: -f6)"
runner_shell_actual="$(printf '%s\n' "$runner_passwd" | cut -d: -f7)"
if [ "$runner_home_actual" != "$RUNNER_HOME" ] || [ "$runner_shell_actual" != "/usr/sbin/nologin" ]; then
  echo "install-github-runner.sh: existing runner user has an unexpected home or shell" >&2
  exit 77
fi

install -d -o "$RUNNER_USER" -g "$RUNNER_USER" -m 0750 "$RUNNER_HOME"

if [ ! -f "$RUNNER_HOME/.runner" ]; then
  archive="$(mktemp)"
  trap 'rm -f "$archive"' EXIT
  curl --fail --location --proto '=https' --tlsv1.2 "$RUNNER_URL" --output "$archive"
  printf '%s  %s\n' "$RUNNER_SHA256" "$archive" | sha256sum --check --status
  tar -xzf "$archive" -C "$RUNNER_HOME"
  chown -R "$RUNNER_USER:$RUNNER_USER" "$RUNNER_HOME"

  (
    cd "$RUNNER_HOME"
    ./bin/installdependencies.sh
    runuser -u "$RUNNER_USER" -- env HOME="$RUNNER_HOME" \
      ./config.sh \
        --url "$REPOSITORY_URL" \
        --token "$registration_token" \
        --name "$RUNNER_NAME" \
        --labels "$RUNNER_LABEL" \
        --work _work \
        --unattended \
        --replace
  )
fi
registration_token=""

install -o root -g root -m 0755 "$SCRIPT_DIR/runner-deploy.sh" /usr/local/sbin/apipool-runner-deploy

sudoers_tmp="$(mktemp)"
printf '%s ALL=(root) NOPASSWD: /usr/local/sbin/apipool-runner-deploy *\n' "$RUNNER_USER" >"$sudoers_tmp"
chmod 0440 "$sudoers_tmp"
visudo -cf "$sudoers_tmp" >/dev/null
install -o root -g root -m 0440 "$sudoers_tmp" /etc/sudoers.d/apipool-runner-deploy
rm -f "$sudoers_tmp"

if [ ! -f "$RUNNER_HOME/.service" ]; then
  (
    cd "$RUNNER_HOME"
    ./svc.sh install "$RUNNER_USER"
  )
fi

runner_uid="$(id -u "$RUNNER_USER")"
egress_tmp="$(mktemp)"
cat >"$egress_tmp" <<EOF
table inet apipool_runner_egress {
  chain output {
    type filter hook output priority 10; policy accept;
    meta skuid $runner_uid ip daddr 169.254.0.0/16 reject
    meta skuid $runner_uid ip6 daddr fe80::/10 reject
    meta skuid $runner_uid udp dport 53 accept
    meta skuid $runner_uid tcp dport { 53, 443 } accept
    meta skuid $runner_uid reject
  }
}
EOF
egress_check="$(mktemp)"
sed 's/apipool_runner_egress/apipool_runner_egress_validate/' "$egress_tmp" >"$egress_check"
nft --check --file "$egress_check"
install -d -o root -g root -m 0755 "$(dirname "$EGRESS_CONFIG")"
install -o root -g root -m 0600 "$egress_tmp" "$EGRESS_CONFIG"
rm -f "$egress_tmp" "$egress_check"

cat >"$EGRESS_SERVICE" <<EOF
[Unit]
Description=APIPool GitHub Runner egress boundary
Before=network.target
After=network-pre.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStartPre=-/usr/sbin/nft delete table inet apipool_runner_egress
ExecStart=/usr/sbin/nft --file $EGRESS_CONFIG
ExecStop=-/usr/sbin/nft delete table inet apipool_runner_egress

[Install]
WantedBy=multi-user.target
EOF
chmod 0644 "$EGRESS_SERVICE"
systemctl daemon-reload
systemctl enable apipool-runner-egress.service
systemctl restart apipool-runner-egress.service

(
  cd "$RUNNER_HOME"
  ./svc.sh start
  ./svc.sh status
)
