# Running agent-kit in Docker

`@dynamic-labs-wallet/node-evm`'s native MPC binary only ships for
linux/darwin, so anything that loads it (the live Dynamic adapter, and any
future code that imports it eagerly) must run in this Linux container, not on
a Windows host.

## Why a named volume + entrypoint

`node_modules` is **not** part of the bind mount. pnpm's Windows-created
symlinked `node_modules` aren't readable from Linux, and the reverse is true
too, so dependencies are installed fresh, inside the container, into named
volumes (`agent-kit-root-node-modules`, `agent-kit-pkg-node-modules` -
declared in `../docker-compose.yml`).

`docker/entrypoint.sh` is the image's `ENTRYPOINT`. On every `docker compose
run`, before executing the given command, it:

1. Checks whether `node_modules/.modules.yaml` exists and whether
   `node_modules/.pnpm-lock.sha256` (a marker it writes) matches the current
   `pnpm-lock.yaml` hash.
2. If either is missing/stale, runs `pnpm install --frozen-lockfile` and
   updates the marker.
3. `exec`s the command you passed to `docker compose run`.

So a fresh volume installs automatically on first use, and an unchanged
volume skips straight to your command - no manual `pnpm install` step, ever.

## Commands

All commands run from the repo root (where `docker-compose.yml` lives).

Build the image (only needed after editing `docker/Dockerfile` or
`docker/entrypoint.sh`):

```bash
docker compose build agents
```

Run the unit test suite (works on a fresh volume with no extra steps):

```bash
docker compose run --rm agents pnpm --filter @advance/agent-kit test
```

Typecheck:

```bash
docker compose run --rm agents pnpm --filter @advance/agent-kit typecheck
```

### Live Dynamic test

Gated by `LIVE_DYNAMIC=1`. Needs real `DYNAMIC_ENVIRONMENT_ID` /
`DYNAMIC_API_TOKEN` - supply your own env file path, never commit one to the
repo. Generate a throwaway `WALLET_ENCRYPTION_KEY` per run; it's only used to
encrypt the key shares this run creates and is discarded when the container
exits.

```bash
TESTKEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
docker compose run --rm \
  --env-from-file /path/to/your/.env \
  -e LIVE_DYNAMIC=1 \
  -e WALLET_ENCRYPTION_KEY="$TESTKEY" \
  agents pnpm --filter @advance/agent-kit test:live
```

On Windows/Git Bash, prefix with `MSYS_NO_PATHCONV=1` and use a
`C:/...`-style path so the shell doesn't mangle it:

```bash
MSYS_NO_PATHCONV=1 docker compose run --rm \
  --env-from-file "C:/path/to/your/.env" \
  -e LIVE_DYNAMIC=1 \
  -e WALLET_ENCRYPTION_KEY="$TESTKEY" \
  agents pnpm --filter @advance/agent-kit test:live
```

`--env-from-file` is this Docker Compose version's flag for injecting a
file's variables into the *container's* environment on `docker compose run`
(Compose's `--env-file` flag instead controls variable substitution in the
compose file itself). Check `docker compose run --help` if your Compose
version differs.

### Starting fresh

To verify the install-on-first-use behavior, or to force a clean reinstall:

```bash
docker compose down -v   # drops the named volumes
docker compose run --rm agents pnpm --filter @advance/agent-kit test
```

The second command's first run prints `[entrypoint] installing workspace
dependencies...` to stderr; every run after that (until the lockfile
changes) prints `[entrypoint] node_modules already up to date ..., skipping
install` instead.
