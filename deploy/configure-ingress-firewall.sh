#!/usr/bin/env bash
set -Eeuo pipefail

# 生产主机入站边界：Web 端口保持公网，SSH 仅允许 owner 明确确认的 CIDR。
# --apply 会先安排 5 分钟后的自动回滚；只有新 SSH 会话验证成功后才能 --confirm。

TABLE_NAME="apipool_ingress"
CONFIG_FILE="/etc/nftables.d/apipool-ingress.nft"
SERVICE_FILE="/etc/systemd/system/apipool-ingress-firewall.service"
ROLLBACK_UNIT_PREFIX="apipool-ingress-firewall-rollback"
ROLLBACK_SCRIPT="/run/apipool-ingress-firewall-rollback.sh"
ROLLBACK_STATE="/run/apipool-ingress-firewall-rollback-state"
ROLLBACK_SECONDS="${APIPOOL_FIREWALL_ROLLBACK_SECONDS:-300}"
SSH_ALLOWED_CIDRS="${APIPOOL_SSH_ALLOWED_CIDRS:-}"

usage() {
  cat >&2 <<'USAGE'
用法：
  APIPOOL_SSH_ALLOWED_CIDRS='203.0.113.7/32' ./deploy/configure-ingress-firewall.sh --print-config
  sudo APIPOOL_SSH_ALLOWED_CIDRS='203.0.113.7/32' ./deploy/configure-ingress-firewall.sh --apply
  sudo ./deploy/configure-ingress-firewall.sh --confirm
  sudo ./deploy/configure-ingress-firewall.sh --rollback
USAGE
  exit 64
}

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "configure-ingress-firewall.sh: 该操作必须以 root 运行" >&2
    exit 77
  fi
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "configure-ingress-firewall.sh: 缺少命令：$1" >&2
    exit 69
  fi
}

build_config() {
  local cidr=""
  local ipv4_items=""
  local ipv6_items=""

  if [ -z "$SSH_ALLOWED_CIDRS" ]; then
    echo "configure-ingress-firewall.sh: APIPOOL_SSH_ALLOWED_CIDRS 不能为空" >&2
    exit 78
  fi

  for cidr in $SSH_ALLOWED_CIDRS; do
    case "$cidr" in
      *:*)
        if [[ ! "$cidr" =~ ^[0-9A-Fa-f:]+/[0-9]{1,3}$ ]]; then
          echo "configure-ingress-firewall.sh: 非法 IPv6 CIDR：$cidr" >&2
          exit 78
        fi
        ipv6_items+="${ipv6_items:+, }$cidr"
        ;;
      *)
        if [[ ! "$cidr" =~ ^[0-9.]+/[0-9]{1,2}$ ]]; then
          echo "configure-ingress-firewall.sh: 非法 IPv4 CIDR：$cidr" >&2
          exit 78
        fi
        ipv4_items+="${ipv4_items:+, }$cidr"
        ;;
    esac
  done

  cat <<EOF
table inet $TABLE_NAME {
  chain input {
    type filter hook input priority 10; policy drop;

    ct state invalid drop
    ct state established,related accept
    iifname "lo" accept

    ip protocol icmp accept
    ip6 nexthdr ipv6-icmp accept

    udp sport 67 udp dport 68 accept
    udp sport 547 udp dport 546 accept

    tcp dport { 80, 443 } accept
EOF

  if [ -n "$ipv4_items" ]; then
    echo "    ip saddr { $ipv4_items } tcp dport 22222 accept"
  fi
  if [ -n "$ipv6_items" ]; then
    echo "    ip6 saddr { $ipv6_items } tcp dport 22222 accept"
  fi

  cat <<'EOF'
  }
}
EOF
}

write_rollback_script() {
  cat >"$ROLLBACK_SCRIPT" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail

state=/run/apipool-ingress-firewall-rollback-state
config=/etc/nftables.d/apipool-ingress.nft
service=/etc/systemd/system/apipool-ingress-firewall.service

systemctl disable --now apipool-ingress-firewall.service >/dev/null 2>&1 || true
nft delete table inet apipool_ingress >/dev/null 2>&1 || true

if [ -f "$state/config.existed" ]; then
  install -D -o root -g root -m 0600 "$state/config.previous" "$config"
else
  rm -f "$config"
fi

if [ -f "$state/service.existed" ]; then
  install -o root -g root -m 0644 "$state/service.previous" "$service"
else
  rm -f "$service"
fi

systemctl daemon-reload

if [ -f "$state/service.was-enabled" ]; then
  systemctl enable apipool-ingress-firewall.service >/dev/null
fi
if [ -f "$state/service.was-active" ]; then
  systemctl start apipool-ingress-firewall.service
fi

rm -rf "$state"
rm -f /run/apipool-ingress-firewall-rollback.sh
EOF
  chmod 0700 "$ROLLBACK_SCRIPT"
}

