# contracts

Foundry project for the Advance protocol: revenue-backed credit for AI agents on Base.

## Build

```
forge build
```

## Test

Offline unit and invariant suite (no network access):

```
forge test
```

Fork suite against real Base mainnet USDC (network access required):

```
FOUNDRY_PROFILE=fork forge test --match-contract AgentCard
```

The `fork` profile (see `foundry.toml`) pins the fork to `https://mainnet.base.org` at block
`51403692`, sets the `optimism:holocene` hardfork (works around a Foundry/op-revm panic when
forking Base past that point), and scopes itself to `test/fork/*` so the command above only runs
the fork suite, never the offline unit tests.

## Deploy

`script/Deploy.s.sol` deploys one chain's `EscrowDeployer`, `LoanDeployer` and `AdvanceHub` from
the configuration at `script/config/<chainid>.json` (see `8453.json` for Base mainnet, `84532.json`
for Base Sepolia). It refuses to deploy if any configured address (other than an optional zero
`sequencerFeed`) has no code on the target chain, and writes the result to
`deployments/<chainid>.json`.

Required environment:

```
UNDERWRITER_ADDRESS=0x...   # the underwriter key that signs term sheets
OWNER_ADDRESS=0x...         # the hub owner (rotates the underwriter, nothing else)
PRIVATE_KEY=0x...           # deployer key (or use --ledger / --trezor / --unlocked instead)
```

Base Sepolia:

```
forge script script/Deploy.s.sol \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" \
  --broadcast \
  --verify --verifier sourcify
```

Base mainnet:

```
forge script script/Deploy.s.sol \
  --rpc-url "$BASE_RPC_URL" \
  --broadcast \
  --verify --verifier sourcify
```

### Verification

Etherscan's free tier does not cover Base, so verification runs through Sourcify and Blockscout
instead. `--verify --verifier sourcify` on the deploy command above verifies every contract in the
run's receipts in one pass. To verify a specific contract after the fact (or add the Blockscout
mirror), use `forge verify-contract` directly:

```
# Sourcify
forge verify-contract <address> src/AdvanceHub.sol:AdvanceHub \
  --chain 84532 --verifier sourcify

# Blockscout (Base Sepolia)
forge verify-contract <address> src/AdvanceHub.sol:AdvanceHub \
  --chain 84532 \
  --verifier blockscout --verifier-url https://base-sepolia.blockscout.com/api/

# Blockscout (Base mainnet)
forge verify-contract <address> src/AdvanceHub.sol:AdvanceHub \
  --chain 8453 \
  --verifier blockscout --verifier-url https://base.blockscout.com/api/
```

`AdvanceHub` takes constructor arguments (`Config`, `underwriter`, `owner`,
`EscrowDeployer`, `LoanDeployer`); pass `--constructor-args $(cast abi-encode ...)` or
`--guess-constructor-args` if verifying it outside of `--verify` on the deploy script itself.
`EscrowDeployer` and `LoanDeployer` take none.

### Local proof (anvil fork)

The deploy script's whole path -- reading config, refusing on missing code, deploying, writing the
artifact -- is exercised against a local fork before it ever touches a real chain:

```
anvil --fork-url https://mainnet.base.org --fork-block-number 51403692 &
forge script script/Deploy.s.sol \
  --rpc-url http://127.0.0.1:8545 \
  --broadcast \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
```

(that private key is anvil's public, well-known default account #0 -- never a real key). Forking
Base mainnet keeps `block.chainid` at `8453`, so the script reads `script/config/8453.json`
unmodified. A run against this fork is not a real deployment: its `deployments/8453.json` and
`broadcast/` output are local proof artifacts, not committed.

### Base Sepolia addresses

Every address in `script/config/84532.json` was checked non-empty with
`cast code <address> --rpc-url $BASE_SEPOLIA_RPC_URL` before the file was written (chain id
confirmed `84532`):

| Field | Address | Code length |
|---|---|---|
| `usdc` | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | 1,798 bytes |
| `weth` | `0x4200000000000000000000000000000000000006` | 2,041 bytes |
| `ccaFactory` | `0x000000001F26a0044BaA66024e7b6599c61963F8` | 24,214 bytes |
| `router` | `0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4` | 24,497 bytes |
| `ethUsdFeed` | `0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1` | 9,571 bytes |
| `reputationRegistry` | `0x8004B663056A597Dffe9eCcC1965A193B7388713` | 130 bytes |
| `identityRegistry` | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | 130 bytes |
| feesManager (per-loan, not hub config) | `0xBDF938149ac6a781F94FAa0ed45E6A0e984c6544` | 24,384 bytes |

`sequencerFeed` is intentionally the zero address: Base Sepolia has no L2 sequencer-uptime feed.

## Lifecycle demo

`script/Lifecycle.s.sol` narrates one loan end to end -- open, auction, settle, draws (including
one draw rejected for exceeding its period's limit), harvests, repaid -- against a real Doppler fee
stream (the same Ratspeak/WETH pool the fork test suite uses), forked from live Base mainnet. One
command reproduces the whole thing locally:

```
bash script/lifecycle.sh
```

This starts a throwaway `anvil --fork-url https://mainnet.base.org --fork-block-number 51403692`
(override the RPC with `BASE_RPC_URL`, the port with `LIFECYCLE_ANVIL_PORT`, default `8546`), runs
the narrated script against it, and tears the fork down on exit. Nothing is broadcast: every
protocol step runs through `vm.prank`, exactly like the fork test suite, so it needs no signing key
for the live pool creator or the auction's bidders. A run prints, in order: the deployed hub and
card, the agent's ERC-8004 registration, the pledged fee share, the opened loan's contracts, the
two-bidder auction and its graduated settlement, a full-limit draw followed by one draw rejected
for exceeding it, each harvest's repayment until the note's cap is filled, and the closed loan's
final state (shares home, card unfrozen, +100 reputation feedback, both lenders' claims).

## Keeper gas budgets

Measured against the live fork (`test/fork/*.t.sol`, and `script/Lifecycle.s.sol`'s own run):

| Call | Budget | Measured |
|---|---|---|
| `AdvanceHub.openLoan` | ~9.6M | 9,552,584 (fork test) / 9,574,642 (lifecycle demo) |
| `AdvanceHub.markDefault` | up to ~2.4M | asserted `< 2,400,000` in `test/fork/Default.fork.t.sol` |
| `RevenueEscrow.harvest` (cap-filling) | ~1.5-2M | asserted `< 2,000,000` in `test/fork/Lifecycle.fork.t.sol`; 611,575 / 883,228 in the demo's two harvests |

`openLoan` is almost entirely contract creation (the escrow, credit line, note and CCA auction);
`markDefault` and `harvest` stay well under their budgets in practice, with headroom kept for a
noisier pool or a card that spends its whole `CARD_HOOK_GAS` stipend.
