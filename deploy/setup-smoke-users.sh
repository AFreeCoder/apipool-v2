#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APIPOOL_DEPLOY_DIR:-/opt/apipool-v2}"
ENV_FILE="${APIPOOL_ENV_FILE:-.env.deploy}"
PORTAL_DB="${APIPOOL_PORTAL_DB:-data/portal/portal.db}"
APPLY=false

usage() {
  cat >&2 <<'USAGE'
usage: deploy/setup-smoke-users.sh [--apply]

Creates or reuses dedicated production smoke service identities in the portal
SQLite database and writes their user ids to .env.deploy.

Default mode is dry-run. Set these optional values in .env.deploy before apply:
  APIPOOL_SMOKE_PORTAL_EMAIL
  APIPOOL_SMOKE_OPERATOR_EMAIL
  APIPOOL_SMOKE_PORTAL_NAME
  APIPOOL_SMOKE_OPERATOR_NAME
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --apply)
      APPLY=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 64
      ;;
  esac
done

cd "$APP_DIR"

for required in "$ENV_FILE" "$PORTAL_DB"; do
  if [ ! -e "$required" ]; then
    echo "[setup-smoke-users] missing $APP_DIR/$required" >&2
    exit 66
  fi
done

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

SMOKE_PORTAL_EMAIL="${APIPOOL_SMOKE_PORTAL_EMAIL:-smoke.portal@apipool.local}"
SMOKE_OPERATOR_EMAIL="${APIPOOL_SMOKE_OPERATOR_EMAIL:-smoke.operator@apipool.local}"
SMOKE_PORTAL_NAME="${APIPOOL_SMOKE_PORTAL_NAME:-APIPool Smoke Portal}"
SMOKE_OPERATOR_NAME="${APIPOOL_SMOKE_OPERATOR_NAME:-APIPool Smoke Operator}"

validate_email() {
  case "$1" in
    *"'"*|*\"*|*";"*|*"\\"*|"")
      echo "[setup-smoke-users] unsafe email value: $1" >&2
      exit 65
      ;;
  esac
}

validate_text() {
  case "$1" in
    *"'"*|*\"*|*";"*|*"\\"*|"")
      echo "[setup-smoke-users] unsafe text value: $1" >&2
      exit 65
      ;;
  esac
}

new_uuid() {
  if command -v uuidgen >/dev/null 2>&1; then
    uuidgen | tr '[:upper:]' '[:lower:]'
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import uuid; print(uuid.uuid4())'
  elif [ -r /proc/sys/kernel/random/uuid ]; then
    cat /proc/sys/kernel/random/uuid
  else
    echo "[setup-smoke-users] no uuid generator available" >&2
    exit 69
  fi
}

sql_value() {
  printf "'%s'" "$1"
}

lookup_user_id() {
  sqlite3 "$PORTAL_DB" "select id from user where email = $(sql_value "$1") limit 1;"
}

set_env_value() {
  local key="$1"
  local value="$2"
  local tmp
  tmp="$(mktemp)"
  awk -v key="$key" -v value="$value" '
    BEGIN { done = 0 }
    $0 ~ "^" key "=" {
      print key "=" value
      done = 1
      next
    }
    { print }
    END {
      if (!done) {
        print key "=" value
      }
    }
  ' "$ENV_FILE" > "$tmp"
  install -m 600 "$tmp" "$ENV_FILE"
  rm -f "$tmp"
}

validate_email "$SMOKE_PORTAL_EMAIL"
validate_email "$SMOKE_OPERATOR_EMAIL"
validate_text "$SMOKE_PORTAL_NAME"
validate_text "$SMOKE_OPERATOR_NAME"

if [ "$SMOKE_PORTAL_EMAIL" = "$SMOKE_OPERATOR_EMAIL" ]; then
  echo "[setup-smoke-users] portal and operator smoke emails must be different" >&2
  exit 65
fi

operator_role_ready="$(
  sqlite3 "$PORTAL_DB" "
    select count(*)
    from role r
    join role_permission rp on rp.role_id = r.id and rp.deleted_at is null
    join permission p on p.id = rp.permission_id
    where r.id = 'role_operator'
      and r.status = 'active'
      and p.code = 'admin.apipool.quota.adjust';
  "
)"

if [ "$operator_role_ready" != "1" ]; then
  echo "[setup-smoke-users] active role_operator with admin.apipool.quota.adjust is missing" >&2
  exit 78
