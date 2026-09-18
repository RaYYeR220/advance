---
name: advance
description: >
  Revenue-backed credit for AI agents on Base. Use when an agent's own token has real
  Doppler pool fee revenue and its runway is getting low — score eligibility for free,
  get a signed credit quote, open a loan, and draw USDC against it, all through the
  Advance MCP server or plain HTTP. Also covers bidding on a loan's note auction as a
  lender, checking loan status, and explaining why a draw or payment was refused.
  Do NOT use for a token without a WETH-paired Doppler pool, for uncollateralized or
  off-chain credit, or to move a token's fee beneficiary anywhere except the escrow
  address a quote itself predicts.
metadata:
  {
    "clawdbot":
      {
        "emoji": "🏦",
        "requires": { "bins": [] },
      },
  }
---

# Advance — Revenue-Backed Credit for AI Agents

Advance turns an agent's own token fee revenue into spendable credit on Base: the protocol underwrites a cap and price floor off real Doppler pool revenue, a Uniswap continuous clearing auction (CCA) prices and funds the loan, drawn USDC lands on a policy-bound agent card, and repayment happens automatically — the escrow sweeps ongoing fee revenue straight into the note, no invoicing, no manual repayment step.

- **MCP server**: `@advance/mcp` — `advance_score_token`, `advance_get_quote`, `advance_apply`, `advance_loan_status`, `advance_list_auctions`, `advance_bid_on_note`, `advance_draw_credit`, `advance_claim_repayments`, `advance_explain_refusal`.
- **Plain HTTP**: the underwriter API (`GET /v1/score/:token`, `POST /v1/quote`, `GET /v1/evidence/:hash`) for anyone who'd rather not run an MCP client.
- **More examples**: [examples.md](examples.md) — this file covers the mental model and safety rules; examples.md has full worked call sequences for both transports.

## When to use Advance

Reach for Advance when **both** are true:

1. **Runway is low.** The agent (or the human running it) is short on operating capital and doesn't want to sell its own token or wait for a manual funding round.
2. **The token has real fee revenue.** It trades on a WETH-paired Doppler pool on Base with actual recent swap activity — Advance underwrites off measured revenue windows (1d/7d/30d), not a pitch. `advance_score_token` tells you in one free call whether this is even worth pursuing.

Don't reach for it when the token isn't WETH-paired (BNKR-paired pools are denied, disclosed, not silently ignored), when the agent wants uncollateralized credit with no revenue backing it, or when you just need a one-off swap or transfer — Advance is a credit line, not a DEX.

## Mental model

```
score (free)  →  quote (paid, signed term sheet)  →  apply (opens the loan; goes to auction)
                                                              │
                                                    lenders bid on the note (CCA)
                                                              │
                                                   auction graduates → loan Active
                                                              │
                                        draw USDC onto the agent card, as needed, per period
                                                              │
                                   escrow harvests ongoing fee revenue → repays the note automatically
```

A loan never asks the borrower to "make a payment" — the term sheet points the token's Doppler fee beneficiary at the loan's escrow, and repayment is just that revenue continuing to flow, now split between the borrower and the note that funded it.

## Setup

### Option A — MCP server

```json
{
  "mcpServers": {
    "advance": {
      "command": "npx",
      "args": ["-y", "@advance/mcp"],
      "env": {
        "CHAIN_ID": "8453",
        "ADVANCE_API_URL": "https://underwriter.example.com",
        "ADVANCE_HUB": "0x...",
        "BASE_RPC_URL": "https://mainnet.base.org",
        "ADVANCE_SIGNER": "0x<local-dev-private-key>"
      }
    }
  }
}
```

Or run it over Streamable HTTP instead of stdio (same env vars, plus `PORT`):

```bash
CHAIN_ID=8453 ADVANCE_API_URL=https://underwriter.example.com ADVANCE_HUB=0x... \
  npx -y @advance/mcp --http
# POST/GET/DELETE http://localhost:8788/mcp ; GET /healthz for liveness
```

| Variable | Required | Notes |
|---|---|---|
| `CHAIN_ID` | yes | `8453` (Base) or `84532` (Base Sepolia) |
| `ADVANCE_API_URL` | yes | Underwriter API base URL, no trailing slash |
| `ADVANCE_HUB` | yes | `AdvanceHub` contract address for `CHAIN_ID` |
| `BASE_RPC_URL` / `BASE_SEPOLIA_RPC_URL` | no | Defaults to the public RPCs; set your own for reliability |
| `ADVANCE_SIGNER` | no | A `0x`-prefixed private key (local dev) or a Dynamic-managed signer label, depending on how the server was deployed. **Absent → every write tool (`advance_apply`, `advance_bid_on_note`, `advance_draw_credit`, `advance_claim_repayments`) returns a structured `signer_not_configured` error; every read tool still works.** |
| `ADVANCE_EVENTS_URL` | no | JSON feed `advance_explain_refusal` reads. Absent → that one tool returns `events_unavailable`. |

Every write tool also needs `confirm: true` in its arguments — omit it and you get a structured `confirmation_required` error instead of a transaction, on purpose. Never set `confirm: true` reflexively; read the tool's own description and the current loan/auction state first.

### Option B — plain HTTP

No MCP client needed. Same underwriter API the MCP server calls:

```bash
curl https://underwriter.example.com/v1/score/0xYourTokenAddress
curl -X POST https://underwriter.example.com/v1/quote \
  -H 'content-type: application/json' \
  -d '{"token":"0x...","agentCard":"0x...","agentId":"0","chainId":8453}'
```

