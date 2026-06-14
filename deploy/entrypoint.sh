#!/bin/sh
# 门户容器入口：sqlite/turso 时先建表（失败即中止启动，绝不带空库对外服务），再起服务。
set -e

if [ "${DATABASE_PROVIDER}" = "sqlite" ] || [ "${DATABASE_PROVIDER}" = "turso" ]; then
  echo "[entrypoint] applying SQLite migrations to ${DATABASE_URL}"
  node migrate.cjs
fi

exec node server.js
