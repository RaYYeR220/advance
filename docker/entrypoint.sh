#!/bin/sh
# Ensures the workspace's node_modules (which live in named volumes, not the
# bind-mounted repo - see docker-compose.yml) are installed and up to date
# with pnpm-lock.yaml before running the given command. Safe to run on every
# `docker compose run`: it only reinstalls when node_modules is missing or
# the lockfile changed since the last install in this volume.
set -eu

cd /app

LOCKFILE="pnpm-lock.yaml"
MARKER="node_modules/.pnpm-lock.sha256"
CURRENT_HASH="$(sha256sum "$LOCKFILE" | awk '{print $1}')"

NEED_INSTALL=0
if [ ! -f node_modules/.modules.yaml ]; then
  NEED_INSTALL=1
elif [ ! -f "$MARKER" ] || [ "$(cat "$MARKER")" != "$CURRENT_HASH" ]; then
  NEED_INSTALL=1
fi

if [ "$NEED_INSTALL" = "1" ]; then
  echo "[entrypoint] installing workspace dependencies (pnpm install --frozen-lockfile)..." >&2
  pnpm install --frozen-lockfile
  mkdir -p node_modules
  echo "$CURRENT_HASH" > "$MARKER"
else
  echo "[entrypoint] node_modules already up to date with $LOCKFILE, skipping install" >&2
fi

exec "$@"
