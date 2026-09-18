# Uniswap developer feedback

Written while building [Advance](./README.md), a credit desk for AI agents that earn token fees.
Two Uniswap surfaces are load-bearing here: every loan is sold to lenders as a *revenue note* in a
**Continuous Clearing Auction**, and every repayment sweep converts the pool's WETH leg to USDC
through **SwapRouter02** under a Chainlink bound. Neither is decoration — remove either and the
protocol has no price discovery and no repayment path.

Everything below comes from actually shipping the integration: a spike against a Base mainnet fork,
a live auction on Base Sepolia that settled and paid its noteholders, and contracts deployed and
verified on Base mainnet.

---

## Where the integration lives

| What | File | Lines |
|---|---|---|
| Auction creation through the CCA factory, note supply minted into the auction, `onTokensReceived()` | [`contracts/src/AdvanceHub.sol`](contracts/src/AdvanceHub.sol) | 399–418 |
| `AuctionParameters` construction: step encoding, tick spacing, floor, graduation threshold | [`contracts/src/AdvanceHub.sol`](contracts/src/AdvanceHub.sol) | 729–753 |
| Auction wiring checks (`fundsRecipient` / `tokensRecipient` / `currency` / `token`) refused at `initialize` | [`contracts/src/CreditLine.sol`](contracts/src/CreditLine.sol) | 143–158 |
| Settlement: `sweepCurrency` → `isGraduated` → `sweepUnsoldTokens` → burn unsold | [`contracts/src/CreditLine.sol`](contracts/src/CreditLine.sol) | 160–192 |
| WETH → USDC via `SwapRouter02.exactInputSingle`, floor = max(oracle bound, keeper minimum) | [`contracts/src/RevenueEscrow.sol`](contracts/src/RevenueEscrow.sol) | 415–438 |
| Interfaces as we use them | [`contracts/src/interfaces/ICCA.sol`](contracts/src/interfaces/ICCA.sol), [`contracts/src/interfaces/ISwapRouter02.sol`](contracts/src/interfaces/ISwapRouter02.sol) | — |
| Lender side in TypeScript: Permit2 approvals then `submitBid`, settle, claim | [`packages/agent-kit/src/chain/actions.ts`](packages/agent-kit/src/chain/actions.ts) | 260–400 |
| CCA ABI, written by hand against deployed v2.1.0 | [`packages/core/src/abis/cca.ts`](packages/core/src/abis/cca.ts) | — |
| Full lifecycle against live Base contracts | [`contracts/test/fork/Lifecycle.fork.t.sol`](contracts/test/fork/Lifecycle.fork.t.sol), [`FailedAuction.fork.t.sol`](contracts/test/fork/FailedAuction.fork.t.sol) | — |

Addresses we integrated against: CCA factory `0x000000001F26a0044BaA66024e7b6599c61963F8` (Base and
Base Sepolia), SwapRouter02 `0x2626664c2603336E57B271c5C0b26F421741e481` (Base), Permit2
`0x000000000022D473030F116dDEE9F6B43aC78BA3`.

---

## What worked well

**The CCA is the right primitive for pricing something illiquid.** We sell a claim on an agent's
future fee revenue. We deliberately do not want to price that — the point of the product is that
lenders price it and we only enforce the ceiling. A continuous clearing auction gave us exactly that
with no AMM to seed, no liquidity to bootstrap and no oracle to trust, and the clearing price falls
out of the mechanism rather than out of our formula.

**`fundsRecipient` and `tokensRecipient` being separate addresses is a genuinely good design.** It
let us point both at the loan's `CreditLine` contract, so proceeds can never pass through an EOA we
control. We then verify that wiring on-chain at `initialize` and refuse the loan if it is wrong.
That is a safety property we got for free from the auction's own shape.

**CREATE2 determinism and one canonical factory across chains** made the deploy scripts trivially
chain-agnostic: same address on Base and Base Sepolia, no per-chain config drift.

**`SwapRouter02.exactInputSingle` is a stable, boring API**, which is the highest compliment for
something on a repayment path. Seven fields, no deadline, predictable gas.

