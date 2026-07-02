#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

APP_DIR="${APIPOOL_DEPLOY_DIR:-/opt/apipool-v2}"
DB_PATH="$APP_DIR/data/new-api/one-api.db"
APPLY=0
HELD_LOCK_DIRS=()
HELD_LOCK_FDS=()

usage() {
  cat >&2 <<'USAGE'
usage: repair-newapi-options.sh [--db <path>] [--apply]

Dry-run by default. Use --apply only after a pre-deploy backup exists.
USAGE
}

die() {
  echo "[repair-newapi-options] $*" >&2
  exit 1
}

cleanup() {
  local status=$?
  local lock_dir

  for lock_dir in "${HELD_LOCK_DIRS[@]:-}"; do
    rmdir "$lock_dir" >/dev/null 2>&1 || true
  done

  exit "$status"
}
trap cleanup EXIT

while [ "$#" -gt 0 ]; do
  case "$1" in
    --db)
      [ "$#" -ge 2 ] || die "--db requires a path"
      DB_PATH="$2"
      shift 2
      ;;
    --apply)
      APPLY=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage
      die "unknown argument: $1"
      ;;
  esac
done

sql_literal() {
  local value="$1"
  printf "'%s'" "${value//\'/\'\'}"
}

sqlite() {
  sqlite3 -batch "$DB_PATH" "$@"
}

sqlite_noheader() {
  sqlite3 -batch -noheader "$DB_PATH" "$@"
}

sha256_file() {
  local file="$1"

  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  else
    cksum "$file" | awk '{print $1}'
  fi
}

make_writable_lock_file() {
  local requested="$1"
  local fallback="$2"
  local lock_dir

  lock_dir="$(dirname "$requested")"
  if mkdir -p "$lock_dir" >/dev/null 2>&1 && [ -w "$lock_dir" ]; then
    printf '%s\n' "$requested"
    return
  fi

  lock_dir="$(dirname "$fallback")"
  mkdir -p "$lock_dir"
  printf '%s\n' "$fallback"
}

acquire_lock() {
  local lock_file="$1"
  local label="$2"
  local mode="${3:-create}"
  local fd
  local lock_dir

  if [ "$mode" = "existing-only" ] && [ ! -e "$lock_file" ]; then
    return
  fi

  if command -v flock >/dev/null 2>&1; then
    lock_dir="$(dirname "$lock_file")"
    if [ "$mode" = "create" ]; then
      mkdir -p "$lock_dir"
    fi

    exec {fd}>"$lock_file"
    if ! flock -n "$fd"; then
      echo "[repair-newapi-options] $label is running; refusing to continue" >&2
      exit 75
    fi
    HELD_LOCK_FDS+=("$fd")
    return
  fi

  lock_dir="$lock_file.lockdir"
  if mkdir "$lock_dir" >/dev/null 2>&1; then
    HELD_LOCK_DIRS+=("$lock_dir")
    return
  fi

  echo "[repair-newapi-options] $label is running; refusing to continue" >&2
  exit 75
}

require_sqlite() {
  command -v sqlite3 >/dev/null 2>&1 || die "sqlite3 is required"
}

require_database() {
  [ -f "$DB_PATH" ] || die "database not found: $DB_PATH"
  [ -r "$DB_PATH" ] || die "database is not readable: $DB_PATH"

  if [ "$APPLY" -eq 1 ]; then
    [ -w "$DB_PATH" ] || die "database is not writable: $DB_PATH"
    [ -w "$(dirname "$DB_PATH")" ] || die "database directory is not writable: $(dirname "$DB_PATH")"
  fi
}

require_options_schema() {
  local column_count

  column_count="$(
    sqlite_noheader "select count(*) from pragma_table_info('options') where name in ('key', 'value');"
  )" || die "failed to inspect options table"

  if [ "$column_count" != "2" ]; then
    die "options table must exist with key/value columns"
  fi
}

invalid_options_sql() {
  cat <<'SQL'
with expected(key, expected_type, repairable_empty) as (
  values
    ('GroupRatio', 'object', 0),
    ('TopupGroupRatio', 'object', 0),
    ('UserUsableGroups', 'object', 0),
    ('GroupGroupRatio', 'object', 1),
    ('group_ratio_setting.group_special_usable_group', 'object', 1),
    ('AutoGroups', 'array', 0)
)
select
  o.key || ' expected ' || e.expected_type || ' JSON, got ' ||
  case
    when o.value is null then 'NULL'
    when o.value = '' then 'empty string'
    when json_valid(o.value) != 1 then 'invalid JSON'
    else coalesce(json_type(value), 'unknown')
  end
from expected e
join options o on o.key = e.key
where
  not (
    e.repairable_empty = 1 and (o.value is null or o.value = '')
  )
  and case
    when o.value is null then 1
    when json_valid(o.value) != 1 then 1
    when json_type(value) != e.expected_type then 1
    else 0
  end = 1
order by o.key;
SQL
}

