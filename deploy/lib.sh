#!/bin/sh

# 调用方必须把状态文件绝对路径放在 STATE_ENV_FILE。
read_env_value() {
  key="$1"
  [ -f "$STATE_ENV_FILE" ] || return 0
  line="$(awk -v key="$key" '
    {
      entry = $0
      sub(/^[ \t]*/, "", entry)
      sub(/^export[ \t]+/, "", entry)
      if (index(entry, key "=") == 1) last = entry
    }
    END { if (last != "") print last }
  ' "$STATE_ENV_FILE")"
  [ -n "$line" ] || return 0
  value="${line#*=}"
  case "$value" in
    "'"*"'") value="${value#\'}"; value="${value%\'}" ;;
    '"'*'"') value="${value#\"}"; value="${value%\"}" ;;
  esac
  printf '%s' "$value"
}

# 所有键在一个同目录临时副本上完成，最后一次 rename 原子发布。
set_env_values() {
  tmp="$(mktemp "$(dirname "$STATE_ENV_FILE")/.env.deploy.XXXXXX")"
  next="${tmp}.next"
  trap 'rm -f "$tmp" "$next"' EXIT HUP INT TERM
  cp "$STATE_ENV_FILE" "$tmp"
  for kv in "$@"; do
    key="${kv%%=*}"
    value="${kv#*=}"
    if grep -q "^${key}=" "$tmp"; then
      awk -v k="$key" -v v="$value" '
        index($0, k "=") == 1 { $0 = k "=" v }
        { print }
      ' "$tmp" >"$next"
      mv -f "$next" "$tmp"
    else
      printf '%s=%s\n' "$key" "$value" >>"$tmp"
    fi
  done
  chmod 600 "$tmp"
  sync
  mv -f "$tmp" "$STATE_ENV_FILE"
  trap - EXIT HUP INT TERM
}
