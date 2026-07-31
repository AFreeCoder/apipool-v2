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
NEWAPI_UPSTREAM="${APIPOOL_NEWAPI_UPSTREAM:-127.0.0.1:3001}"

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
newapi_guards_indented=""
if [ "$has_ip_allowlist" -eq 1 ]; then
  newapi_guards_indented+="		@denied not remote_ip $NEWAPI_ALLOWED_IPS
		respond @denied \"forbidden\" 403
"
fi
if [ "$has_basic_auth" -eq 1 ]; then
  # 生产当前 Caddy 2.6.2 使用 basicauth；新版本仍保留该兼容指令。
  newapi_guards_indented+="		basicauth {
			$NEWAPI_BASIC_AUTH_USER $NEWAPI_BASIC_AUTH_HASH
		}
"
fi

# New API 仅保留受保护的运营面；公开 /v1 永久 404，防止绕过门户钱包计费。
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

# api2 是临时 DNS-only New API 数据面：所有 /v1* 路径均原样转发给
# New API，避开 Cloudflare 长请求超时和门户网关端点白名单。
# 非 /v1* 路径仍固定 404，不从该公网域名暴露 New API 管理面。
read -r -d '' CADDYFILE <<EOF || true
$PORTAL_DOMAIN {
	encode zstd gzip
$cloudflare_guard
	reverse_proxy $PORTAL_UPSTREAM
}

