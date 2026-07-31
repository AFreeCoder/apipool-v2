#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/caddy-runtime.env
. "$SCRIPT_DIR/caddy-runtime.env"

usage() {
  echo "usage: $0 <output-binary>" >&2
  exit 64
}

[ "$#" -eq 1 ] || usage
OUTPUT="$1"

if [ "$(uname -s)" != "Linux" ] || [ "$(uname -m)" != "x86_64" ]; then
  echo "build-caddy-runtime.sh: requires Linux x86_64" >&2
  exit 69
fi

for command in curl sha256sum tar install; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "build-caddy-runtime.sh: missing command: $command" >&2
    exit 69
  fi
done

if [ -L "$OUTPUT" ]; then
  echo "build-caddy-runtime.sh: refusing symlink output: $OUTPUT" >&2
  exit 77
fi

WORK_DIR="$(mktemp -d)"
cleanup() {
  rm -rf -- "$WORK_DIR"
}
trap cleanup EXIT

GO_ARCHIVE="$WORK_DIR/go.tar.gz"
CADDY_ARCHIVE="$WORK_DIR/caddy-buildable.tar.gz"
SOURCE_DIR="$WORK_DIR/source"
BUILD_OUTPUT="$WORK_DIR/caddy"

curl --fail --silent --show-error --location --retry 3 \
  "$APIPOOL_CADDY_GO_URL" -o "$GO_ARCHIVE"
printf '%s  %s\n' "$APIPOOL_CADDY_GO_SHA256" "$GO_ARCHIVE" | sha256sum --check --status

curl --fail --silent --show-error --location --retry 3 \
  "$APIPOOL_CADDY_SOURCE_URL" -o "$CADDY_ARCHIVE"
printf '%s  %s\n' "$APIPOOL_CADDY_SOURCE_SHA256" "$CADDY_ARCHIVE" | sha256sum --check --status

install -d -m 0755 "$SOURCE_DIR" "$WORK_DIR/cache" "$WORK_DIR/tmp"
tar -xzf "$GO_ARCHIVE" -C "$WORK_DIR"
tar -xzf "$CADDY_ARCHIVE" -C "$SOURCE_DIR"

actual_go="$($WORK_DIR/go/bin/go env GOVERSION)"
if [ "$actual_go" != "$APIPOOL_CADDY_GO_VERSION" ]; then
  echo "build-caddy-runtime.sh: unexpected Go version: $actual_go" >&2
  exit 65
fi

(
  cd "$SOURCE_DIR"
  export CGO_ENABLED=0
  export GOARCH=amd64
  export GOOS=linux
  export GOTOOLCHAIN=local
  export GOCACHE="$WORK_DIR/cache"
  export GOTMPDIR="$WORK_DIR/tmp"
  "$WORK_DIR/go/bin/go" build \
    -mod=vendor \
    -trimpath \
    -buildvcs=false \
    -tags nobadger,nomysql,nopgx \
    -ldflags='-s -w' \
    -o "$BUILD_OUTPUT" .
)

actual_sha="$(sha256sum "$BUILD_OUTPUT" | awk '{print $1}')"
if [ "$actual_sha" != "$APIPOOL_CADDY_BINARY_SHA256" ]; then
  echo "build-caddy-runtime.sh: non-reproducible output: $actual_sha" >&2
  exit 65
fi

if [ "$($BUILD_OUTPUT version)" != "$APIPOOL_CADDY_VERSION" ]; then
  echo "build-caddy-runtime.sh: built Caddy version mismatch" >&2
  exit 65
fi
if ! "$BUILD_OUTPUT" build-info | grep -Fqx $'go\t'"$APIPOOL_CADDY_GO_VERSION"; then
  echo "build-caddy-runtime.sh: built Go version mismatch" >&2
  exit 65
fi
if ! "$BUILD_OUTPUT" build-info | grep -Fqx $'dep\tgithub.com/caddyserver/caddy/v2\t'"$APIPOOL_CADDY_VERSION"$'\t'; then
  echo "build-caddy-runtime.sh: built Caddy module mismatch" >&2
  exit 65
fi
if [ "$("$BUILD_OUTPUT" list-modules --skip-standard --json)" != "[]" ]; then
  echo "build-caddy-runtime.sh: non-standard modules are not allowed" >&2
  exit 65
fi

install -d -m 0755 "$(dirname -- "$OUTPUT")"
install -m 0755 "$BUILD_OUTPUT" "$OUTPUT"
printf '[caddy-build] version=%s go=%s sha256=%s output=%s\n' \
  "$APIPOOL_CADDY_VERSION" "$APIPOOL_CADDY_GO_VERSION" "$actual_sha" "$OUTPUT"
