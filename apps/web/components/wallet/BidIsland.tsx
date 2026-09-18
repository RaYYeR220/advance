"use client";

import { useState } from "react";
import type { Address } from "viem";
import type { SupportedChainId } from "@/lib/env";
import { BidForm, type SubmittedBid } from "./BidForm";
import { BidLadder } from "./BidLadder";
import { DisabledBidForm } from "./DisabledBidForm";
import { DynamicProvider } from "./DynamicProvider";
import styles from "./BidPanel.module.css";

export interface BidIslandProps {
  environmentId?: string;
  loanId: bigint;
  hub: Address;
  auction: Address;
  chainId: SupportedChainId;
  floorCents: number;
  live: boolean;
}

/** The whole client-side bidding widget: the bid form plus this session's bid ladder, wrapped
 * in Dynamic's wallet context. With no environment id configured, renders a disabled form and
 * an explanation instead — never a crash, and never a Dynamic provider mounted with an empty
 * id. */
export function BidIsland({ environmentId, loanId, hub, auction, chainId, floorCents, live }: BidIslandProps) {
  const [bids, setBids] = useState<SubmittedBid[]>([]);

  if (!environmentId) {
    return (
      <section className={styles.panel} aria-labelledby="bid-title">
        <h2 className={styles.panelTitle} id="bid-title">
          Bid on this auction
        </h2>
        <DisabledBidForm floorCents={floorCents} live={live} />
      </section>
    );
  }

  return (
    <DynamicProvider environmentId={environmentId}>
      <section className={styles.panel} aria-labelledby="bid-title">
        <h2 className={styles.panelTitle} id="bid-title">
          Bid on this auction
        </h2>
        <BidForm
          loanId={loanId}
          hub={hub}
          chainId={chainId}
          floorCents={floorCents}
          live={live}
          onBidSubmitted={(bid) => setBids((prev) => [bid, ...prev])}
        />
        <h3 className={styles.panelTitle}>Your bids this session</h3>
        <BidLadder bids={bids} auction={auction} chainId={chainId} live={live} />
      </section>
    </DynamicProvider>
  );
}