schedule_rollback() {
  local rollback_unit=""
  if [ -e "$ROLLBACK_STATE" ] || [ -e "$ROLLBACK_SCRIPT" ]; then
    echo "configure-ingress-firewall.sh: 已有待确认的防火墙变更；请先 --confirm 或 --rollback" >&2
    exit 75
  fi

  rollback_unit="${ROLLBACK_UNIT_PREFIX}-$(date +%s)-$$"
  install -d -o root -g root -m 0700 "$ROLLBACK_STATE"
  printf '%s\n' "$rollback_unit" >"$ROLLBACK_STATE/unit"

  if [ -f "$CONFIG_FILE" ]; then
    touch "$ROLLBACK_STATE/config.existed"
    cp -a "$CONFIG_FILE" "$ROLLBACK_STATE/config.previous"
  fi
  if [ -f "$SERVICE_FILE" ]; then
    touch "$ROLLBACK_STATE/service.existed"
    cp -a "$SERVICE_FILE" "$ROLLBACK_STATE/service.previous"
  fi
  if systemctl is-enabled --quiet apipool-ingress-firewall.service 2>/dev/null; then
    touch "$ROLLBACK_STATE/service.was-enabled"
  fi
  if systemctl is-active --quiet apipool-ingress-firewall.service 2>/dev/null; then
    touch "$ROLLBACK_STATE/service.was-active"
  fi

  write_rollback_script
  systemd-run \
    --unit="$rollback_unit" \
    --on-active="${ROLLBACK_SECONDS}s" \
    "$ROLLBACK_SCRIPT" >/dev/null
}

cancel_scheduled_rollback() {
  local rollback_unit=""
  if [ -f "$ROLLBACK_STATE/unit" ]; then
    rollback_unit="$(cat "$ROLLBACK_STATE/unit")"
    systemctl stop "$rollback_unit.timer" "$rollback_unit.service" >/dev/null 2>&1 || true
    systemctl reset-failed "$rollback_unit.timer" "$rollback_unit.service" >/dev/null 2>&1 || true
  fi
}

apply_firewall() {
  require_root
  require_command nft
  require_command systemctl
  require_command systemd-run

  local staged_config=""
  local validation_config=""
  staged_config="$(mktemp)"
  validation_config="$(mktemp)"
  trap 'rm -f "$staged_config" "$validation_config"' EXIT

  build_config >"$staged_config"
  sed "s/table inet $TABLE_NAME/table inet ${TABLE_NAME}_validate/" \
    "$staged_config" >"$validation_config"
  nft --check --file "$validation_config"

  schedule_rollback
  install -d -o root -g root -m 0755 "$(dirname "$CONFIG_FILE")"
  install -o root -g root -m 0600 "$staged_config" "$CONFIG_FILE"

  cat >"$SERVICE_FILE" <<EOF
[Unit]
Description=APIPool production ingress firewall
Before=network.target docker.service caddy.service
After=network-pre.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStartPre=-/usr/sbin/nft delete table inet $TABLE_NAME
ExecStart=/usr/sbin/nft --file $CONFIG_FILE
ExecStop=-/usr/sbin/nft delete table inet $TABLE_NAME

[Install]
WantedBy=multi-user.target
EOF
  chmod 0644 "$SERVICE_FILE"

  systemctl daemon-reload
  if ! systemctl enable apipool-ingress-firewall.service \
    || ! systemctl restart apipool-ingress-firewall.service; then
    cancel_scheduled_rollback
    "$ROLLBACK_SCRIPT"
    exit 1
  fi

  nft list table inet "$TABLE_NAME"
  echo "[firewall] 已应用；${ROLLBACK_SECONDS} 秒后会自动回滚。" >&2
  echo "[firewall] 请从新的终端验证 SSH 22222，然后执行：$0 --confirm" >&2
  rm -f "$staged_config" "$validation_config"
  trap - EXIT
}

confirm_firewall() {
  require_root
  cancel_scheduled_rollback
  rm -rf "$ROLLBACK_STATE"
  rm -f "$ROLLBACK_SCRIPT"
  echo "[firewall] 已确认并取消自动回滚"
}

rollback_firewall() {
  require_root
  if [ -x "$ROLLBACK_SCRIPT" ]; then
    cancel_scheduled_rollback
    "$ROLLBACK_SCRIPT"
  else
    systemctl disable --now apipool-ingress-firewall.service >/dev/null 2>&1 || true
    nft delete table inet "$TABLE_NAME" >/dev/null 2>&1 || true
  fi
  echo "[firewall] 已回滚"
}

case "${1:-}" in
  --print-config)
    build_config
    ;;
  --apply)
    apply_firewall
    ;;
  --confirm)
    confirm_firewall
    ;;
  --rollback)
    rollback_firewall
    ;;
  *)
    usage
    ;;
esac
