#!/usr/bin/env bash
set -Eeuo pipefail

# 该脚本安装到 /usr/local/sbin 后由 sudo 调用。不要从 Actions workspace 直接运行：
# 固定的 root-owned 副本是 Runner 与生产 root 权限之间的最小边界。
umask 077

unset DOCKER_HOST DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH

APP_DIR="/opt/apipool-v2"
EXPECTED_WORKSPACE="/opt/actions-runner-apipool/_work/apipool-v2/apipool-v2"
EXPECTED_ORIGIN="https://github.com/AFreeCoder/apipool-v2.git"

usage() {
  echo "usage: $0 <github-workspace> <sha-image-tag> <ghcr-user>" >&2
  exit 64
}

[ "$#" -eq 3 ] || usage

workspace="$(realpath -e -- "$1")"
image_tag="$2"
ghcr_user="$3"

if [ "$workspace" != "$EXPECTED_WORKSPACE" ]; then
  echo "runner-deploy: unexpected workspace: $workspace" >&2
  exit 77
fi

if [[ ! "$image_tag" =~ ^sha-[0-9a-f]{40}$ ]]; then
  echo "runner-deploy: invalid immutable image tag" >&2
  exit 64
fi

if [[ ! "$ghcr_user" =~ ^[A-Za-z0-9-]+$ ]]; then
  echo "runner-deploy: invalid GHCR username" >&2
  exit 64
fi

for required in .git; do
  if [ ! -e "$workspace/$required" ]; then
    echo "runner-deploy: missing workspace file: $required" >&2
    exit 66
  fi
done

git_in_workspace() {
  env -i PATH=/usr/bin:/bin HOME=/root \
    git -c safe.directory="$workspace" -C "$workspace" "$@"
}

origin="$(git_in_workspace config --get remote.origin.url || true)"
case "$origin" in
  "$EXPECTED_ORIGIN" | "${EXPECTED_ORIGIN%.git}") ;;
  *)
    echo "runner-deploy: unexpected git origin" >&2
    exit 77
    ;;
esac

expected_sha="${image_tag#sha-}"
actual_sha="$(git_in_workspace rev-parse HEAD)"
if [ "$actual_sha" != "$expected_sha" ]; then
  echo "runner-deploy: checkout HEAD does not match image tag" >&2
  exit 77
fi

if [ -n "$(git_in_workspace status --porcelain --untracked-files=all)" ]; then
  echo "runner-deploy: workspace is not clean" >&2
  exit 77
fi

verify_root_owned_tooling() {
  local path=""
  local owner=""
  local mode=""
  for path in "$APP_DIR" "$APP_DIR/deploy"; do
    if [ ! -d "$path" ] || [ "$(realpath -e "$path")" != "$path" ]; then
      echo "runner-deploy: missing or unsafe fixed deploy directory: $path" >&2
      exit 77
    fi
    owner="$(stat -c '%u' "$path")"
    mode="$(stat -c '%a' "$path")"
    if [ "$owner" != "0" ] || (( (8#$mode & 8#022) != 0 )); then
      echo "runner-deploy: fixed deploy directory must be root-owned and not group/world-writable: $path" >&2
      exit 77
    fi
  done

  for path in \
    "$APP_DIR/docker-compose.prod.yml" \
    "$APP_DIR/deploy/deploy.sh" \
    "$APP_DIR/deploy/backup.sh" \
    "$APP_DIR/deploy/configure-caddy.sh" \
    "$APP_DIR/deploy/cloudflare-ips.txt"; do
    if [ ! -f "$path" ] || [ "$(realpath -e "$path")" != "$path" ]; then
      echo "runner-deploy: missing or unsafe fixed deploy file: $path" >&2
      exit 77
    fi
    owner="$(stat -c '%u' "$path")"
    mode="$(stat -c '%a' "$path")"
    if [ "$owner" != "0" ] || (( (8#$mode & 8#022) != 0 )); then
      echo "runner-deploy: fixed deploy file must be root-owned and not group/world-writable: $path" >&2
      exit 77
    fi
  done

  path="$APP_DIR/.env.deploy"
  if [ ! -f "$path" ] || [ "$(realpath -e "$path")" != "$path" ]; then
    echo "runner-deploy: missing or unsafe production env file" >&2
    exit 77
  fi
  owner="$(stat -c '%u' "$path")"
  mode="$(stat -c '%a' "$path")"
  if [ "$owner" != "0" ] || (( (8#$mode & 8#077) != 0 )); then
    echo "runner-deploy: production env file must be root-owned and owner-only" >&2
    exit 77
  fi
}

verify_root_owned_tooling

ghcr_token=""
IFS= read -r ghcr_token || true
if [ -z "$ghcr_token" ]; then
  echo "runner-deploy: missing GHCR token on stdin" >&2
  exit 78
fi

DOCKER_CONFIG="$(mktemp -d /run/apipool-ghcr-auth.XXXXXX)"
export DOCKER_CONFIG
trap 'docker logout ghcr.io >/dev/null 2>&1 || true; rm -rf "$DOCKER_CONFIG"' EXIT

printf '%s' "$ghcr_token" | docker login ghcr.io -u "$ghcr_user" --password-stdin >/dev/null
ghcr_token=""

cd "$APP_DIR"
env -i \
  PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  HOME=/root \
  DOCKER_CONFIG="$DOCKER_CONFIG" \
  ./deploy/deploy.sh "$image_tag"
