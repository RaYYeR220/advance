# Claims ledger

Every public statement about Advance, tagged by the evidence behind it. Nothing here is asserted without a way to check it.

- **VERIFIED-LIVE** — it happened on a public chain; the transaction is linked in `PROOF.md`.
- **REPRODUCIBLE** — you can reproduce it yourself with the command given, in minutes.
- **MODELED** — a projection or estimate, not a measurement.
- **NOT-CLAIMED** — things we deliberately do *not* assert.

## Verified live

| Claim | Where to check |
|---|---|
| The contracts are deployed and verified on Base Sepolia | `PROOF.md` → Deployment |
| A loan was funded by a real auction, drawn, and spent through x402; its note is `Active` and partially repaid (43.7% of its cap) from real pool fees | `PROOF.md` → Agent A |
| A second loan was funded, drawn, and left `Active` with its card still paying real x402 spend | `PROOF.md` → Agent B |
| An over-limit draw reverts on-chain (`CreditLine.DrawLimitExceeded`) | `PROOF.md` → The three refusals |
| A payment to a non-allowlisted payee is refused by the card's own ERC-1271 signature check | `PROOF.md` → The three refusals |
| A loan with no revenue was marked in default, its card frozen and undrawn principal returned to the noteholder | `PROOF.md` → Agent C |
| A default is written to the agent's ERC-8004 reputation on-chain (`-100`) | `PROOF.md` → Agent C |

## Reproducible

| Claim | Command | Where to check |
|---|---|---|
| The full loan lifecycle — including both ERC-8004 outcomes, `+100` repaid and `-100` default — runs against the live Doppler fee manager, Uniswap CCA, USDC, Chainlink and ERC-8004 on a Base mainnet fork | `cd contracts && FOUNDRY_PROFILE=fork forge test` | `PROOF.md` → Reproducible proofs → Fork test suite |
| The same lifecycle narrated end-to-end, one command | `cd contracts && bash script/lifecycle.sh` | `PROOF.md` → Reproducible proofs → Fork test suite |
| Contract test suite, including invariants and adversarial cases | `cd contracts && forge test` | `PROOF.md` → Reproducible proofs → Fork test suite |
| The underwriting engine decides correctly on 36 graded scenarios, never approves above its own formula, and never loosens terms under prompt injection | `pnpm --filter @advance/eval start` (scorecard in `eval/report.md`) | `PROOF.md` → Reproducible proofs → Graded underwriting eval |
| Underwriting reads real fee accrual from archive state for live tokens | `pnpm --filter @advance/core test` (recorded fixtures from mainnet) | `PROOF.md` → Reproducible proofs → Underwriting reads real fee accrual from archive state |

## Modeled

- Projected 90-day revenue, the decay factor and the resulting credit cap. These are formula outputs over past fee accrual, not promises about the future.
- The "runway" figure shown for an agent: card balance divided by a recent burn rate.
- Any yield implied by a note's clearing price. The market sets the price; repayment depends on the agent's pool.

## Not claimed

- **We do not claim the wallet provider enforces the payee rules.** We tested it: its policy engine gates transactions, not EIP-712 signatures. The payee allowlist and per-call cap are enforced by the card contract on-chain; the gateway check is defence in depth.
- **We do not claim Dynamic's MPC wallet signed the demo's on-chain transactions or its x402 payments.** Its key creation, EIP-712 typed-data signing, and transaction-allowlist policy sync all ran for real, live, for every agent in this deployment. Its own transaction-signing path (`signTransaction`) failed reproducibly in this runtime, across two different SDK dependency resolutions. Because an `AgentCard`'s owner key must be one consistent signer for both `signTransaction` and `signTypedData`, that failure ruled the MPC path out for these operational keys entirely — so every on-chain send and every x402 payment signature in the run documented in `PROOF.md` used local, encrypted key custody instead, for both the treasury and card-owner keys, on all three agents. The switch is one config value, precisely because the two custody backends are meant to be interchangeable once the upstream signing path is fixed.
- **We do not claim the credit is collateralised beyond the escrowed fee stream.** There is no recovery against an agent that abandons its token.
- **We do not claim any mainnet deployment or mainnet loan.** Everything proven in `PROOF.md` is Base Sepolia; there is no mainnet hub address or mainnet loan anywhere in this repository's history.
- **We do not claim the Bankr gateway's own facilitator accepts a contract payer.** The contract-payer flow proven live (`PROOF.md` → Agent A / Agent B) settles against the generic `x402.org` facilitator. Bankr's own x402 Cloud edge, which gates the paid underwriting-quote endpoint, has not been exercised with a contract payer here — left open, not claimed either way.
- **We do not claim the underwriting model predicts default.** It bounds exposure; it does not forecast.
- **We do not claim third-party pools are safe to onboard without review:** a hostile pool token was able to brick repayment until we bounded the gas we give it (see `SECURITY.md`), and a hostile fee manager remains an off-chain-vetted risk.
- **We do not claim uptime.** The demo services are single-process.