fi

current_portal_id="$(lookup_user_id "$SMOKE_PORTAL_EMAIL")"
current_operator_id="$(lookup_user_id "$SMOKE_OPERATOR_EMAIL")"

echo "[setup-smoke-users] portal email: $SMOKE_PORTAL_EMAIL"
echo "[setup-smoke-users] operator email: $SMOKE_OPERATOR_EMAIL"
echo "[setup-smoke-users] existing portal user: ${current_portal_id:-none}"
echo "[setup-smoke-users] existing operator user: ${current_operator_id:-none}"

if [ "$APPLY" != true ]; then
  echo "[setup-smoke-users] dry-run only; re-run with --apply to write portal DB and .env.deploy"
  exit 0
fi

if [ -x ./deploy/backup.sh ]; then
  ./deploy/backup.sh pre-smoke-users
else
  echo "[setup-smoke-users] missing executable deploy/backup.sh" >&2
  exit 66
fi

portal_id="${current_portal_id:-$(new_uuid)}"
operator_id="${current_operator_id:-$(new_uuid)}"
operator_user_role_id="$(new_uuid)"
now_ms="$(date +%s)000"

sqlite3 "$PORTAL_DB" <<SQL
BEGIN;

INSERT INTO user (
  id, name, email, email_verified, created_at, updated_at, utm_source, ip, locale
)
SELECT
  $(sql_value "$portal_id"),
  $(sql_value "$SMOKE_PORTAL_NAME"),
  $(sql_value "$SMOKE_PORTAL_EMAIL"),
  1,
  $now_ms,
  $now_ms,
  'smoke',
  '',
  ''
WHERE NOT EXISTS (
  SELECT 1 FROM user WHERE email = $(sql_value "$SMOKE_PORTAL_EMAIL")
);

UPDATE user
SET name = $(sql_value "$SMOKE_PORTAL_NAME"),
    email_verified = 1,
    updated_at = $now_ms,
    utm_source = 'smoke'
WHERE email = $(sql_value "$SMOKE_PORTAL_EMAIL");

INSERT INTO user (
  id, name, email, email_verified, created_at, updated_at, utm_source, ip, locale
)
SELECT
  $(sql_value "$operator_id"),
  $(sql_value "$SMOKE_OPERATOR_NAME"),
  $(sql_value "$SMOKE_OPERATOR_EMAIL"),
  1,
  $now_ms,
  $now_ms,
  'smoke',
  '',
  ''
WHERE NOT EXISTS (
  SELECT 1 FROM user WHERE email = $(sql_value "$SMOKE_OPERATOR_EMAIL")
);

UPDATE user
SET name = $(sql_value "$SMOKE_OPERATOR_NAME"),
    email_verified = 1,
    updated_at = $now_ms,
    utm_source = 'smoke'
WHERE email = $(sql_value "$SMOKE_OPERATOR_EMAIL");

INSERT INTO user_role (id, user_id, role_id, created_at, updated_at, expires_at)
SELECT
  $(sql_value "$operator_user_role_id"),
  u.id,
  'role_operator',
  $now_ms,
  $now_ms,
  NULL
FROM user u
WHERE u.email = $(sql_value "$SMOKE_OPERATOR_EMAIL")
  AND NOT EXISTS (
    SELECT 1 FROM user_role ur
    WHERE ur.user_id = u.id
      AND ur.role_id = 'role_operator'
      AND (ur.expires_at IS NULL OR ur.expires_at > $now_ms)
  );

COMMIT;
SQL

portal_id="$(lookup_user_id "$SMOKE_PORTAL_EMAIL")"
operator_id="$(lookup_user_id "$SMOKE_OPERATOR_EMAIL")"

set_env_value APIPOOL_SMOKE_PORTAL_EMAIL "$SMOKE_PORTAL_EMAIL"
set_env_value APIPOOL_SMOKE_OPERATOR_EMAIL "$SMOKE_OPERATOR_EMAIL"
set_env_value APIPOOL_SMOKE_PORTAL_USER_ID "$portal_id"
set_env_value APIPOOL_SMOKE_OPERATOR_USER_ID "$operator_id"

echo "[setup-smoke-users] wrote smoke user ids to $APP_DIR/$ENV_FILE"
echo "[setup-smoke-users] portal user id: $portal_id"
echo "[setup-smoke-users] operator user id: $operator_id"
