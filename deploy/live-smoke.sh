#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APIPOOL_DEPLOY_DIR:-/opt/apipool-v2}"
COMPOSE_FILE="${APIPOOL_COMPOSE_FILE:-docker-compose.prod.yml}"
ENV_FILE="${APIPOOL_ENV_FILE:-.env.deploy}"
RELEASE_FILE="${APIPOOL_RELEASE_FILE:-release.env}"

usage() {
  cat >&2 <<'USAGE'
usage: deploy/live-smoke.sh [--no-price-reconciliation]

Runs production MVP live smoke on the VPS using server-local .env.deploy.
Do not run this from GitHub Actions; it intentionally keeps production DB and
New API admin credentials on the server.
USAGE
}

PRICE_RECONCILIATION="${APIPOOL_SMOKE_PRICE_RECONCILIATION:-true}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-price-reconciliation)
      PRICE_RECONCILIATION=false
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

for required in "$COMPOSE_FILE" "$ENV_FILE" "$RELEASE_FILE"; do
  if [ ! -e "$required" ]; then
    echo "[live-smoke] missing $APP_DIR/$required" >&2
    exit 66
  fi
done

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
# shellcheck disable=SC1090
. "$RELEASE_FILE"
set +a

APIPOOL_SMOKE_REQUIRE_LIVE=true
APIPOOL_SMOKE_PRICE_RECONCILIATION="$PRICE_RECONCILIATION"
NODE_OPTIONS="${NODE_OPTIONS:---conditions react-server}"

export APIPOOL_SMOKE_REQUIRE_LIVE
export APIPOOL_SMOKE_PRICE_RECONCILIATION
export NODE_OPTIONS

required_env=(
  IMAGE_TAG
  DATABASE_URL
  NEWAPI_BASE_URL
  NEWAPI_ADMIN_TOKEN
  NEWAPI_ADMIN_USER_ID
  APIPOOL_SMOKE_PORTAL_USER_ID
  APIPOOL_SMOKE_OPERATOR_USER_ID
)

missing=()
for name in "${required_env[@]}"; do
  if [ -z "${!name:-}" ]; then
    missing+=("$name")
  fi
done

if [ "${#missing[@]}" -gt 0 ]; then
  printf '[live-smoke] missing required server-local env:' >&2
  printf ' %s' "${missing[@]}" >&2
  printf '\n' >&2
  echo "[live-smoke] run deploy/setup-smoke-users.sh --apply or update $APP_DIR/$ENV_FILE" >&2
  exit 78
fi

compose() {
  docker compose --env-file "$ENV_FILE" --env-file "$RELEASE_FILE" -f "$COMPOSE_FILE" "$@"
}

echo "[live-smoke] image tag: $IMAGE_TAG"
echo "[live-smoke] price reconciliation: $APIPOOL_SMOKE_PRICE_RECONCILIATION"

compose run --rm --no-deps \
  -e NODE_OPTIONS \
  -e APIPOOL_SMOKE_REQUIRE_LIVE \
  -e APIPOOL_SMOKE_PRICE_RECONCILIATION \
  -e APIPOOL_SMOKE_PRICE_TOLERANCE_QUOTA \
  -e APIPOOL_SMOKE_GROUP_SLUG \
  -e APIPOOL_SMOKE_PORTAL_USER_ID \
  -e APIPOOL_SMOKE_OPERATOR_USER_ID \
  -e APIPOOL_SMOKE_MODEL \
  -e APIPOOL_SMOKE_QUOTA_USD \
  -e APIPOOL_SMOKE_USAGE_ATTEMPTS \
  -e APIPOOL_SMOKE_USAGE_DELAY_MS \
  apipool-v2 \
  sh -lc 'test -f ./smoke-mvp.cjs || { echo "[live-smoke] smoke-mvp.cjs is missing from the portal image" >&2; exit 66; }; node ./smoke-mvp.cjs'
