# Advance — worked examples

Short, copy-pasteable sequences for both transports. See [SKILL.md](SKILL.md) for the mental model and safety rules these build on.

## 1. Borrow: score → quote → apply → draw (MCP)

```jsonc
// 1. Free eligibility check
{ "tool": "advance_score_token", "arguments": { "token": "0xTokenAddress" } }
// → { "kind": "eligible", "terms": { "capMicroUsd": "8000000", "floorCents": 80, ... } }

// 2. Paid quote — copy the whole response into step 3 verbatim
{
  "tool": "advance_get_quote",
  "arguments": { "token": "0xTokenAddress", "agentCard": "0xCardAddress", "agentId": "0" }
}
// → { "kind": "approve", "termSheet": { ... }, "signature": "0x...", ... }

// 3. Open the loan — decision is exactly advance_get_quote's output above
{
  "tool": "advance_apply",
  "arguments": { "decision": { "kind": "approve", "termSheet": { "...": "..." }, "signature": "0x..." }, "confirm": true }
}
// → { "ok": true, "loanId": "12", "openLoanTxHash": "0x...", "openLoanExplorerUrl": "https://basescan.org/tx/0x..." }

// 4. Wait for the auction to graduate, then check status
{ "tool": "advance_loan_status", "arguments": { "loanId": "12" } }
// → { "status": "Active", "available": "1000000", ... }  (available > 0 once Active)

// 5. Draw USDC onto the card
{
  "tool": "advance_draw_credit",
  "arguments": { "card": "0xCardAddress", "loanId": "12", "amount": "400000", "confirm": true }
}
// → { "ok": true, "hash": "0x...", "explorerUrl": "https://basescan.org/tx/0x..." }
```

## 2. Lend: find an auction, bid, claim (MCP)

```jsonc
// 1. What's live right now
{ "tool": "advance_list_auctions", "arguments": {} }
// → { "auctions": [ { "loanId": "12", "clearingPriceCents": 80, "requiredCurrencyRaised": "2000000", "raisedSoFar": "500000", ... } ] }

// 2. Bid 3 notes up to $0.85 each
{
  "tool": "advance_bid_on_note",
  "arguments": { "loanId": "12", "notes": "3000000000000000000", "maxPriceCents": 85, "confirm": true }
}
// → { "ok": true, "hash": "0x...", "bidId": "4" }

// 3. Later, once the note has repaid something, claim your share
{ "tool": "advance_claim_repayments", "arguments": { "loanId": "12", "confirm": true } }
// → { "ok": true, "hash": "0x...", "amount": "150000" }
```

## 3. Plain HTTP — score and quote without an MCP client

```bash
# Free score
curl -s https://underwriter.example.com/v1/score/0xTokenAddress | jq

# Paid quote (an x402-unaware client sees a 402 here if the underwriter is charging;
# retry through an x402-aware fetch/wallet rather than resending blind)
curl -s -X POST https://underwriter.example.com/v1/quote \
  -H 'content-type: application/json' \
  -d '{"token":"0xTokenAddress","agentCard":"0xCardAddress","agentId":"0","chainId":8453}' | jq

# The evidence bundle a decision's evidenceHash was computed from
curl -s https://underwriter.example.com/v1/evidence/0xEvidenceHash | jq
```

## 4. Explaining a refused draw

```jsonc
{ "tool": "advance_explain_refusal", "arguments": { "agent": "0xAgentTreasuryAddress", "limit": 5 } }
// → {
//     "agent": "0xAgentTreasuryAddress",
//     "events": [
//       {
//         "kind": "refusal",
//         "data": { "layer": "pretrade", "reason": "payTo outside the card's allowlist", "payTo": "0x...", "amount": "500000" },
//         "explanation": "refused at pretrade: paying 0x... (500000) — payTo outside the card's allowlist"
//       }
//     ]
//   }
```
