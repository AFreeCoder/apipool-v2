#!/usr/bin/env bash
# 初始化 New API root 并打印管理员 access token（写入 .env.deploy 的 NEWAPI_ADMIN_TOKEN）。
# 依赖 .env.deploy 中的 NEWAPI_ROOT_USER / NEWAPI_ROOT_PASS（密码限 8-20 字符）。
set -euo pipefail

BASE="${NEWAPI_LOCAL_URL:-http://localhost:3001}"
ROOT_USER="${NEWAPI_ROOT_USER:-root}"
: "${NEWAPI_ROOT_PASS:?set NEWAPI_ROOT_PASS (8-20 chars) in env}"
JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT

# 1) 初始化 root（已初始化则忽略报错）
curl -s -X POST "$BASE/api/setup" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$ROOT_USER\",\"password\":\"$NEWAPI_ROOT_PASS\",\"confirmPassword\":\"$NEWAPI_ROOT_PASS\"}" \
  >/dev/null || true

# 2) 登录拿 cookie 会话
curl -s -c "$JAR" -X POST "$BASE/api/user/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$ROOT_USER\",\"password\":\"$NEWAPI_ROOT_PASS\"}" >/dev/null

# 3) 取 admin access token（带 New-Api-User: 1；重新生成语义）
TOKEN="$(curl -s -b "$JAR" -H 'New-Api-User: 1' "$BASE/api/user/token" | sed -n 's/.*"data":"\([^"]*\)".*/\1/p')"

if [ -z "$TOKEN" ]; then
  echo "ERROR: failed to obtain admin access token from $BASE/api/user/token" >&2
  exit 1
fi
echo "$TOKEN"
