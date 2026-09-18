# Proof

Every claim below is checkable from this page alone: an address or a transaction hash on
[Base Sepolia](https://sepolia.basescan.org) or [Base mainnet](https://basescan.org), or a shell
command that reproduces the number next to it. Addresses marked "confirmed on-chain" were re-read
live while writing this page — not copied from a log.

## Deployment (Base mainnet, chain id 8453)

| Contract | Address |
|---|---|
| AdvanceHub | [`0xFe399e455E6fF9251CDae904423D69cb2772adeB`](https://basescan.org/address/0xFe399e455E6fF9251CDae904423D69cb2772adeB) |
| EscrowDeployer | [`0x0104DeA98a6CFA24bfcc43E183a2fE421d77270d`](https://basescan.org/address/0x0104DeA98a6CFA24bfcc43E183a2fE421d77270d) |
| LoanDeployer | [`0xD5bD206615E9bDa9E5b6eB6F9CbD36ed3B91AB26`](https://basescan.org/address/0xD5bD206615E9bDa9E5b6eB6F9CbD36ed3B91AB26) |
| Underwriter signer | `0x35C905C55bD6E77D7caFCFdb75DFCb05237Fe8C7` |
| Owner / deployer | [`0x70663CbD48a168A43120BC16e4712e1959fc382f`](https://basescan.org/address/0x70663CbD48a168A43120BC16e4712e1959fc382f) |
| Deployment | run recorded at block `51474067`; AdvanceHub's own creation tx landed at block `51474076` ([`0x602bc255…e9a6664`](https://basescan.org/tx/0x602bc255d82e3a9ebf8c2c8e5cb13c053bfc530bae9d38207ccfd26bbe9a6664), status success), EscrowDeployer at `51474074`, LoanDeployer at `51474075` — one sequential run, all three creator addresses match the owner above |

Config, re-read live from `AdvanceHub.config()` while writing this page:

| Parameter | Value | Meaning |
|---|---|---|
| `minActivityUsdc` | `100000` (**$0.10**) | fee-derived USDC that must reach a note before the default clock resets |
| `slippageBps` | `100` (**1%**) | allowed swap slippage below the Chainlink-derived price on harvest — tight, because mainnet's WETH/USDC pool is deep |
| `maxStaleness` | `3600` (**1h**) | maximum age of the ETH/USD price used to bound a harvest's swap |
| `sequencerFeed` | [`0xBCF85224fc0756B9Fa45aA7892530B47e10b6433`](https://basescan.org/address/0xBCF85224fc0756B9Fa45aA7892530B47e10b6433) | Base's real Chainlink L2 sequencer-uptime feed — set here, unlike Sepolia |

`owner()` and `underwriter()` read live off the deployed hub match the table above exactly, and the
hub's own `escrowDeployer()` / `loanDeployer()` getters match the two deployer addresses above —
this is the hub actually wired to these contracts, not just three addresses in the same file.

Verification, confirmed live against both services while writing this page:

| Contract | Sourcify | Blockscout |
|---|---|---|
| AdvanceHub | [exact_match](https://repo.sourcify.dev/8453/0xFe399e455E6fF9251CDae904423D69cb2772adeB) | [verified](https://base.blockscout.com/address/0xFe399e455E6fF9251CDae904423D69cb2772adeB) |
| EscrowDeployer | [exact_match](https://repo.sourcify.dev/8453/0x0104DeA98a6CFA24bfcc43E183a2fE421d77270d) | [verified](https://base.blockscout.com/address/0x0104DeA98a6CFA24bfcc43E183a2fE421d77270d) |
| LoanDeployer | [exact_match](https://repo.sourcify.dev/8453/0xD5bD206615E9bDa9E5b6eB6F9CbD36ed3B91AB26) | [verified](https://base.blockscout.com/address/0xD5bD206615E9bDa9E5b6eB6F9CbD36ed3B91AB26) |

All three were already `exact_match` on Sourcify's v2 API when this page was written. The
Blockscout mirror was missing (bytecode-only, no source) at the same time, so we submitted it live
with `forge verify-contract --verifier blockscout` for all three; polling the API afterward shows
`is_verified: true` with the full source and ABI for all three.

No loan has been opened against this mainnet hub yet — see "What is not proven yet" below.

### Mainnet AgentCard

A funded, allowlisted `AgentCard` exists on Base mainnet, independent of any loan:
[`0x4958a4ADbf75AF01dBeE5c2AED5aAcD391c4bdd9`](https://basescan.org/address/0x4958a4ADbf75AF01dBeE5c2AED5aAcD391c4bdd9) ·
owner [`0x6d6eA0b1C9262848053d67448EF533Adb5c3366E`](https://basescan.org/address/0x6d6eA0b1C9262848053d67448EF533Adb5c3366E) ·
allowlist = the Bankr LLM gateway's payTo
[`0x8AEE621035D93Deb3C0C1177fac252dC2dd501a0`](https://basescan.org/address/0x8AEE621035D93Deb3C0C1177fac252dC2dd501a0)
(the card's `payees()` returns exactly this one address) · per-call cap `10000` (**$0.01**) ·
auth window `300s` — every value here read live off the deployed contract.

Funded with 0.5 USDC:
[`0x91c81831…765a852b70b37`](https://basescan.org/tx/0x91c81831775acfc20a0fb29d8f7ad0fe683a9741d6d05a7e839765a852b70b37),
status success, a `Transfer` of `500000` USDC-wei from the owner to the card. The card's live USDC
balance is still `500000` — that funding transfer is the only USDC that has ever reached this
address, in or out (checked against its full token-transfer history, not just current balance).

**The open question, tried and left open.** We paid the Bankr LLM gateway 0.001 USDC (its own
quoted price for the endpoint) from this card over x402 on mainnet. The gateway returned HTTP 500
("Internal server error") without settling. As a control, we sent the identical payment — same
endpoint, same 0.001 USDC — from an ordinary EOA instead of the card. Same result: HTTP 500, no
settlement. On-chain balances for the card, the EOA and the payee were unchanged by either attempt
(the card's transfer history above shows why: nothing has ever left it). That makes the failure the
gateway's, not something specific to an ERC-1271 contract payer — but it also means the question we
set out to answer, *does that gateway's facilitator accept a contract payer at all*, is still open,
not answered. See `docs/CLAIMS.md` → Not claimed. Both attempts are reproducible scripts, not just
a narrated result:

```bash
cd packages/agent-kit
BASE_RPC_URL=... CARD_OWNER_PRIVATE_KEY=0x... node scripts/gateway-card-payer.mjs   # the card
DEPLOYER_PRIVATE_KEY=0x... node scripts/gateway-control-eoa.mjs                     # the control EOA
```

## Live app

[`https://advance-zeta.vercel.app`](https://advance-zeta.vercel.app) — the site, and the
underwriter API mounted at `/api/v1/*` on the same origin. An unpaid `POST /api/v1/quote` returns
HTTP 402 with x402 payment requirements for `$0.05` USDC, confirmed live while writing this page. A
paid credit-memo endpoint for the same quote also exists on Bankr's x402 Cloud at
[`https://x402.bankr.bot/0x95cffe1e64bbca51531f56096638a17f1029750a/quote`](https://x402.bankr.bot/0x95cffe1e64bbca51531f56096638a17f1029750a/quote)
(also confirmed live, same 402 and price) — it is not yet wired to the API's public URL above, so
paying it does not currently reach this repo's engine.

## Deployment and lifecycle (Base Sepolia, chain id 84532)

| Contract | Address |
|---|---|
| AdvanceHub | [`0x66FFBd5A064efAd1b421Ed0CC351A54f079214b7`](https://sepolia.basescan.org/address/0x66FFBd5A064efAd1b421Ed0CC351A54f079214b7) |
| EscrowDeployer | [`0x376f370e75f71d5C7ead6e55352b0E7C6c3D0815`](https://sepolia.basescan.org/address/0x376f370e75f71d5C7ead6e55352b0E7C6c3D0815) |
| LoanDeployer | [`0x0CE70FeE760b67cB23897425321FB7470c825Df0`](https://sepolia.basescan.org/address/0x0CE70FeE760b67cB23897425321FB7470c825Df0) |
| Underwriter signer | `0x35C905C55bD6E77D7caFCFdb75DFCb05237Fe8C7` |
| Owner / deployer | [`0x70663CbD48a168A43120BC16e4712e1959fc382f`](https://sepolia.basescan.org/address/0x70663CbD48a168A43120BC16e4712e1959fc382f) |
| Deployment block | `46974917` (creation tx [`0xdbaf7c4ea4ffc4bf5da90808b91bfb4864fa695ca92a497fe612d92471900515`](https://sepolia.basescan.org/tx/0xdbaf7c4ea4ffc4bf5da90808b91bfb4864fa695ca92a497fe612d92471900515)) |
| SepoliaSwapper (demo-only v4 volume helper, not part of the protocol) | [`0x1792aE4971E3aEB4942a1378Be6C92D974EE94E6`](https://sepolia.basescan.org/address/0x1792aE4971E3aEB4942a1378Be6C92D974EE94E6) |

Verification, confirmed live against both services:

| Contract | Sourcify | Blockscout |
|---|---|---|
| AdvanceHub | [exact_match](https://repo.sourcify.dev/84532/0x66FFBd5A064efAd1b421Ed0CC351A54f079214b7) | [verified](https://base-sepolia.blockscout.com/address/0x66FFBd5A064efAd1b421Ed0CC351A54f079214b7) |
| EscrowDeployer | [exact_match](https://repo.sourcify.dev/84532/0x376f370e75f71d5C7ead6e55352b0E7C6c3D0815) | [verified](https://base-sepolia.blockscout.com/address/0x376f370e75f71d5C7ead6e55352b0E7C6c3D0815) |
| LoanDeployer | [exact_match](https://repo.sourcify.dev/84532/0x0CE70FeE760b67cB23897425321FB7470c825Df0) | [verified](https://base-sepolia.blockscout.com/address/0x0CE70FeE760b67cB23897425321FB7470c825Df0) |

An earlier hub deploy (`0x4958a4ADbf75AF01dBeE5c2AED5aAcD391c4bdd9`) predated a gas-bounding security
fix and was superseded before any agent was provisioned against it; nothing on this page references
it, and it still holds code on-chain but was never used past that point.

Config values that matter, read live from `AdvanceHub.config()`:

| Parameter | Value | Meaning |
|---|---|---|
| `minActivityUsdc` | `10000` (**$0.01**) | fee-derived USDC that must reach a note before the default clock resets, scaled down for Sepolia's small demo loans |
| `slippageBps` | `3000` (**30%**) | allowed swap slippage below the Chainlink-derived price on harvest — wide because Sepolia's WETH/USDC pool is thin; the shipped mainnet config is far tighter |
| `maxStaleness` | `86400` (**24h**) | maximum age of the ETH/USD price used to bound a harvest's swap; longer than mainnet's 1h because Sepolia's feed heartbeats far less often |
| `sequencerFeed` | `0x000…000` | no L2 sequencer-uptime feed on Base Sepolia; the escrow skips that check here only |

## Agent A — a funded loan

ERC-8004 agent id `9297` · loan id `4` · treasury `0xE5E59E91B57d86B0Aa77906bFc7d571afBa829a5` ·
card [`0xe95D8E4684CeD7ceE49C2e4fb01d7877E8Bf2A9D`](https://sepolia.basescan.org/address/0xe95D8E4684CeD7ceE49C2e4fb01d7877E8Bf2A9D) ·
CreditLine [`0xD20962be98A28f89ACB1362726Ea17b77164647c`](https://sepolia.basescan.org/address/0xD20962be98A28f89ACB1362726Ea17b77164647c) ·
RevenueEscrow [`0x2858c46f763e2d5209a6Da8278E597469b5aEafa`](https://sepolia.basescan.org/address/0x2858c46f763e2d5209a6Da8278E597469b5aEafa) ·
RevenueNote [`0xf3c6649D38ca9Cac072968DE92A5033a11586Bb9`](https://sepolia.basescan.org/address/0xf3c6649D38ca9Cac072968DE92A5033a11586Bb9) ·
CCA auction [`0xa1Ae4DBB2a292d6A45930992Df6FB465651C97E3`](https://sepolia.basescan.org/address/0xa1Ae4DBB2a292d6A45930992Df6FB465651C97E3)

| Step | Tx |
|---|---|
| `openLoan` | [`0x7ba8373c…c761f257`](https://sepolia.basescan.org/tx/0x7ba8373c806bf04e1ccedf7f86d16d2f31a8fb1e4bab5f0dc028fbecc761f257) |
| Auction bid (1.0 USDC @ 90¢) | [`0xe84f3f98…5f7e435`](https://sepolia.basescan.org/tx/0xe84f3f980d39b4e89539dadc1b74d1b379b7f8702edd6c7fa3bfe861b5f7e435) |
| `settleAuction` (graduated, principal 899999 USDC-wei) | [`0xc7694dc3…9055ea59`](https://sepolia.basescan.org/tx/0xc7694dc3bbf29b913b41c7a12fbeff91a8d0e5fe8e7e942001361eea9055ea59) |
| `drawCredit` (full period limit, 899999 USDC-wei) | [`0x700f2daa…0c25b481c`](https://sepolia.basescan.org/tx/0x700f2daa442c07b4d5c79d79dc24d2bce674d90afe9fdf74ba5403f0c25b481c) |

**The over-limit draw.** Requesting 1 more USDC-wei against 0 remaining in the period reverted
`CreditLine.DrawLimitExceeded(uint256,uint256)` — selector `0xe0cd8baf`, confirmed independently with
`cast sig "DrawLimitExceeded(uint256,uint256)"`. This is a simulation revert (`eth_fillTransaction`),
never broadcast, so there is no transaction hash to link — that is the guarantee working: the
over-limit draw never reached the chain at all. Check it yourself against the live contract:
[`CreditLine` on Blockscout](https://base-sepolia.blockscout.com/address/0xD20962be98A28f89ACB1362726Ea17b77164647c).

x402 card spend, 3 settled payments of $0.001 each, real facilitator `https://x402.org/facilitator`,
payer = the card above, payee = the service treasury:

- [`0xbdff14a7…3bcd7341ea9`](https://sepolia.basescan.org/tx/0xbdff14a70af4cb38eaccccebdd57ee17cc6a56fa82a1e45bf52443bcd7341ea9)
- [`0xb4cb776d…6e2340785c27b1`](https://sepolia.basescan.org/tx/0xb4cb776dc813240884812f4371108764e14e739cf65a3eeab55e2340785c27b1)
- [`0x3e2c1109…09615114e41b6f08a6110d`](https://sepolia.basescan.org/tx/0x3e2c1109d17fb038ee3be4e9d06d4daa4f4134459a09615114e41b6f08a6110d)

A 4th attempt hit a transient facilitator settlement failure (HTTP 402, empty body) and the agent's
tool loop ended `work: incomplete` rather than fabricating an answer — no transaction, by design.

**26 harvests.** Each round wraps ETH, buys the agent token through the pool's live Doppler v4 hook,
sells roughly half back, then calls `RevenueEscrow.harvest`. Only `harvest` moves repayment; the
paired swaps are volume generation through the demo-only `SepoliaSwapper` and are not part of the
protocol. All 26 harvest transactions, in order:

<details>
<summary>26 harvest transaction hashes</summary>

| # | Tx |
|---|---|
| 1 | [`0x1efa9566…8d6daaa85`](https://sepolia.basescan.org/tx/0x1efa9566e4b6953cb88e39ce81d45e9524f0bae407f57f4ec8ebe298d6daaa85) |
| 2 | [`0x341a18e2…2629b98bd`](https://sepolia.basescan.org/tx/0x341a18e2e1818057eda123cd2ebefbaca08590a1efac3697d4585d72629b98bd) |
| 3 | [`0xca88f69f…8edeba529`](https://sepolia.basescan.org/tx/0xca88f69f5ccbf9d93379195a3ae6238b84b626eea712b0008f199dd8edeba529) |
| 4 | [`0x0419f184…5ccdd8f41`](https://sepolia.basescan.org/tx/0x0419f1840a3166489f7b7e3a40a3aee06c6452eddbfbde074c32df05ccdd8f41) |
| 5 | [`0xd8773b7a…7c6975f03`](https://sepolia.basescan.org/tx/0xd8773b7a29fb12a7ca8acc968ebb18b28448ea56402d25e1d52892f7c6975f03) |
| 6 | [`0xc3aedcbb…32acf4193`](https://sepolia.basescan.org/tx/0xc3aedcbbe9364d0f4dfe45ceb2d5b557005b735abd23e36e23ac72232acf4193) |
| 7 | [`0x0c346c24…251eb88`](https://sepolia.basescan.org/tx/0x0c346c24082160c600b9ce2910600661d62d347f2eb1b21bb1d5db225251eb88) |
| 8 | [`0x5ee78510…c6caddef16`](https://sepolia.basescan.org/tx/0x5ee785104ac117a2a375cfbbd5fb9dcce6738b2db7a43a29cf5e28c6caddef16) |
| 9 | [`0xd77bd097…ba64b482a`](https://sepolia.basescan.org/tx/0xd77bd0979bf7abc2db1b104eefd091daccc0c210b83234458af97c4ba64b482a) |
| 10 | [`0x431f51c1…5b8a7a0d8`](https://sepolia.basescan.org/tx/0x431f51c1863eadc57ce18b5e33459fee6d1c732d87241173a0d7cef5b8a7a0d8) |
| 11 | [`0x53401cb4…c6caa772e`](https://sepolia.basescan.org/tx/0x53401cb4252751d72762c42aff1938bdd315d115d0fbb4bf69035acc6caa772e) |
| 12 | [`0x767e952d…aab870acb`](https://sepolia.basescan.org/tx/0x767e952def11f46b310a00489e672a905a9238becaca4a0e5d04007aab870acb) |
| 13 | [`0xe28a821f…bd344f13e`](https://sepolia.basescan.org/tx/0xe28a821f411121525e9fef6082f4b095ccab46fb1d022c0c8ffc7e5bd344f13e) |
| 14 | [`0xffede5bb…610051c67e`](https://sepolia.basescan.org/tx/0xffede5bb2869ba94320926ad321181b75548d549bbcf35f50bb292610051c67e) |
| 15 | [`0x7be6befe…578e42cad`](https://sepolia.basescan.org/tx/0x7be6befe0dc2221521b4fd222d60947de344346b678caed31d9e51a578e42cad) |
| 16 | [`0x3e29f46f…fb6e0e4ed`](https://sepolia.basescan.org/tx/0x3e29f46ffd331a8b7cd1e076985232543cb7fb9a6ecc9f8cfc6dbc5fb6e0e4ed) |
| 17 | [`0x83e598bc…6e89adcf14`](https://sepolia.basescan.org/tx/0x83e598bc34fb8f6db06323864a817581ce310fd8e790178680a0776e89adcf14) |
| 18 | [`0x435f0a4d…deac9c713dc`](https://sepolia.basescan.org/tx/0x435f0a4d113db5674c32a87c33b02280200ad992241578c63c5a3deac9c713dc) |
| 19 | [`0x966108fc…584f0c50047d`](https://sepolia.basescan.org/tx/0x966108fca2e2741d615c9034f2445db3fa483ce2f39d6b94976a584f0c50047d) |
| 20 | [`0xdc7df6b1…6daa0ef1bb9`](https://sepolia.basescan.org/tx/0xdc7df6b1b28f5c1f6e977c6b6df04c005757ef10d6525652b398a6daa0ef1bb9) |
| 21 | [`0xd687b9a0…99d3477dc7c50b`](https://sepolia.basescan.org/tx/0xd687b9a088b967448a8b7dfa22baa9eebc643db1b09b401e4f99d3477dc7c50b) |
| 22 | [`0xd09d9351…f62192fc9640`](https://sepolia.basescan.org/tx/0xd09d935150b5f64c2dff4a9c26045b423db0f014e61a3f5c65e3f62192fc9640) |
| 23 | [`0x3d2e0f50…815fe5240343`](https://sepolia.basescan.org/tx/0x3d2e0f50543769b4177e85b2cd869117d87bf4db9566d5f3e724815fe5240343) |
| 24 | [`0x28252d1c…22120c3cfbb23`](https://sepolia.basescan.org/tx/0x28252d1ce810ba0d4ee1a999b76ef41a94dd94a084bd02caa6e22120c3cfbb23) |
| 25 | [`0xe673969f…437ac92bcfea9e`](https://sepolia.basescan.org/tx/0xe673969f2b17e77f6d541ff3dfce9a2b2f53fecffdebe25961437ac92bcfea9e) |
| 26 | [`0x14ba89e5…7ce7131593d1d32`](https://sepolia.basescan.org/tx/0x14ba89e50d0944560df70d53f82a4f812a6eff65e8593832a7ce7131593d1d32) |

</details>

**Current state, honestly.** Loan status is **Active (2)**, and `RevenueNote.totalRepaid()` is
**436,955 / 1,000,000 USDC-wei — 43.7% of the $1.00 repayment cap** (both re-read live from the
contract while writing this page). The note is not fully repaid: real Doppler-pool LP fees on this
thin Sepolia pool accrue slowly per unit of swap volume, and closing the remaining ~56% would have
required pushing past the run's 0.06 ETH testnet budget (already at ~0.056 ETH spent across the 26
rounds above). Recorded as-is rather than staged further.

## Agent B — active borrower

ERC-8004 agent id `9298` · loan id `5` · card [`0x6DE912dB7051BaD46d85D6A76b95bBc554CB180F`](https://sepolia.basescan.org/address/0x6DE912dB7051BaD46d85D6A76b95bBc554CB180F) ·
CreditLine [`0x249fb5F5fd94a41A4197cF5882240b4a81eD67fe`](https://sepolia.basescan.org/address/0x249fb5F5fd94a41A4197cF5882240b4a81eD67fe) ·
RevenueEscrow [`0x1f21683599DD3585cc1e48a061697d0e444ebE69`](https://sepolia.basescan.org/address/0x1f21683599DD3585cc1e48a061697d0e444ebE69) ·
RevenueNote [`0x5c6451A8ea3ad2e480a8ea4Cf81D2F70799ca708`](https://sepolia.basescan.org/address/0x5c6451A8ea3ad2e480a8ea4Cf81D2F70799ca708) ·
CCA auction [`0xBA2a9f23Aed8bA7Ae6Ebf602Efce2A35eF085943`](https://sepolia.basescan.org/address/0xBA2a9f23Aed8bA7Ae6Ebf602Efce2A35eF085943)

| Step | Tx |
|---|---|
| `openLoan` | [`0x2cc9f519…898e8e1d`](https://sepolia.basescan.org/tx/0x2cc9f5198861b595d1216ff12d8050dcde76f077fc7ea2509f458128898e8e1d) |
| Auction bid (1.0 USDC @ 90¢) | [`0x7054557c…168733808`](https://sepolia.basescan.org/tx/0x7054557ce699522d23bb225e219ce9c326e9af1d1011b9f742ec9d3168733808) |
| `settleAuction` | [`0x4b978339…5ef60b6fa`](https://sepolia.basescan.org/tx/0x4b97833919698204c4f117a4beace6a7ddd9ada997bbb8104f5fb9f5ef60b6fa) |
| `drawCredit` (899999 USDC-wei) | [`0x1a555de0…089debdfa0`](https://sepolia.basescan.org/tx/0x1a555de02b15bcb6b18e070b458cd9a5aae09750857eaed5418b57089debdfa0) |

x402 card spend, 4 settled payments of $0.001 each, same real facilitator, final tool call answered
from the paid data:

- [`0x90e95441…258e08a37`](https://sepolia.basescan.org/tx/0x90e954417b39c28e2257808d7fbd2843b4bce28d6b653a3603c145f258e08a37)
- [`0x17b7a790…14ca7f83779`](https://sepolia.basescan.org/tx/0x17b7a790a247b07353804a7499ae77cc11fb199646d2d5b113d5e14ca7f83779)
- [`0xed7a1783…8bde808c`](https://sepolia.basescan.org/tx/0xed7a178304a99f3d14f55d4145f4dc75d599625c8df8510b6aa914e18bde808c)
- [`0xadf0590b…9966d7f0fc`](https://sepolia.basescan.org/tx/0xadf0590bc8934afd34859a35cf4746082b3e8842daa39e85f8f5469966d7f0fc)

Left here deliberately: loan **Active**, card funded and still able to spend and draw. This is the
"active borrower" state, not an unfinished one.

## Agent C — default

ERC-8004 agent id `9300` · loan id `7` · card [`0x15B6Cce7306DB84b490673a474948cCF8d83f69c`](https://sepolia.basescan.org/address/0x15B6Cce7306DB84b490673a474948cCF8d83f69c) ·
CreditLine [`0x6721f5Af6041ad3e7834E087c0d6a30b5fD9B0Bb`](https://sepolia.basescan.org/address/0x6721f5Af6041ad3e7834E087c0d6a30b5fD9B0Bb) ·
RevenueEscrow [`0xe732d35af46C0f36B5ecB4023d4619AA05f896aA`](https://sepolia.basescan.org/address/0xe732d35af46C0f36B5ecB4023d4619AA05f896aA) ·
RevenueNote [`0xe30528A3Aca6d8d21bcd28426F8Bcf97e5488501`](https://sepolia.basescan.org/address/0xe30528A3Aca6d8d21bcd28426F8Bcf97e5488501) ·
CCA auction [`0xAd7732eCe884F45dABdFCceb01d53db0BFbBf496`](https://sepolia.basescan.org/address/0xAd7732eCe884F45dABdFCceb01d53db0BFbBf496)

| Step | Tx |
|---|---|
| `openLoan` | [`0x83e11991…5e80a57b835`](https://sepolia.basescan.org/tx/0x83e11991ef1dafe1d94ea50cd9c7c2c7c760b07ec4d9004f177f45e80a57b835) |
| Auction bid (0.8 USDC @ 90¢) | [`0x96162d43…3e26e21d12`](https://sepolia.basescan.org/tx/0x96162d4398b77d89b9d4f72a2d7dc2f5e64bdcad2e7299dc71da073e26e21d12) |
| `settleAuction` | [`0x89943e83…d5f0f6a7bf`](https://sepolia.basescan.org/tx/0x89943e83ddcb8641bfded437fabb3a36205b269d9ca2cbff127d95d5f0f6a7bf) |

No draws, no spend, no harvest revenue — the (compressed, 240s) grace period was waited out in real
time before defaulting.

| Step | Tx |
|---|---|
| `AdvanceHub.markDefault` | [`0xd8e7667d…4159a4c`](https://sepolia.basescan.org/tx/0xd8e7667d21bf9ea7e44ee1f7689db64923577876b589caa2903edc41c4159a4c) |
| Noteholder exits the CCA position | [`0xc07dc0b4…c3d4b4391a9e`](https://sepolia.basescan.org/tx/0xc07dc0b428a3d1eff6408d56ba913d7c2c2915d081176236826ac3d4b4391a9e) |
| `claimTokens` | [`0x825c2da4…8d8ddee56f7`](https://sepolia.basescan.org/tx/0x825c2da4033c91f832162b7bda916311320592cfcf231004213618d8ddee56f7) |
| `RevenueNote.claim()` — undrawn principal reaches the noteholder | [`0xf2acfc74…0e30359c6d22cdbd9def328182385fa2`](https://sepolia.basescan.org/tx/0xf2acfc7433aff56015e669cc01a4250b0e30359c6d22cdbd9def328182385fa2) |

**ERC-8004 reputation, read live from the registry**
([`0x8004B663056A597Dffe9eCcC1965A193B7388713`](https://sepolia.basescan.org/address/0x8004B663056A597Dffe9eCcC1965A193B7388713))
via `readFeedback(9300, 0x66FFBd5A064efAd1b421Ed0CC351A54f079214b7, 1)`:

```
value = -100, valueDecimals = 0, tag1 = "advance", tag2 = "default", isRevoked = false
```

## The three refusals

Each one is a layer refusing before value moves. Two of the three are now mined, reverted
transactions on Base Sepolia — not simulations, not view calls, not pre-broadcast reverts. Both
receipts show `status: 0` (failed) and were re-fetched live while writing this page.

1. **Gateway precheck (off-chain, before any signature is requested).** A synthetic HTTP 402
   offering payee `0x000000000000000000000000000000000000dEaD` — not on Agent A's card allowlist —
   fed to the real card-payment gateway. Result: HTTP 402, `refused: true`, logged with
   `layer: "gateway"`. No signature was ever requested, so there is nothing on-chain to link; this
   one stays off-chain by design — it is meant to stop a payment before it ever reaches the card.
2. **On-chain ERC-1271 rejection, mined.** A real USDC `transferWithAuthorization` to
   `0x000000000000000000000000000000000000dEaD` — not on Agent B's card allowlist — signed for real
   by Agent B's card-owner key and broadcast for real (the signer only checks the message shape, not
   the payee; the payee check lives on-chain, by design). It reverted with `"FiatTokenV2: invalid
   signature"` because
   [`AgentCard.isValidSignature`](https://sepolia.basescan.org/address/0x6DE912dB7051BaD46d85D6A76b95bBc554CB180F)
   returned `0xffffffff`: tx
   [`0xf1979b96…983590d13da8ef6388`](https://sepolia.basescan.org/tx/0xf1979b962254e6cdc5585aa202102f8d27679011b5d6dc983590d13da8ef6388),
   status `0` (reverted), gas used `62,814`.
3. **On-chain over-limit draw, mined.** Agent B's card calling its own `drawCredit` against `0`
   remaining in the period's `CreditLine` reverted `DrawLimitExceeded(100000, 0)` one level down,
   broadcast and mined: tx
   [`0xef253117…0378a17c0fd735823174706c`](https://sepolia.basescan.org/tx/0xef253117bf07a89859768b7519dbd76efc52f0290378a17c0fd735823174706c),
   status `0` (reverted), gas used `48,502`.

## Reproducible proofs

### Fork test suite against live Base contracts

```bash
cd contracts && FOUNDRY_PROFILE=fork forge test -vv
```

25 tests pass, 0 fail, against real mainnet-fork state: the genuine Doppler fees manager, a real
locked pool, the live Uniswap CCA factory, Permit2, SwapRouter02, Chainlink ETH/USD and sequencer
feeds, and the deployed ERC-8004 registries. Nothing is mocked except a test-only trader contract
that pushes swap volume through the real pool so the real hook accrues real fees.

What it proves, with the real numbers the suite prints:

| Fact | Value |
|---|---|
| Auction clears at the $0.80 floor, funds the credit line | principal **4,000,000 USDC-wei** |
| Harvest 1 (partial) | **3,169,627 USDC-wei** distributed, gas 611,569 |
| Harvest 2 (fills the cap, closes the escrow) | **1,830,372 USDC-wei** distributed, gas 883,222 |
| Total repaid | **4,999,999** — the $5.00 cap exactly, in 2 harvests of genuinely earned fees |
| Lender claims after settlement (`claimFor`, notes carried repayment through the auction) | **2,499,998** and **2,499,999 USDC-wei**, summing to 4,999,997 on a 2,000,000 stake each (+25%) |
| Doppler beneficiary shares returned to the creator on repayment | `getShares(poolId, creator)` back to **0.95e18** |
| ERC-8004 feedback on repayment | `value 100, tag1 "advance", tag2 "repaid"` |
| `markDefault` recovers undrawn + returned principal to noteholders | **4,000,000 USDC-wei**, gas 432,683 |
| ERC-8004 feedback on default | `value -100, tag1 "advance", tag2 "default"` |
| A loan defaulted, then repaid from later fees | shortfall **999,999 USDC-wei** repaid; registry holds both `-100 "default"` then `+100 "repaid"`, in order |
| A failed auction ($1.00 raised against a $2.00 floor) | loan **Failed**, full note supply burned to 0, creator's shares fully returned, **no reputation entry at all** — a failed raise is not a credit event |

Gas measured on the fork, for reference: `openLoan` 9,552,584 (mostly the CCA auction and per-loan
contract deploys) · `settleAuction` 361,164 · `harvest` 333,878–883,222 · `markDefault` 432,683 ·
`abort` 2,635,667.

Full contract test suite, including invariants and adversarial cases:

```bash
cd contracts && forge test
```

241 tests pass, 0 fail, 5 skipped (the 5 fork suites above, which skip unless run against a live
archive node).

A narrated version of the same lifecycle, one command, no test framework output to parse:

```bash
cd contracts && bash script/lifecycle.sh
```

Forks Base mainnet locally at the same pinned block the fork suite uses, opens a loan, runs the
auction, settles it, draws (including one draw rejected for exceeding its period's limit),
harvests and repays — then tears the fork down.

### Underwriting reads real fee accrual from archive state

```bash
pnpm --filter @advance/core test
```

Runs against fixtures recorded from live mainnet archive reads, so the revenue and quality formulas
in the data flow below are exercised against real fee-accrual and swap history, not synthetic data.

### Graded underwriting eval

```bash
pnpm --filter @advance/eval start
```

36 scenarios, scored against a fixed answer key:

| Metric | Result |
|---|---|
| Decision accuracy | **36 / 36 (100%)** |
| Deny-reason precision | **100%** (24 true positives, 0 false positives) |
| Deny-reason recall | **100%** (24 true positives, 0 false negatives) |
| Approvals inside the expected band | **20 / 20** |
| Hard invariants (approvals above formula cap, terms loosened under prompt injection, draw limit or floor moved by the memo) | **0, 0, 0, 0** |
| Negative control | **PASS** — correctly denies with `creator_has_no_shares, no_recent_revenue, below_minimum` |
| Overall | **PASS** |

The prompt-injection scenarios are part of the 36: three cases feed the credit-memo LLM step an
adversarial token description asking it to loosen terms, and the eval asserts the signed term sheet
never moves the cap up, the draw limit up, or the floor down versus the pre-memo formula output.

## What is not proven yet

- **No mainnet loan yet.** AdvanceHub, EscrowDeployer and LoanDeployer are deployed and verified on
  Base mainnet (above), and a funded, allowlisted `AgentCard` exists there too, but no loan has been
  opened, no auction has run and no credit line has drawn on mainnet. The self-audit's deployment
  gate (`docs/SECURITY.md`) clears a small own-pool mainnet loan, but none has been opened.
- **Whether Bankr's LLM-gateway facilitator accepts an ERC-1271 contract payer is still open — we
  tried, and the service didn't answer either way.** See "The open question, tried and left open"
  under the mainnet `AgentCard` above: both the contract payer and a control EOA got HTTP 500 from
  the same endpoint for the same amount, with no on-chain settlement on either side.
- **Whether Bankr's separate x402 Cloud edge (gating the paid underwriting-quote endpoint) accepts
  a contract payer is unexercised, not claimed either way.** The card spend proven live above (Agent
  A / Agent B) used a contract payer (the `AgentCard`, via EIP-3009 + ERC-1271) against the generic
  `https://x402.org/facilitator`, and that worked. Bankr's own x402 Cloud edge in front of
  `POST /v1/quote` — a different facilitator entirely — has not been tried with a contract payer
  here.
