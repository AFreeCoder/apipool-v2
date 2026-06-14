#!/bin/sh
# 门户容器入口：先 fail-fast 校验必填密钥，再建表(sqlite/turso)，最后起服务。
# 绝不在缺密钥或空库状态下对外提供服务。
set -e

fail() { echo "[entrypoint] FATAL: $1" >&2; exit 1; }

# 必填应用密钥：空或过短直接拒绝启动。
# 空 AUTH_SECRET 会让 Better Auth 回退到已知默认签名密钥（会话可被伪造）。
[ "${#AUTH_SECRET}" -ge 16 ] || fail "AUTH_SECRET missing or too short (need >=16 chars; generate: openssl rand -base64 32)"
[ "${#APIPOOL_CREDENTIALS_SECRET}" -ge 16 ] || fail "APIPOOL_CREDENTIALS_SECRET missing or too short (need >=16 chars)"

# New API 集成/建 Key 开启时（默认开），管理员凭据必填，
# 否则绑定与建 Key 会拖到用户操作时才失败。
if [ "${NEWAPI_INTEGRATION_ENABLED}" != "false" ] || [ "${APIPOOL_KEY_CREATION_ENABLED}" != "false" ]; then
  [ -n "${NEWAPI_ADMIN_TOKEN}" ] || fail "NEWAPI_ADMIN_TOKEN required when New API integration/key creation is enabled"
  [ -n "${NEWAPI_ADMIN_USER_ID}" ] || fail "NEWAPI_ADMIN_USER_ID required when New API integration/key creation is enabled"
fi

if [ "${DATABASE_PROVIDER}" = "sqlite" ] || [ "${DATABASE_PROVIDER}" = "turso" ]; then
  echo "[entrypoint] applying SQLite migrations to ${DATABASE_URL}"
  node migrate.cjs
fi

exec node server.js
