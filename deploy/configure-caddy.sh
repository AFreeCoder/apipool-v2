#!/usr/bin/env bash
set -Eeuo pipefail

PRINT_CONFIG_ONLY=0
if [ "${1:-}" = "--print-config" ]; then
  PRINT_CONFIG_ONLY=1
fi

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# New API 运营面保护变量存放在 .env.deploy。**绝不 source 它**：
#   - bcrypt 哈希含 `$`，`HASH=$2a$14$xxx` 经 shell 参数展开后变成 `a4`，
#     生成的 basic_auth 谁也登不上去，而且静默无提示；
#   - IP 白名单含空格，`IPS=1.2.3.4 5.6.7.8` 会让 shell 把第二个 IP 当命令执行，
#     在 set -e 下直接中断部署（deploy/live-smoke.sh 也 source 同一个文件）。
# 这里按字面量读取，加不加引号都能正确解析。
ENV_FILE="${APIPOOL_DEPLOY_ENV_FILE:-${APIPOOL_DEPLOY_DIR:-/opt/apipool-v2}/.env.deploy}"

read_env_value() {
  key="$1"
  [ -f "$ENV_FILE" ] || return 0

  line="$(awk -v key="$key" '
    {
      entry = $0
      sub(/^[ \t]*/, "", entry)
      sub(/^export[ \t]+/, "", entry)
      if (index(entry, key "=") == 1) last = entry
    }
    END { if (last != "") print last }
  ' "$ENV_FILE")"

  [ -n "$line" ] || return 0

  value="${line#*=}"
  case "$value" in
    "'"*"'") value="${value#\'}"; value="${value%\'}" ;;
    '"'*'"') value="${value#\"}"; value="${value%\"}" ;;
  esac

  printf '%s' "$value"
}

PORTAL_DOMAIN="${APIPOOL_PORTAL_DOMAIN:-app.apipool.dev}"
API_DOMAIN="${APIPOOL_API_DOMAIN:-api2.apipool.dev}"
NEWAPI_DOMAIN="${APIPOOL_NEWAPI_DOMAIN:-newapi.apipool.dev}"
PORTAL_UPSTREAM="${APIPOOL_PORTAL_UPSTREAM:-127.0.0.1:3000}"
API_UPSTREAM="${APIPOOL_API_UPSTREAM:-127.0.0.1:3001}"
NEWAPI_UPSTREAM="${APIPOOL_NEWAPI_UPSTREAM:-127.0.0.1:3001}"

# API_MODE 是安全攸关的切流状态，只认 .env.deploy。环境中若同时存在，
# 只能与文件完全一致，不能覆盖文件状态。
FILE_API_MODE="$(read_env_value APIPOOL_API_MODE)"
ENV_API_MODE="${APIPOOL_API_MODE:-}"
if [ -n "$ENV_API_MODE" ] && [ "$ENV_API_MODE" != "$FILE_API_MODE" ]; then
  echo "configure-caddy: APIPOOL_API_MODE env ('$ENV_API_MODE') != .env.deploy ('$FILE_API_MODE') — refusing (env must not override state file)" >&2
  exit 78
fi
API_MODE="$FILE_API_MODE"
if [ -z "$API_MODE" ]; then
  echo "configure-caddy: APIPOOL_API_MODE missing/empty in .env.deploy — refusing (would silently reopen legacy backdoor)" >&2
  exit 78
fi
case "$API_MODE" in
  legacy | maintenance | portal) ;;
  *)
    echo "configure-caddy: invalid APIPOOL_API_MODE '$API_MODE' (expect legacy|maintenance|portal)" >&2
    exit 78
    ;;
esac

case "$API_MODE" in
  legacy) api_v1_directive="		reverse_proxy $API_UPSTREAM" ;;
  maintenance) api_v1_directive="		respond \"service maintenance\" 503" ;;
  portal) api_v1_directive="		reverse_proxy $PORTAL_UPSTREAM" ;;
esac