repair_needed_sql() {
  cat <<'SQL'
with repair_keys(key) as (
  values
    ('GroupGroupRatio'),
    ('group_ratio_setting.group_special_usable_group')
)
select r.key
from repair_keys r
left join options o on o.key = r.key
where o.key is null or o.value is null or o.value = ''
order by r.key;
SQL
}

rollback_rows_sql() {
  cat <<'SQL'
with repair_keys(key) as (
  values
    ('GroupGroupRatio'),
    ('group_ratio_setting.group_special_usable_group')
)
select r.key, case when o.key is null then 1 else 0 end, quote(o.value)
from repair_keys r
left join options o on o.key = r.key
order by r.key;
SQL
}

validate_options() {
  local invalid

  # theme.frontend is a string setting in New API and is intentionally excluded
  # from JSON-map validation.
  invalid="$(sqlite "$(invalid_options_sql)")" || die "failed to validate New API options"

  if [ -n "$invalid" ]; then
    echo "[repair-newapi-options] invalid New API option rows:" >&2
    printf '%s\n' "$invalid" >&2
    return 1
  fi
}

read_repairs() {
  sqlite "$(repair_needed_sql)"
}

write_rollback_sql() {
  local rollback_dir="$1"
  local rollback_file="$2"
  local rows
  local key
  local missing
  local quoted_value

  mkdir -p "$rollback_dir"

  rows="$(sqlite3 -batch -separator $'\t' "$DB_PATH" "$(rollback_rows_sql)")"

  {
    echo "-- Rollback SQL for deploy/repair-newapi-options.sh"
    echo "-- Restore only the two repaired New API option-map rows."
    echo ".timeout 5000"
    echo "PRAGMA busy_timeout=5000;"
    echo "BEGIN IMMEDIATE;"

    while IFS=$'\t' read -r key missing quoted_value; do
      [ -n "$key" ] || continue

      if [ "$missing" = "1" ]; then
        printf 'delete from options where key = %s;\n' "$(sql_literal "$key")"
      else
        printf 'insert into options(key, value) values (%s, %s) on conflict(key) do update set value = excluded.value;\n' \
          "$(sql_literal "$key")" "$quoted_value"
      fi
    done <<<"$rows"

    echo "COMMIT;"
  } > "$rollback_file"
}

apply_repairs() {
  local repairs="$1"
  local rollback_dir="${APIPOOL_REPAIR_ROLLBACK_DIR:-$(dirname "$DB_PATH")}"
  local timestamp
  local rollback_file
  local checksum
  local sql_file
  local key

  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  rollback_file="$rollback_dir/newapi-options-rollback-$timestamp.sql"
  write_rollback_sql "$rollback_dir" "$rollback_file"
  checksum="$(sha256_file "$rollback_file")"

  sql_file="$(mktemp)"
  {
    echo ".timeout 5000"
    echo "PRAGMA busy_timeout=5000;"
    echo "BEGIN IMMEDIATE;"
    for key in GroupGroupRatio group_ratio_setting.group_special_usable_group; do
      printf 'insert into options(key, value) values (%s, '"'"'{}'"'"') on conflict(key) do update set value = case when options.value is null or options.value = '"'"''"'"' then excluded.value else options.value end;\n' \
        "$(sql_literal "$key")"
    done
    echo "COMMIT;"
  } > "$sql_file"

  sqlite3 -batch "$DB_PATH" < "$sql_file" >/dev/null
  rm -f "$sql_file"

  while IFS= read -r key; do
    [ -n "$key" ] || continue
    echo "applied repair $key -> {}"
  done <<<"$repairs"

  echo "rollback sql: $rollback_file"
  echo "rollback sha256: $checksum"
}

require_sqlite
require_database

repair_lock="${APIPOOL_REPAIR_LOCK:-/run/apipool-v2-repair-newapi-options.lock}"
repair_lock="$(make_writable_lock_file "$repair_lock" "${TMPDIR:-/tmp}/apipool-v2-repair-newapi-options.lock")"
acquire_lock "$repair_lock" "New API option repair"
acquire_lock "${APIPOOL_DEPLOY_LOCK:-/run/apipool-v2-deploy.lock}" "APIPool deploy" existing-only
acquire_lock "${APIPOOL_BACKUP_LOCK:-/run/apipool-v2-backup.lock}" "APIPool backup" existing-only

require_options_schema
validate_options

repairs="$(read_repairs)"

if [ -z "$repairs" ]; then
  echo "no repair needed"
  exit 0
fi

if [ "$APPLY" -eq 0 ]; then
  while IFS= read -r key; do
    [ -n "$key" ] || continue
    echo "would repair $key -> {}"
  done <<<"$repairs"
  exit 0
fi

apply_repairs "$repairs"
