# Review Advance in five minutes

1. **See it work — no wallet, no signup.** Open the live app (link in the submission). The landing page numbers are read from chain. Nothing is staged.
2. **Underwrite a real token.** Paste any Bankr/Doppler token address on `/underwrite`. You get its fee revenue read from archive state, the quality haircuts with reasons, the formula walk-through, and either terms or the exact reasons for refusal — plus an evidence hash you can fetch and re-derive.
3. **Open a loan page.** The certificate shows the cap and what has been repaid; the sweep timeline links every harvest transaction; the draw meter shows the per-period limit; the spend feed shows what the agent paid for.
4. **Look at the refusals.** Each one names the layer that refused: the credit line reverting on-chain, the card's own signature check rejecting a payment to a non-allowlisted payee, the gateway refusing before signing. Every on-chain refusal links to the explorer.
5. **Check the claims.** `docs/PROOF.md` lists every address and transaction. `docs/CLAIMS.md` tags each claim as verified, reproducible, modeled or explicitly not claimed. `docs/SECURITY.md` is our own audit of our own code, including what we could not fix and why.

Want to verify without trusting the site?

```bash
pnpm install
cd contracts && FOUNDRY_PROFILE=fork forge test    # full lifecycle against live Base contracts
bash script/lifecycle.sh                            # narrated loan lifecycle on a fork
cd .. && pnpm --filter @advance/eval start          # graded underwriting scorecard
```