# app/newapi 是 Cloudflare proxied 记录。源站只信任实际 TCP 对端属于 Cloudflare
# 官方 HTTP 代理网段；绝不使用客户端可伪造的 X-Forwarded-For 做这层判断。
# api2 是 DNS-only 公共数据面，不能套用该来源限制。
CLOUDFLARE_IPS_FILE="${APIPOOL_CLOUDFLARE_IPS_FILE:-$SCRIPT_DIR/cloudflare-ips.txt}"
if [ ! -r "$CLOUDFLARE_IPS_FILE" ]; then
  echo "configure-caddy.sh: missing Cloudflare IP list: $CLOUDFLARE_IPS_FILE" >&2
  exit 78
fi

CLOUDFLARE_IPS="$(awk '
  {
    line = $0
    sub(/\r$/, "", line)
    sub(/#.*/, "", line)
    gsub(/^[ \t]+|[ \t]+$/, "", line)
    if (line == "") next
    if (line !~ /^[0-9A-Fa-f:.]+\/[0-9]+$/) {
      print "configure-caddy.sh: invalid Cloudflare CIDR: " line > "/dev/stderr"
      exit 78
    }
    if (count++ > 0) printf " "
    printf "%s", line
  }
  END {
    if (count == 0) {
      print "configure-caddy.sh: Cloudflare IP list is empty" > "/dev/stderr"
      exit 78
    }
    print ""
  }
' "$CLOUDFLARE_IPS_FILE")"

cloudflare_guard="	@not_cloudflare not remote_ip $CLOUDFLARE_IPS
	respond @not_cloudflare \"forbidden\" 403
"

# New API 运营面保护（docs/07-runbook.md 第 2 节）：Basic Auth 与 IP 白名单
# 至少配一项，否则拒绝生成配置——绝不产出裸奔的管理面 vhost。
# 环境变量优先；未设置时从 .env.deploy 按字面量读取
NEWAPI_BASIC_AUTH_USER="${APIPOOL_NEWAPI_BASIC_AUTH_USER:-$(read_env_value APIPOOL_NEWAPI_BASIC_AUTH_USER)}"
NEWAPI_BASIC_AUTH_HASH="${APIPOOL_NEWAPI_BASIC_AUTH_HASH:-$(read_env_value APIPOOL_NEWAPI_BASIC_AUTH_HASH)}"
NEWAPI_ALLOWED_IPS="${APIPOOL_NEWAPI_ALLOWED_IPS:-$(read_env_value APIPOOL_NEWAPI_ALLOWED_IPS)}"
# 显式接受「New API 管理面无额外 operator guard」的退出开关。即使设为 true，
# newapi 源站仍然只接受 Cloudflare TCP 对端；该开关只跳过 Basic Auth / 运营 IP。
NEWAPI_ALLOW_UNPROTECTED="${APIPOOL_NEWAPI_ALLOW_UNPROTECTED:-$(read_env_value APIPOOL_NEWAPI_ALLOW_UNPROTECTED)}"

has_basic_auth=0
if [ -n "$NEWAPI_BASIC_AUTH_USER" ] && [ -n "$NEWAPI_BASIC_AUTH_HASH" ]; then
  has_basic_auth=1
fi

has_ip_allowlist=0
if [ -n "$NEWAPI_ALLOWED_IPS" ]; then
  has_ip_allowlist=1
fi

if [ "$has_basic_auth" -eq 0 ] && [ "$has_ip_allowlist" -eq 0 ]; then
  case "$NEWAPI_ALLOW_UNPROTECTED" in
    true | True | TRUE | 1 | yes | YES)
      echo "configure-caddy.sh: WARNING: newapi vhost has no operator-level Basic Auth/IP guard (APIPOOL_NEWAPI_ALLOW_UNPROTECTED=true); Cloudflare-origin ACL remains enabled." >&2
      ;;
    *)
      cat >&2 <<'MSG'
configure-caddy.sh: refusing to expose the New API operator surface unprotected.

Set at least one of:
  - basic auth:   APIPOOL_NEWAPI_BASIC_AUTH_USER + APIPOOL_NEWAPI_BASIC_AUTH_HASH
                  (hash via: caddy hash-password --plaintext '<password>')
  - IP allowlist: APIPOOL_NEWAPI_ALLOWED_IPS (space separated IPs/CIDRs)
