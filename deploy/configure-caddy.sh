#!/usr/bin/env bash
set -Eeuo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "configure-caddy.sh must run as root" >&2
  exit 77
fi

PORTAL_DOMAIN="${APIPOOL_PORTAL_DOMAIN:-new.apipool.dev}"
NEWAPI_DOMAIN="${APIPOOL_NEWAPI_DOMAIN:-newapi.apipool.dev}"
PORTAL_UPSTREAM="${APIPOOL_PORTAL_UPSTREAM:-127.0.0.1:3000}"
NEWAPI_UPSTREAM="${APIPOOL_NEWAPI_UPSTREAM:-127.0.0.1:3001}"
NEWAPI_AUTH_FILE="${APIPOOL_NEWAPI_BASIC_AUTH_FILE:-/root/apipool-newapi-basic-auth.txt}"

apt-get update
apt-get install -y caddy openssl

if [ ! -f "$NEWAPI_AUTH_FILE" ]; then
  password="$(openssl rand -hex 16)"
  {
    echo "username=admin"
    echo "password=$password"
  } > "$NEWAPI_AUTH_FILE"
fi
chmod 600 "$NEWAPI_AUTH_FILE"

username="$(sed -n 's/^username=//p' "$NEWAPI_AUTH_FILE" | head -n 1)"
password="$(sed -n 's/^password=//p' "$NEWAPI_AUTH_FILE")"
username="${username:-admin}"
if [ -z "$password" ]; then
  echo "missing password in $NEWAPI_AUTH_FILE" >&2
  exit 65
fi

hash="$(caddy hash-password --plaintext "$password")"

cat >/etc/caddy/Caddyfile <<EOF
$PORTAL_DOMAIN {
	encode zstd gzip
	reverse_proxy $PORTAL_UPSTREAM
}

$NEWAPI_DOMAIN {
	encode zstd gzip
	header X-Robots-Tag "noindex, nofollow"
	basicauth {
		$username $hash
	}
	reverse_proxy $NEWAPI_UPSTREAM
}
EOF

caddy fmt --overwrite /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile
systemctl enable --now caddy
systemctl reload caddy
