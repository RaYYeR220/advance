import Link from "next/link";
import type { AuctionView, LoanView } from "@advance/sdk";
import { RunningHead } from "@/components/editorial/Folio";
import { ClearingPriceSteps } from "@/components/charts/ClearingPriceSteps";
import { BidIsland } from "@/components/wallet/BidIsland";
import { auctionChartData } from "@/lib/auctions";
import { formatBlock, formatUsd, microUsdToUsd } from "@/lib/format";
import type { SupportedChainId } from "@/lib/env";
import { GraduationBadge } from "./GraduationBadge";
import styles from "./AuctionDetail.module.css";

export interface AuctionDetailProps {
  loan: LoanView;
  auction: AuctionView;
  chainId: SupportedChainId;
  hub: `0x${string}`;
  dynamicEnvironmentId?: string;
}

/** `/auctions/[loanId]`: the stepped clearing-price chart, the raise, graduation state and the
 * bid form. */
export function AuctionDetail({ loan, auction, chainId, hub, dynamicEnvironmentId }: AuctionDetailProps) {
  const live = auction.blocksLeft > 0n;
  const chart = auctionChartData(loan, auction);
  const requiredUsd = microUsdToUsd(auction.requiredCurrencyRaised);
  const raisedUsd = live ? microUsdToUsd(auction.raisedSoFar) : microUsdToUsd(loan.principal);

  return (
    <section className={styles.page}>
      <header>
        <RunningHead page={68} title="Auctions" />
        <p className={styles.eyebrow}>Continuous clearing auction</p>
        <div className={styles.titleRow}>
          <h1 className={styles.title}>Auction #{loan.loanId.toString()}</h1>
          <GraduationBadge live={live} graduated={auction.graduated} />
        </div>
        <p className={styles.deck}>
          Priced by a continuous clearing auction: the price climbs a block at a time as bids fill, until it either
          raises what the term sheet requires or the auction ends without doing so.
        </p>
        <p className={styles.link}>
          <Link href={`/loans/${loan.loanId}`}>The loan this auction funds →</Link>
        </p>
      </header>

      <dl className={styles.stats}>
        <div className={styles.stat}>
          <dt>Clearing price</dt>
          <dd>{formatUsd(chart.clearingPriceCents / 100, { cents: true })}</dd>
        </div>
        <div className={styles.stat}>
          <dt>Raised</dt>
          <dd>
            {formatUsd(raisedUsd)} of {formatUsd(requiredUsd)}
          </dd>
        </div>
        <div className={styles.stat}>
          <dt>{live ? "Blocks left" : "Ended at block"}</dt>
          <dd>{live ? formatBlock(auction.blocksLeft) : formatBlock(auction.endBlock)}</dd>
        </div>
        <div className={styles.stat}>
          <dt>Floor</dt>
          <dd>{formatUsd(chart.floorCents / 100, { cents: true })}</dd>
        </div>
      </dl>

      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Clearing price</h2>
        <ClearingPriceSteps
          startBlock={chart.startBlock}
          blocks={chart.blocks}
          floorCents={chart.floorCents}
          steps={chart.steps}
          elapsedBlocks={chart.elapsedBlocks}
          live={live}
          caption={
            chart.elapsedBlocks > 0
              ? "Only the floor and the auction's current checkpoint are ever readable off-chain — the CCA contract exposes no per-block bid history, so this is the exact schedule available, not a smoothed curve."
              : "No block has elapsed yet — the auction is still at its floor."
          }
        />
      </div>

      <BidIsland
        environmentId={dynamicEnvironmentId}
        loanId={loan.loanId}
        hub={hub}
        auction={loan.auction}
        chainId={chainId}
        floorCents={chart.floorCents}
        live={live}
      />
    </section>
  );
}