Or explicitly accept public exposure of the New API admin backend:
  - APIPOOL_NEWAPI_ALLOW_UNPROTECTED=true
MSG
      exit 78
      ;;
  esac
fi

# newapi vhost 的保护指令
newapi_guards=""
newapi_guards_indented=""
if [ "$has_ip_allowlist" -eq 1 ]; then
  newapi_guards+="	@denied not remote_ip $NEWAPI_ALLOWED_IPS
	respond @denied \"forbidden\" 403
"
  newapi_guards_indented+="		@denied not remote_ip $NEWAPI_ALLOWED_IPS
		respond @denied \"forbidden\" 403
"
fi
if [ "$has_basic_auth" -eq 1 ]; then
  # 生产当前 Caddy 2.6.2 使用 basicauth；新版本仍保留该兼容指令。
  newapi_guards+="	basicauth {
		$NEWAPI_BASIC_AUTH_USER $NEWAPI_BASIC_AUTH_HASH
	}
"
  newapi_guards_indented+="		basicauth {
			$NEWAPI_BASIC_AUTH_USER $NEWAPI_BASIC_AUTH_HASH
		}
"
fi

# legacy 保持 New API 数据面可达；maintenance/portal 用互斥 handle 让
# /v1* 在任何认证/白名单处理前固定 404，防止绕过门户钱包计费。
if [ "$API_MODE" = "legacy" ]; then
  newapi_site_body="$newapi_guards	reverse_proxy $NEWAPI_UPSTREAM"
else
  newapi_fallback_inner="		reverse_proxy $NEWAPI_UPSTREAM"
  if [ -n "$newapi_guards_indented" ]; then
    # printf 显式制造分隔换行；不能依赖命令替换会吞掉的变量尾换行。
    newapi_fallback_inner="$(printf '%s\n%s' "$newapi_guards_indented" "		reverse_proxy $NEWAPI_UPSTREAM")"
  fi
  newapi_site_body="	handle /v1* {
		respond \"not found\" 404
	}
	handle {
$newapi_fallback_inner
	}"
fi

# api2 与 New API 管理面共用同一个上游（127.0.0.1:3001）。只放行 /v1 数据面，
# 其余（含 /api/* 管理接口）一律 404，否则公网可直接打管理接口。
read -r -d '' CADDYFILE <<EOF || true
$PORTAL_DOMAIN {
	encode zstd gzip
$cloudflare_guard
	reverse_proxy $PORTAL_UPSTREAM
}

$API_DOMAIN {
	encode zstd gzip

	handle /v1* {
$api_v1_directive
	}

	handle {
		respond "not found" 404
	}
}

$NEWAPI_DOMAIN {
	encode zstd gzip
	header X-Robots-Tag "noindex, nofollow"
$cloudflare_guard
$newapi_site_body
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

# 只在 caddy 缺失时安装。deploy.sh 每次部署都会重新应用配置，
# 若无条件跑 apt install，会在部署中途把 caddy 升级到新版本。
if ! command -v caddy >/dev/null 2>&1; then
  apt-get update
  apt-get install -y caddy
fi

# 先在临时文件上校验，通过后才原子替换。
# 若直接写 /etc/caddy/Caddyfile 再 validate，validate 失败时脚本退出（set -e），
# 磁盘上却已留下一份坏配置——此后任何 reload / 重启都会让 Caddy 起不来，全站不可达。
STAGED_CADDYFILE="$(mktemp)"
trap 'rm -f "$STAGED_CADDYFILE"' EXIT

printf '%s\n' "$CADDYFILE" >"$STAGED_CADDYFILE"
caddy fmt --overwrite "$STAGED_CADDYFILE"
caddy validate --config "$STAGED_CADDYFILE" --adapter caddyfile

# 保留上一份配置，便于人工回滚
if [ -f /etc/caddy/Caddyfile ]; then
  cp -a /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak
fi

install -m 0644 "$STAGED_CADDYFILE" /etc/caddy/Caddyfile

systemctl enable --now caddy
systemctl reload caddy
