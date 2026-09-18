# Security

## What the system must guarantee

1. A loan's principal can only reach the agent's card, and only within the per-period limit.
2. The card can only pay allowlisted payees, under a per-call cap, whatever the agent's model is told to do.
3. Repayment reaches noteholders up to the cap before the agent sees a cent of the fee stream.
4. Nobody — including us — can move a live loan's funds by admin action. The hub owner can rotate the underwriter signer and nothing else.

Enforcement lives in the contracts. The wallet policy and the payment gateway are defence in depth, and we say so plainly in `CLAIMS.md`.

## Threat model

- **A compromised or prompt-injected agent.** It controls its own keys and everything the model says. It cannot pay a non-allowlisted payee (the card's `isValidSignature` recomputes the EIP-3009 digest and checks the payee, the cap and the authorisation window), cannot exceed the per-period draw (the credit line reverts), and cannot reclaim its fee-beneficiary role early (only the escrow can return it).
- **A hostile lender or passer-by.** Every keeper action is permissionless by design (`harvest`, `settleAuction`, `markDefault`, `claim`), so we assume the worst caller and make each idempotent and bounded.
- **A hostile agent token or fee manager.** Both are attacker-chosen contracts the escrow must touch. We bound the gas and the revert data for every such call; a hostile *fee manager* remains an off-chain-vetted risk, and the underwriter refuses pools it does not recognise.
- **Oracle and swap manipulation.** Sweeps swap the WETH leg under a Chainlink bound with staleness, decimals and sequencer checks, all fail-closed. A searcher can still sandwich a sweep within that bound; the bound is the guarantee.

## Our own audit

We audited our own contracts before deploying and published the result rather than the summary: 1 high, 4 medium, 8 low.

The high one was ours to fix and we fixed it: the escrow handed the agent's pool token all of its remaining gas twice per harvest, so a token designed to burn gas could brick repayment, the beneficiary return and the abort path permanently. Every call into attacker-controlled code now runs on a bounded stipend with a bounded revert copy, proven by tests that fail on the old code.

The audit also broke one of its own findings on review: we had claimed a missing try/catch around the credit line's freeze was a bug; wrapping it would have rolled back the freeze itself, so the finding was retracted and downgraded, with the reasoning kept.

What we accept and disclose:
- A hostile fee manager can still grief the escrow's non-critical paths; the underwriter only signs terms for a fee manager it recognises.
- A pool that graduates out of the fee manager would end fee collection; such pools are refused at underwriting.
- Card funds left over from an earlier repaid loan are swept into a later loan's distribution if the same card is reused and that loan defaults.
- The demo's services are single-process, with in-memory rate limiting.

## Reporting

Found something? Open an issue with a reproduction, or reach the maintainer through the repository. There is no bounty; there is gratitude and credit.
