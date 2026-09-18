"use client";

import { useState } from "react";
import { createPublicClient, http, type Address, type Hex } from "viem";
import { base, baseSepolia } from "viem/chains";
import { useDynamicContext } from "@dynamic-labs/sdk-react-core";
import { isEthereumWallet } from "@dynamic-labs/ethereum";
import { txUrl } from "@/lib/explorer";
import { formatCents, formatInteger } from "@/lib/format";
import type { SupportedChainId } from "@/lib/env";
import { claimBidTokens, describeWalletError, exitBid, type AuctionCtx } from "./bidSteps";
import type { SubmittedBid } from "./BidForm";
import styles from "./BidPanel.module.css";

export interface BidLadderProps {
  bids: readonly SubmittedBid[];
  auction: Address;
  chainId: SupportedChainId;
  live: boolean;
}

type Action = "exit" | "claim";
interface RowState {
  pending?: Action;
  error?: string;
  exitHash?: Hex;
  claimHash?: Hex;
}

/**
 * This session's own submitted bids, each with its transaction link and, once the auction has
 * ended, exit/claim buttons. There is no on-chain way to enumerate a CCA's full bid book (the
 * auction contract exposes neither a bid list nor a `BidSubmitted` event) — this is honestly
 * scoped to the bids this browser has placed, not every bid in the auction.
 */
export function BidLadder({ bids, auction, chainId, live }: BidLadderProps) {
  const { primaryWallet } = useDynamicContext();
  const [rows, setRows] = useState<Record<string, RowState>>({});

  if (bids.length === 0) {
    return <p className={styles.copy}>No bids placed from this wallet session yet.</p>;
  }

  async function run(bid: SubmittedBid, action: Action) {
    setRows((prev) => ({ ...prev, [bid.id]: { pending: action } }));
    try {
      if (!primaryWallet || !isEthereumWallet(primaryWallet)) throw new Error("Connect an Ethereum-compatible wallet first.");
      const wallet = await primaryWallet.getWalletClient();
      const chain = chainId === 8453 ? base : baseSepolia;
      const publicClient = createPublicClient({ chain, transport: http() });
      // Cast: viem's `Client` generics don't structurally unify across independently
      // inferred `createPublicClient` calls (a well-known viem/TypeScript limitation) — the
      // runtime client is fully compatible with `AuctionCtx`'s `publicClient`.
      const ctx = { publicClient, auction } as unknown as AuctionCtx;
      const hash = action === "exit" ? await exitBid(wallet, ctx, bid.bidId) : await claimBidTokens(wallet, ctx, bid.bidId);
      setRows((prev) => ({ ...prev, [bid.id]: { [action === "exit" ? "exitHash" : "claimHash"]: hash } }));
    } catch (err) {
      setRows((prev) => ({ ...prev, [bid.id]: { error: describeWalletError(err) } }));
    }
  }

  return (
    <ul className={styles.bidList}>
      {bids.map((bid) => {
        const row = rows[bid.id];
        return (
          <li key={bid.id} className={styles.bidRow}>
            <span>
              {formatInteger(Number(bid.notes))} notes at up to {formatCents(bid.maxPriceCents)} —{" "}
              <a href={txUrl(chainId, bid.hash)} target="_blank" rel="noreferrer">
                bid tx
              </a>
            </span>
            {live ? (
              <span className={styles.explain}>Exit and claim open once the auction ends.</span>
            ) : (
              <span className={styles.bidActions}>
                {row?.exitHash ? (
                  <a href={txUrl(chainId, row.exitHash)} target="_blank" rel="noreferrer">
                    exited
                  </a>
                ) : (
                  <button type="button" className={styles.smallButton} disabled={row?.pending === "exit"} onClick={() => run(bid, "exit")}>
                    {row?.pending === "exit" ? "Exiting…" : "Exit"}
                  </button>
                )}
                {row?.claimHash ? (
                  <a href={txUrl(chainId, row.claimHash)} target="_blank" rel="noreferrer">
                    claimed
                  </a>
                ) : (
                  <button type="button" className={styles.smallButton} disabled={row?.pending === "claim"} onClick={() => run(bid, "claim")}>
                    {row?.pending === "claim" ? "Claiming…" : "Claim"}
                  </button>
                )}
              </span>
            )}
            {row?.error ? (
              <p className={styles.error} role="alert">
                {row.error}
              </p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
