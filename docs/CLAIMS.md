# Claims ledger

Every public statement about Advance, tagged by the evidence behind it. Nothing here is asserted without a way to check it.

- **VERIFIED-LIVE** — it happened on a public chain; the transaction is linked in `PROOF.md`.
- **REPRODUCIBLE** — you can reproduce it yourself with the command given, in minutes.
- **MODELED** — a projection or estimate, not a measurement.
- **NOT-CLAIMED** — things we deliberately do *not* assert.

## Verified live

| Claim | Where to check |
|---|---|
| The contracts are deployed and verified on Base Sepolia | `PROOF.md` → Sepolia deployment |
| A loan was funded by a real auction, drawn, spent through x402 and repaid from real pool fees | `PROOF.md` → Agent A |
| An over-limit draw reverts on-chain | `PROOF.md` → reverted draw |
| A payment to a non-allowlisted payee is refused by the card's own signature check | `PROOF.md` → refused payment |
| A loan with no revenue was marked in default, its card frozen and undrawn principal returned to noteholders | `PROOF.md` → Agent C |
| Repayment and default are written to the agent's ERC-8004 reputation | `PROOF.md` → reputation |

## Reproducible

| Claim | Command |
|---|---|
| The full loan lifecycle works against the live Doppler fee manager, Uniswap CCA, USDC, Chainlink and ERC-8004 on Base | `cd contracts && FOUNDRY_PROFILE=fork forge test` |
| A narrated end-to-end lifecycle on a Base fork | `cd contracts && bash script/lifecycle.sh` |
| The underwriting engine decides correctly on 36 graded scenarios, never approves above its own formula, and never loosens terms under prompt injection | `pnpm --filter @advance/eval start` (scorecard in `eval/report.md`) |
| Contract test suite, including invariants and adversarial cases | `cd contracts && forge test` |
| Underwriting reads real fee accrual from archive state for live tokens | `pnpm --filter @advance/core test` (recorded fixtures from mainnet) |

## Modeled

- Projected 90-day revenue, the decay factor and the resulting credit cap. These are formula outputs over past fee accrual, not promises about the future.
- The "runway" figure shown for an agent: card balance divided by a recent burn rate.
- Any yield implied by a note's clearing price. The market sets the price; repayment depends on the agent's pool.

## Not claimed

- **We do not claim the wallet provider enforces the payee rules.** We tested it: its policy engine gates transactions, not EIP-712 signatures. The payee allowlist and per-call cap are enforced by the card contract on-chain; the gateway check is defence in depth.
- We do not claim the credit is collateralised beyond the escrowed fee stream. There is no recovery against an agent that abandons its token.
- We do not claim mainnet loans at meaningful size. The mainnet activity is deliberately small and is labelled as such.
- We do not claim the underwriting model predicts default. It bounds exposure; it does not forecast.
- We do not claim third-party pools are safe to onboard without review: a hostile pool token was able to brick repayment until we bounded the gas we give it (see `SECURITY.md`), and a hostile fee manager remains an off-chain-vetted risk.
- We do not claim uptime. The demo services are single-process.
