#!/bin/sh
# Runs the end-to-end suite against examples/hello-target with real Docker (~25 minutes on a laptop).
# Results land in examples/hello-target/results-e2e/ (ignored by git).
set -eu

KIT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TARGET_DIR="$KIT_DIR/examples/hello-target"
SOCKET=/var/run/docker.sock
IMAGE=dexter-bench-e2e:local

docker build --quiet --target e2e -t "$IMAGE" -f "$KIT_DIR/cli/Dockerfile" "$KIT_DIR" >/dev/null
SOCKET_GID=$(stat -c %g "$SOCKET" 2>/dev/null || stat -f %g "$SOCKET")

exec docker run --rm \
  --user "$(id -u):$(id -g)" \
  --group-add "$SOCKET_GID" \
  -e HOME=/tmp \
  -e BENCH_KIT_VERSION="$(git -C "$KIT_DIR" describe --always --dirty 2>/dev/null || echo unknown)" \
  -v "$SOCKET:$SOCKET" \
  -v "$TARGET_DIR:$TARGET_DIR" \
  -w "$TARGET_DIR" \
  "$IMAGE" "$@"
