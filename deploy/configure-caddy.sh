#!/usr/bin/env bash
set -Eeuo pipefail

PRINT_CONFIG_ONLY=0
if [ "${1:-}" = "--print-config" ]; then
  PRINT_CONFIG_ONLY=1
fi

PORTAL_DOMAIN="${APIPOOL_PORTAL_DOMAIN:-app.apipool.dev}"
API_DOMAIN="${APIPOOL_API_DOMAIN:-api2.apipool.dev}"
NEWAPI_DOMAIN="${APIPOOL_NEWAPI_DOMAIN:-newapi.apipool.dev}"
PORTAL_UPSTREAM="${APIPOOL_PORTAL_UPSTREAM:-127.0.0.1:3000}"
API_UPSTREAM="${APIPOOL_API_UPSTREAM:-127.0.0.1:3001}"
NEWAPI_UPSTREAM="${APIPOOL_NEWAPI_UPSTREAM:-127.0.0.1:3001}"

# New API 运营面保护（docs/07-runbook.md 第 2 节）：Basic Auth 与 IP 白名单
# 至少配一项，否则拒绝生成配置——绝不产出裸奔的管理面 vhost。
NEWAPI_BASIC_AUTH_USER="${APIPOOL_NEWAPI_BASIC_AUTH_USER:-}"
NEWAPI_BASIC_AUTH_HASH="${APIPOOL_NEWAPI_BASIC_AUTH_HASH:-}"
NEWAPI_ALLOWED_IPS="${APIPOOL_NEWAPI_ALLOWED_IPS:-}"

has_basic_auth=0
if [ -n "$NEWAPI_BASIC_AUTH_USER" ] && [ -n "$NEWAPI_BASIC_AUTH_HASH" ]; then
  has_basic_auth=1
fi

has_ip_allowlist=0
if [ -n "$NEWAPI_ALLOWED_IPS" ]; then
  has_ip_allowlist=1
fi

if [ "$has_basic_auth" -eq 0 ] && [ "$has_ip_allowlist" -eq 0 ]; then
  cat >&2 <<'MSG'
configure-caddy.sh: refusing to expose the New API operator surface unprotected.

Set at least one of:
  - basic auth:   APIPOOL_NEWAPI_BASIC_AUTH_USER + APIPOOL_NEWAPI_BASIC_AUTH_HASH
                  (hash via: caddy hash-password --plaintext '<password>')
  - IP allowlist: APIPOOL_NEWAPI_ALLOWED_IPS (space separated IPs/CIDRs)
MSG
  exit 78
fi

# newapi vhost 的保护指令
newapi_guards=""
if [ "$has_ip_allowlist" -eq 1 ]; then
  newapi_guards+="	@denied not remote_ip $NEWAPI_ALLOWED_IPS
	respond @denied \"forbidden\" 403
"
fi
if [ "$has_basic_auth" -eq 1 ]; then
  newapi_guards+="	basic_auth {
		$NEWAPI_BASIC_AUTH_USER $NEWAPI_BASIC_AUTH_HASH
	}
"
fi

# api2 与 New API 管理面共用同一个上游（127.0.0.1:3001）。只放行 /v1 数据面，
# 其余（含 /api/* 管理接口）一律 404，否则公网可直接打管理接口。
read -r -d '' CADDYFILE <<EOF || true
$PORTAL_DOMAIN {
	encode zstd gzip
	reverse_proxy $PORTAL_UPSTREAM
}

$API_DOMAIN {
	encode zstd gzip

	handle /v1* {
		reverse_proxy $API_UPSTREAM
	}

	handle {
		respond "not found" 404
	}
}

$NEWAPI_DOMAIN {
	encode zstd gzip
	header X-Robots-Tag "noindex, nofollow"
$newapi_guards	reverse_proxy $NEWAPI_UPSTREAM
}
EOF

if [ "$PRINT_CONFIG_ONLY" -eq 1 ]; then
  printf '%s\n' "$CADDYFILE"
  exit 0
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "configure-caddy.sh must run as root" >&2
  exit 77
fi

apt-get update
apt-get install -y caddy

printf '%s\n' "$CADDYFILE" >/etc/caddy/Caddyfile

caddy fmt --overwrite /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile
systemctl enable --now caddy
systemctl reload caddy
