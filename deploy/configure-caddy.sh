#!/usr/bin/env bash
set -Eeuo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "configure-caddy.sh must run as root" >&2
  exit 77
fi

PORTAL_DOMAIN="${APIPOOL_PORTAL_DOMAIN:-app.apipool.dev}"
API_DOMAIN="${APIPOOL_API_DOMAIN:-api2.apipool.dev}"
NEWAPI_DOMAIN="${APIPOOL_NEWAPI_DOMAIN:-newapi.apipool.dev}"
PORTAL_UPSTREAM="${APIPOOL_PORTAL_UPSTREAM:-127.0.0.1:3000}"
API_UPSTREAM="${APIPOOL_API_UPSTREAM:-127.0.0.1:3001}"
NEWAPI_UPSTREAM="${APIPOOL_NEWAPI_UPSTREAM:-127.0.0.1:3001}"

apt-get update
apt-get install -y caddy

cat >/etc/caddy/Caddyfile <<EOF
$PORTAL_DOMAIN {
	encode zstd gzip
	reverse_proxy $PORTAL_UPSTREAM
}

$API_DOMAIN {
	encode zstd gzip
	reverse_proxy $API_UPSTREAM
}

$NEWAPI_DOMAIN {
	encode zstd gzip
	header X-Robots-Tag "noindex, nofollow"
	reverse_proxy $NEWAPI_UPSTREAM
}
EOF

caddy fmt --overwrite /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile
systemctl enable --now caddy
systemctl reload caddy