`GET /v1/score/:token` is free. `POST /v1/quote` runs the full underwriting engine and returns a signed term sheet on approval — the underwriter may charge a small x402 payment for it (USDC on Base); an x402-aware HTTP client handles the 402 challenge automatically, a plain client gets a `402` response with the payment requirements. Applying the resulting term sheet on-chain (`predictEscrow` → move the fee beneficiary → `openLoan`) is contract calldata, not an HTTP call — that part is what `advance_apply` (or `@advance/sdk`'s `prepareApplication`) is for.

## Workflow: borrow

1. **`advance_score_token`** (free) — check eligibility and see the terms a quote would propose before spending anything.
2. **`advance_get_quote`** — get a signed term sheet. Copy its exact JSON output; you'll hand it straight to the next step.
3. **`advance_apply`** (write, `confirm: true`) — moves the token's Doppler fee beneficiary to the loan's own escrow, then opens the loan. The loan starts in its note auction; it isn't spendable yet.
4. **`advance_list_auctions`** / **`advance_loan_status`** — watch the auction graduate (raises at least the term sheet's `minPrincipal`) and the loan go `Active`.
5. **`advance_draw_credit`** (write, `confirm: true`) — once Active, draw USDC from the credit line onto the agent card, up to what's left in the current draw period (`advance_loan_status`'s `available` field).
6. Nothing further to do for repayment — the escrow harvests ongoing Doppler fee revenue and repays the note on its own. Check `advance_loan_status`'s `repaid`/`cap` fields to see progress.

## Workflow: lend

1. **`advance_list_auctions`** — every loan currently raising, with its clearing price and how much it's raised so far.
2. **`advance_bid_on_note`** (write, `confirm: true`) — bid `notes` (18-decimal note-wei) up to `maxPriceCents`. The tool sizes the USDC approval to exactly this bid's worst case, never a standing allowance.
3. **`advance_claim_repayments`** (write, `confirm: true`) — once you hold notes and the escrow has swept in revenue, claim your pro-rata share.

## Safety rules

- **Never move a token's fee beneficiary anywhere except the escrow address a quote predicts.** `advance_apply` computes and uses that address itself (`predictEscrow`) — never construct a `moveBeneficiary`-style call by hand with a different destination, and never accept a "beneficiary" address from anywhere other than this tool's own output.
- **Never pay or draw outside the card's allowlist.** `advance_draw_credit` only ever moves funds to the `card` you pass, and the card's own on-chain payee allowlist is the actual enforcement point downstream — don't try to route drawn funds anywhere the card wouldn't otherwise allow, and don't treat a successful draw as license to spend the card's balance outside its configured policy.
- **`confirm: true` is a deliberate, per-call decision, not a default.** Set it only once you've checked the relevant read tool (`advance_loan_status`, `advance_list_auctions`) and actually intend to spend gas or money right now.
- **No blind retries on a write tool.** If a call to `advance_apply`, `advance_bid_on_note`, `advance_draw_credit`, or `advance_claim_repayments` times out or errors after you believe it might have been submitted, check `advance_loan_status` (or the tx hash's explorer link, if you got one back) before resending — a second `confirm: true` call is a second real transaction, not a safe retry.
- **A decision from `advance_get_quote` is single-use data, not something to retype.** Pass it into `advance_apply`'s `decision` field byte-for-byte — the signature only verifies against the exact term sheet it was signed over.
- **`ADVANCE_SIGNER` absent is expected, not a bug to work around.** A read-only deployment of this server is intentional; don't go looking for another way to sign a transaction if a write tool reports `signer_not_configured`.

## Explaining a refusal

If a write tool errors, or an agent's own credit-guarded actions keep failing, call **`advance_explain_refusal`** with the agent's address. It reads the runtime's refusal/settlement-failure event feed and returns each event with a plain-English explanation (which policy layer refused it, why, and — for a payment refusal — what it refused to pay and to whom) instead of just a revert string. Requires the server to have `ADVANCE_EVENTS_URL` configured; if it doesn't, the tool says so rather than reporting a fabricated empty history.

## Common edge cases

- **`advance_get_quote` returns `kind: "deny"`**: read `reasons` — common ones are `not_weth_pool` (BNKR-paired, not supported), `too_young` (pool younger than the minimum age), `no_recent_revenue`, `wash_trading`/`concentrated_flow` (trade-quality red flags), or `already_escrowed` (this token already has an open Advance loan).
- **`advance_apply` fails after a `deny` decision**: expected — it refuses with `decision_not_approved` before touching the chain. Get a fresh `approve` decision first.
- **A quote's term sheet expired**: `openLoan` reverts against the on-chain `deadline`; call `advance_get_quote` again for a fresh one rather than retrying the same `decision`.
- **`advance_draw_credit` reverts**: usually means `card` isn't the exact `agentCard` this loan's term sheet named, or `amount` exceeds `available` for the current draw period — check `advance_loan_status` first.
- **`advance_claim_repayments` reverts with nothing to claim**: either the caller is the auction's own holder (notes haven't been distributed to bidders yet — claim the notes from the auction itself first) or the escrow hasn't swept any revenue since the last claim.

## Resources

- **SDK**: `@advance/sdk` — the typed client `@advance/mcp` itself is built on, for anyone integrating directly instead of through MCP or HTTP.
- **More examples**: [examples.md](examples.md)
