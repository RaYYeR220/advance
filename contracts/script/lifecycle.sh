#!/usr/bin/env bash
# Runs script/Lifecycle.s.sol end to end against a throwaway anvil fork of Base mainnet, pinned to
# the same block the fork test suite uses, and tears the fork down when the narrative finishes (or
# fails). One command reproduces the whole loan lifecycle locally: open, auction, settle, draws
# (including one rejected for exceeding its period's limit), harvests, repaid.
#
#   bash script/lifecycle.sh
#
# Set BASE_RPC_URL to fork from a faster/private archive RPC; otherwise this falls back to the
# public https://mainnet.base.org endpoint the fork profile itself uses.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

FORK_RPC_URL="${BASE_RPC_URL:-https://mainnet.base.org}"
FORK_BLOCK=51403692
PORT="${LIFECYCLE_ANVIL_PORT:-8546}"
ANVIL_LOG="$(mktemp)"

echo "starting anvil (fork of Base mainnet at block $FORK_BLOCK, port $PORT)..."
anvil --fork-url "$FORK_RPC_URL" --fork-block-number "$FORK_BLOCK" --port "$PORT" --quiet \
  >"$ANVIL_LOG" 2>&1 &
ANVIL_PID=$!

cleanup() {
  local status=$?
  kill "$ANVIL_PID" >/dev/null 2>&1 || true
  wait "$ANVIL_PID" 2>/dev/null || true
  rm -f "$ANVIL_LOG"
  exit "$status"
}
trap cleanup EXIT INT TERM

echo "waiting for anvil to accept connections..."
for _ in $(seq 1 30); do
  if cast block-number --rpc-url "http://127.0.0.1:$PORT" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
if ! cast block-number --rpc-url "http://127.0.0.1:$PORT" >/dev/null 2>&1; then
  echo "anvil never came up; log:" >&2
  cat "$ANVIL_LOG" >&2
  exit 1
fi

# Forge's plain dry-run mode (no sender identity given) wraps the script itself in a throwaway
# on-chain contract to represent it; nested `new` deployments from inside that wrapper trip over
# anvil's RPC backend. Giving it a concrete sender skips that wrapper. This is anvil's well-known
# default account #0 -- a public testing key, funded only on this throwaway fork, never a secret --
# and nothing here is ever broadcast (no --broadcast flag), so it only ever signs a local
# simulation, not a real transaction.
ANVIL_DEV_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

forge script script/Lifecycle.s.sol --rpc-url "http://127.0.0.1:$PORT" --private-key "$ANVIL_DEV_KEY" -vv