$API_DOMAIN {
	encode zstd gzip

	handle /v1* {
		reverse_proxy $NEWAPI_UPSTREAM
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

# 所有会修改共享 Caddy 配置树的服务都必须使用同一把锁。legacy APIPool
# 后续写入自己的 fragment 时也复用该默认路径，避免两个部署同时 validate/reload。
CADDY_LOCK_FILE="${APIPOOL_CADDY_LOCK_FILE:-/run/apipool-caddy.lock}"
CADDY_ROOT_FILE="${APIPOOL_CADDY_ROOT_FILE:-/etc/caddy/Caddyfile}"
CADDY_SITES_DIR="${APIPOOL_CADDY_SITES_DIR:-/etc/caddy/sites-enabled}"
CADDY_FRAGMENT_FILE="$CADDY_SITES_DIR/apipool-v2.caddy"
CADDY_IMPORT_LINE="import $CADDY_SITES_DIR/*.caddy"
CADDY_FORBIDDEN_AUTO_HTTPS_LINE="auto_https ignore_loaded_certs"

if ! command -v flock >/dev/null 2>&1; then
  apt-get update
  apt-get install -y util-linux
fi

lock_dir="$(dirname -- "$CADDY_LOCK_FILE")"
if [ ! -d "$lock_dir" ]; then
  install -d -m 0755 "$lock_dir"
fi
exec 8>"$CADDY_LOCK_FILE"
if ! flock -n 8; then
  echo "configure-caddy.sh: another Caddy configuration update holds $CADDY_LOCK_FILE" >&2
  exit 75
fi

# 只在 caddy 缺失时安装。deploy.sh 每次部署都会重新应用配置，
# 若无条件跑 apt install，会在部署中途把 caddy 升级到新版本。
if ! command -v caddy >/dev/null 2>&1; then
  apt-get update
  apt-get install -y caddy
fi

# 根 Caddyfile 只作为共享入口；各服务只能原子更新自己的 fragment。
# validate 使用一棵完整的候选配置树（包含现有 legacy 等 fragment），通过后才写入
# live 目录，避免单独验证 v2 片段却在组合配置中产生域名冲突。
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

if [ -d "$CADDY_SITES_DIR" ]; then
  for existing_fragment in "$CADDY_SITES_DIR"/*.caddy; do
    if [ ! -e "$existing_fragment" ] && [ ! -L "$existing_fragment" ]; then
      continue
    fi
    [ "$existing_fragment" = "$CADDY_FRAGMENT_FILE" ] && continue
    cp -a "$existing_fragment" "$STAGED_SITES_DIR/"
  done
fi

printf '%s\n' "$CADDYFILE" >"$STAGED_FRAGMENT_FILE"
caddy fmt --overwrite "$STAGED_FRAGMENT_FILE"

root_mode="initialize"
if [ -f "$CADDY_ROOT_FILE" ]; then
  if grep -Fqx "$CADDY_IMPORT_LINE" "$CADDY_ROOT_FILE"; then
    if grep -Eq '^[[:space:]]*auto_https[[:space:]]+ignore_loaded_certs[[:space:]]*$' \
      "$CADDY_ROOT_FILE"; then
      if awk -v import_line="$CADDY_IMPORT_LINE" '
        /^[[:space:]]*($|#)/ { next }
        $0 == import_line { imports++; next }
        /^[[:space:]]*\{[[:space:]]*$/ { opens++; next }
        /^[[:space:]]*\}[[:space:]]*$/ { closes++; next }
        /^[[:space:]]*auto_https[[:space:]]+ignore_loaded_certs[[:space:]]*$/ {
          policies++
          next
        }
        { unexpected = 1 }
        END {
          exit !(imports == 1 && opens == 1 && closes == 1 &&
            policies == 1 && unexpected == 0)
        }
      ' "$CADDY_ROOT_FILE"; then
        # ignore_loaded_certs 的含义是“即使手工证书已加载也继续自动申请证书”。
        # 这是早期共享根配置的反向策略：会让 legacy Origin Certificate
        # 触发无意义的公网 ACME 重试。仅对这个可精确识别的旧形态做一次迁移。
        root_mode="remove-ignore-loaded-certs"
      else
        cat >&2 <<MSG
configure-caddy.sh: shared root contains
  $CADDY_FORBIDDEN_AUTO_HTTPS_LINE
alongside unmanaged directives. Refusing to rewrite it automatically.
MSG
        exit 78
      fi
    elif awk -v import_line="$CADDY_IMPORT_LINE" '
      /^[[:space:]]*($|#)/ { next }
      $0 == import_line { imports++; next }
      { unexpected = 1 }
      END { exit !(imports == 1 && unexpected == 0) }
    ' "$CADDY_ROOT_FILE"; then
      root_mode="preserve"
    else
      cat >&2 <<MSG
configure-caddy.sh: shared root Caddyfile contains unmanaged directives.
Expected only:
  $CADDY_IMPORT_LINE
Refusing to rewrite the shared root automatically.
MSG
      exit 78
    fi
  else
    # 旧版 configure-caddy.sh 独占根文件，且只会生成这三个顶层站点。仅在能
    # 明确识别该历史形态时自动迁移；任何其他根配置都 fail-closed，防止误删别的服务。
    formatted_existing_root="$STAGING_DIR/existing-root.caddy"
    install -m 0644 "$CADDY_ROOT_FILE" "$formatted_existing_root"
    caddy fmt --overwrite "$formatted_existing_root"
    if awk \
      -v portal="$PORTAL_DOMAIN {" \
      -v api="$API_DOMAIN {" \
      -v newapi="$NEWAPI_DOMAIN {" '
        /^[[:space:]]*($|#)/ { next }
        /^[[:space:]]/ { next }
        $0 == portal || $0 == api || $0 == newapi { sites++; next }
        $0 == "}" { closes++; next }
        { unexpected = 1 }
        END { exit !(sites == 3 && closes == 3 && unexpected == 0) }
      ' "$formatted_existing_root"; then
      root_mode="migrate-v2-monolith"
    else
      cat >&2 <<MSG
configure-caddy.sh: refusing to overwrite unmanaged root Caddyfile: $CADDY_ROOT_FILE
Move existing service blocks into $CADDY_SITES_DIR/*.caddy and make the root file contain:
  $CADDY_IMPORT_LINE
Then rerun this command.
MSG
      exit 78
    fi
  fi
fi

write_shared_root() {
  destination="$1"
  import_line="$2"
  cat >"$destination" <<EOF
# Shared Caddy entrypoint. Service-owned configs live in sites-enabled.
$import_line
EOF
}

if [ "$root_mode" = "preserve" ]; then
  # 将 live import 临时改指向候选目录，保留根文件中的全局选项和其他共享指令。
  awk -v live="$CADDY_IMPORT_LINE" -v staged="import $STAGED_SITES_DIR/*.caddy" '
    $0 == live { print staged; next }
    { print }
  ' "$CADDY_ROOT_FILE" >"$STAGED_ROOT_FILE"
else
  write_shared_root "$STAGED_ROOT_FILE" "import $STAGED_SITES_DIR/*.caddy"
fi

caddy fmt --overwrite "$STAGED_ROOT_FILE"
caddy validate --config "$STAGED_ROOT_FILE" --adapter caddyfile

install -d -m 0755 "$(dirname -- "$CADDY_ROOT_FILE")" "$CADDY_SITES_DIR"

atomic_install() {
  source_file="$1"
  target_file="$2"
  target_dir="$(dirname -- "$target_file")"
  target_name="$(basename -- "$target_file")"
  LIVE_TMP="$(mktemp "$target_dir/.${target_name}.tmp.XXXXXX")"
  install -m 0644 "$source_file" "$LIVE_TMP"
  mv -f -- "$LIVE_TMP" "$target_file"
  LIVE_TMP=""
}

# 只备份和替换 v2 自己的 fragment；legacy 以及其他服务 fragment 不会被触碰。
if [ -f "$CADDY_FRAGMENT_FILE" ]; then
  cp -a "$CADDY_FRAGMENT_FILE" "$CADDY_FRAGMENT_FILE.bak"
fi
atomic_install "$STAGED_FRAGMENT_FILE" "$CADDY_FRAGMENT_FILE"

if [ "$root_mode" != "preserve" ]; then
  if [ -f "$CADDY_ROOT_FILE" ]; then
    cp -a "$CADDY_ROOT_FILE" "$CADDY_ROOT_FILE.bak"
  fi
  live_root="$STAGING_DIR/live-Caddyfile"
  write_shared_root "$live_root" "$CADDY_IMPORT_LINE"
  caddy fmt --overwrite "$live_root"
  atomic_install "$live_root" "$CADDY_ROOT_FILE"
fi

systemctl enable --now caddy
systemctl reload caddy
