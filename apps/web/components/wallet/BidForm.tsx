"use client";

import { useState, type FormEvent } from "react";
import { createPublicClient, http, type Address, type Hex } from "viem";
import { base, baseSepolia } from "viem/chains";
import { useDynamicContext } from "@dynamic-labs/sdk-react-core";
import { isEthereumWallet } from "@dynamic-labs/ethereum";
import type { ChainContext } from "@advance/sdk";
import { txUrl } from "@/lib/explorer";
import { formatCents } from "@/lib/format";
import type { SupportedChainId } from "@/lib/env";
import { describeWalletError, submitBidWithSteps, type BidStepId, type BidStepStatus } from "./bidSteps";
import styles from "./BidPanel.module.css";

export interface SubmittedBid {
  id: string;
  bidId: bigint;
  notes: bigint;
  maxPriceCents: number;
  hash: Hex;
}

export interface BidFormProps {
  loanId: bigint;
  hub: Address;
  chainId: SupportedChainId;
  floorCents: number;
  live: boolean;
  onBidSubmitted: (bid: SubmittedBid) => void;
}

const STEP_ORDER: readonly BidStepId[] = ["approve-usdc", "approve-permit2", "submit-bid"];
const STEP_LABELS: Record<BidStepId, string> = {
  "approve-usdc": "Approve USDC for Permit2",
  "approve-permit2": "Approve the auction to pull USDC via Permit2",
  "submit-bid": "Submit the bid",
};

/** The bid form itself: notes and a max price, walked through USDC approve → Permit2 approve
 * → submit, each step shown with its own transaction link as it lands. Rejection and an
 * insufficient balance are reported in plain language, never a raw stack trace. */
export function BidForm({ loanId, hub, chainId, floorCents, live, onBidSubmitted }: BidFormProps) {
  const { primaryWallet, setShowAuthFlow, handleLogOut, sdkHasLoaded } = useDynamicContext();
  const [notes, setNotes] = useState("");
  const [maxPrice, setMaxPrice] = useState((floorCents / 100).toFixed(2));
  const [steps, setSteps] = useState<Partial<Record<BidStepId, { status: BidStepStatus; hash?: Hex }>>>({});
  const [error, setError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);

  if (!live) {
    return <p className={styles.ended}>This auction has ended — no more bids are accepted. Exit or claim any of your own bids below.</p>;
  }

  if (!sdkHasLoaded) {
    return <p className={styles.loading}>Loading wallet…</p>;
  }

  if (!primaryWallet) {
    return (
      <div className={styles.form}>
        <p className={styles.copy}>Connect a lender wallet to bid on this auction.</p>
        <button type="button" className="button" onClick={() => setShowAuthFlow(true)}>
          Connect wallet
        </button>
      </div>
    );
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);

    const notesInput = Number(notes);
    const priceInput = Number(maxPrice);
    if (!Number.isFinite(notesInput) || !Number.isInteger(notesInput) || notesInput <= 0) {
      setError("Enter a whole number of notes greater than zero.");
      return;
    }
    const priceCents = Math.round(priceInput * 100);
    if (!Number.isFinite(priceCents) || priceCents < floorCents) {
      setError(`Enter a max price at or above the ${formatCents(floorCents)} floor.`);
      return;
    }
    if (!primaryWallet || !isEthereumWallet(primaryWallet)) {
      setError("Connect an Ethereum-compatible wallet to bid.");
      return;
    }

    setSubmitting(true);
    setSteps({});
    try {
      const wallet = await primaryWallet.getWalletClient();
      const chain = chainId === 8453 ? base : baseSepolia;
      const publicClient = createPublicClient({ chain, transport: http() });
      const notesValue = BigInt(notesInput);
      // Cast: viem's `Client` generics don't structurally unify across independently
      // inferred `createPublicClient` calls (a well-known viem/TypeScript limitation) — the
      // runtime client is fully compatible with `ChainContext`'s `publicClient`.
      const ctx = { publicClient, hub } as unknown as ChainContext;
      const result = await submitBidWithSteps(wallet, ctx, { loanId, notes: notesValue, maxPriceCents: priceCents }, (update) => {
        setSteps((prev) => ({ ...prev, [update.id]: { status: update.status, hash: update.hash } }));
      });
      onBidSubmitted({ id: result.hash, bidId: result.bidId, notes: notesValue, maxPriceCents: priceCents, hash: result.hash });
      setNotes("");
    } catch (err) {
      setError(describeWalletError(err));
    } finally {
      setSubmitting(false);
    }
  }

  const address = primaryWallet.address;

  return (
    <form className={styles.form} onSubmit={handleSubmit}>
      <p className={styles.copy}>
        Connected as {address.slice(0, 6)}…{address.slice(-4)}.{" "}
        <button type="button" className={styles.link} onClick={() => handleLogOut()}>
          Disconnect
        </button>
      </p>
      <label className={styles.field}>
        <span>Notes</span>
        <input type="number" min="1" step="1" value={notes} onChange={(e) => setNotes(e.target.value)} disabled={submitting} required />
      </label>
      <label className={styles.field}>
        <span>Max price (USD per note)</span>
        <input
          type="number"
          min={(floorCents / 100).toFixed(2)}
          step="0.01"
          value={maxPrice}
          onChange={(e) => setMaxPrice(e.target.value)}
          disabled={submitting}
          required
        />
      </label>
      <button type="submit" className={`button ${styles.submit}`} disabled={submitting}>
        {submitting ? "Bidding…" : "Place bid"}
      </button>
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      {Object.keys(steps).length > 0 ? (
        <ol className={styles.steps}>
          {STEP_ORDER.map((id) => {
            const step = steps[id];
            return (
              <li key={id} data-status={step?.status ?? "waiting"}>
                <span>{STEP_LABELS[id]}</span>
                {step?.hash ? (
                  <a href={txUrl(chainId, step.hash)} target="_blank" rel="noreferrer">
                    view tx
                  </a>
                ) : (
                  <span aria-hidden="true">{step ? "…" : ""}</span>
                )}
              </li>
            );
          })}
        </ol>
      ) : null}
    </form>
  );
}