---

## What cost us time

Ordered by how much time each one actually cost.

**1. The CCA repository docs describe an API that is not what v2.1.0 has deployed.** We wrote our
first integration against `initializeDistribution(...)` and `getAuctionAddress(...)` as documented,
then found neither exists in the deployed bytecode. The real flow is
`factory.create(token, amount, abi.encode(params), salt)`, then transfer the supply, then
`onTokensReceived()`. We only established that by probing the deployed contract on a fork. A
version-tagged README per deployed release, or even a line marking the current one as pre-2.1.0,
would have saved us hours on day one.

**2. `onTokensReceived()` is mandatory and skipping it fails silently until settlement.** Create an
auction, transfer the supply, never call it, and everything looks fine — bids can even be placed —
and then the sweep and checkpoint path reverts forever at the end, unrecoverably. This deserves to
be the loudest sentence in the quickstart, or the factory should pull the tokens itself so the step
cannot be skipped.

**3. `isGraduated()` reads stale state until something checkpoints the auction.** This was the most
dangerous thing we hit. Our first settlement read `isGraduated()` before sweeping and got the value
as of the last checkpoint rather than as of `endBlock`, so an auction that had in fact cleared could
be settled as failed and its lenders refunded. We caught it in a fork test and restructured
settlement so that `sweepCurrency()` runs first, precisely because it is what checkpoints
([`CreditLine.sol:160-174`](contracts/src/CreditLine.sol)). Nothing in the docs or in the function's
name suggests it is a view over possibly-stale state. Either name it
`isGraduatedAsOfLastCheckpoint()`, or expose a view that computes graduation as of the current
block.

**4. `auctionStepsData` encoding is unforgiving and undiagnosable.** It is
`abi.encodePacked(uint24 mps, uint40 blocks)` repeated, with two invariants that are easy to get
wrong: the sum of `mps × blocks` must equal exactly 1e7, and `startBlock + Σblocks` must equal
`endBlock`. Violating either reverts with no reason, so you cannot tell which one you broke. A
custom error per invariant, or a pure helper that builds the blob from a human description ("release
evenly over N blocks"), would turn an afternoon into five minutes. We wrote that helper ourselves
([`AdvanceHub.sol:729-753`](contracts/src/AdvanceHub.sol)).

**5. Bidding requires the Permit2 double-approve and nothing says so.** `USDC.approve(auction, …)`
does not work; you need `USDC.approve(PERMIT2, …)` and then
`Permit2.approve(USDC, auction, amount, expiration)`. Our first lender script died here on an opaque
revert. One line in the bidder quickstart would cover it.

**6. `CCALens` is deployed on mainnet but not on Base Sepolia.** Partial-fill exits need checkpoint
hints, and without the lens on testnet we had to reimplement the hint search by hand for our testnet
economy — which means we tested a code path that would not be the one running in production. Please
deploy the lens everywhere the factory is deployed.

**7. Small things.** Sweeps leave 1-wei rounding dust; harmless, but it broke our equality
assertions until we switched them to inequalities. `factory.create` costs roughly 3.83M gas, which
is worth publishing because it materially constrains what else fits in the same transaction — our
loan-open call had to be split across deployer libraries to stay under the block gas limit. And
`SwapRouter02.exactInputSingle` has no `deadline` field, unlike the original v3 `SwapRouter` that
most search results still show; we lost a compile cycle to that.

---

## What we would ask for next

- **A version-pinned integration guide per deployed CCA release**, with the exact call sequence and
  the addresses per chain. The mechanism is excellent; the on-ramp is archaeology.
- **A small TypeScript package for the encodings** — step data, tick-aligned prices, Q96
  conversions. Every integrator writes the same three functions, and each one is a place to put a
  rounding bug into someone's auction.
- **A checkpoint-aware graduation view**, so an integrator cannot read a stale settlement outcome.
- **`CCALens` on every chain where the factory is live**, so testnet integrations exercise the
  production path.

None of this changed our decision: given the same problem again we would use a CCA again. The
mechanism did what we needed; the friction was all in discovery, not in design.
