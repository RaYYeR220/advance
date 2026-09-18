# Advance

**Credit for agents that earn.**

An AI agent that launched a token has revenue — a share of its pool's trading fees — but no way to borrow against it. Advance underwrites that revenue from on-chain data, sells the loan to lenders as a *revenue note* in a Uniswap continuous clearing auction, delivers the money to a card the agent can only spend on allowlisted services, and repays itself by contract out of the fee stream. When a prompt-injected agent tries to drain its credit, the chain refuses.

Built on Base. Live on Base Sepolia; contracts and proof transactions on Base mainnet.

---

## How a loan works

| Step | What happens | Who can do it |
|---|---|---|
| 1. Underwrite | The engine reads the token's fee accrual from archive state (never self-reported numbers), scores trade quality, projects decaying revenue, and produces terms. A credit memo from a language model may only make those terms stricter. | Anyone, for any Bankr/Doppler token |
| 2. Escrow | The agent hands its pool's fee-beneficiary role to a `RevenueEscrow` deployed at an address the hub predicts. No escrow, no loan. | The agent |
| 3. Auction | The hub mints a `RevenueNote` (1 note = $1 of future repayment) and sells it in a Uniswap CCA. The market sets the price of the agent's revenue. | Any lender |
| 4. Card | Proceeds land in a `CreditLine` that releases them only to the agent's `AgentCard`, and only within a per-period limit. The card is an ERC-1271 contract that signs x402 payments **only** to an allowlisted payee, under a per-call cap. | The agent's key |
| 5. Sweep | Anyone can call `harvest()`: it collects the pool's fees, swaps the WETH leg to USDC under a Chainlink bound, and pays noteholders until the cap is met — then hands the beneficiary role back and writes the outcome to the agent's ERC-8004 reputation. | Anyone |

If revenue stops, `markDefault` freezes the card, returns undrawn principal to noteholders and records the default. Repayment is never forgiven: the escrow keeps sweeping until the cap is paid.

## The refusals

Three independent layers, each of which can say no on its own:

- **Credit line** — a draw above the per-period limit reverts on-chain (`DrawLimitExceeded`).
- **Agent card** — an x402 payment to a non-allowlisted payee, or above the per-call cap, fails inside USDC's own `transferWithAuthorization` because the card's `isValidSignature` refuses it.
- **Gateway** — the agent's payment client refuses and logs before a signature is ever requested, and the wallet policy refuses transactions to anything but the card.

The model never chooses a payee or an amount. Those are code.

## Repository

```
contracts/        Solidity: AdvanceHub, RevenueEscrow, RevenueNote, CreditLine, AgentCard, deployers
packages/core     Underwriting engine: on-chain reads, formula, evidence bundles, EIP-712 term sheets
packages/sdk      Typed client: score, quote, apply, bid, draw, claim
packages/mcp      MCP server exposing those operations to any agent
packages/agent-kit Key custody, the x402 card gateway, typed on-chain actions
apps/underwriter  HTTP API: free score, paid signed quote, evidence by hash
apps/agents       Autonomous borrower loop, keeper, paid testnet services
apps/web          The site and the app
eval/             Graded underwriting eval against a hidden answer key
skills/advance    Skill that teaches a Bankr agent to use Advance
```

## Run it

```bash
pnpm install
pnpm verify          # contracts + TypeScript tests, eval scorecard
```

Contract work needs [Foundry](https://getfoundry.sh):

```bash
cd contracts
forge test                              # unit + invariant
FOUNDRY_PROFILE=fork forge test         # against live Base contracts
bash script/lifecycle.sh                # the whole loan lifecycle on a fork, narrated
```

## Honest limits

- Credit is secured only by the escrowed fee stream. An agent can abandon its token; that is a default and a reputation record, not a recovery.
- The demo agents' keys are MPC wallets operated by the runtime. The policy that matters is on-chain; the wallet policy is defence in depth.
- Underwriting sees only on-chain history. Projections are models, and they are labelled as models.
- Pools that can graduate out of the fee manager are rejected, because graduation would end fee collection.
- See `docs/CLAIMS.md` for what is verified, what is reproducible and what we do not claim.

MIT licensed.
