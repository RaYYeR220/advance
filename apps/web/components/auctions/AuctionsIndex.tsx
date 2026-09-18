import Link from "next/link";
import { RunningHead } from "@/components/editorial/Folio";
import { clearingPriceCents, isLiveAuction, sortAuctionListItems, type AuctionListItem } from "@/lib/auctions";
import { formatBlock, formatUsd, microUsdToUsd } from "@/lib/format";
import { GraduationBadge } from "./GraduationBadge";
import styles from "./AuctionsIndex.module.css";

export interface AuctionsIndexProps {
  items: readonly AuctionListItem[];
}

/** `/auctions`: every loan's CCA, live ones first (soonest-ending first), then ended ones,
 * newest-opened first. An empty hub prints an honest "no auctions yet" line, never a table of
 * zeros. */
export function AuctionsIndex({ items }: AuctionsIndexProps) {
  const sorted = sortAuctionListItems(items);
  const live = sorted.filter(isLiveAuction);
  const ended = sorted.filter((item) => !isLiveAuction(item));

  return (
    <section className={styles.page}>
      <header>
        <RunningHead page={66} title="Auctions" />
        <p className={styles.eyebrow}>Continuous clearing auctions</p>
        <h1 className={styles.title}>Every note, priced by the market</h1>
        <p className={styles.deck}>
          Each loan&apos;s notes sell through a continuous clearing auction: the price climbs a block at a time until
          it either raises what the term sheet requires, or the auction ends without it.
        </p>
      </header>

      {sorted.length === 0 ? (
        <p className={styles.empty}>
          No loan has opened an auction yet. The first one to apply and get a signed term sheet shows up right here.
        </p>
      ) : (
        <>
          {live.length > 0 ? (
            <div className={styles.group}>
              <h2 className={styles.groupTitle}>Live ({live.length})</h2>
              <AuctionRows items={live} />
            </div>
          ) : (
            <p className={styles.empty}>No auction is live right now. Recently ended ones are below.</p>
          )}

          {ended.length > 0 ? (
            <div className={styles.group}>
              <h2 className={styles.groupTitle}>Recent ({ended.length})</h2>
              <AuctionRows items={ended} />
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

function AuctionRows({ items }: { items: readonly AuctionListItem[] }) {
  return (
    <ul className={styles.list}>
      {items.map(({ loan, auction }) => {
        const live = auction.blocksLeft > 0n;
        const requiredUsd = microUsdToUsd(auction.requiredCurrencyRaised);
        const raisedUsd = live ? microUsdToUsd(auction.raisedSoFar) : microUsdToUsd(loan.principal);
        return (
          <li key={loan.loanId.toString()}>
            <Link className={styles.row} href={`/auctions/${loan.loanId}`}>
              <div className={styles.rowHead}>
                <span className={styles.rowTitle}>Auction #{loan.loanId.toString()}</span>
                <GraduationBadge live={live} graduated={auction.graduated} />
              </div>
              <dl className={styles.stats}>
                <div className={styles.stat}>
                  <dt>Clearing price</dt>
                  <dd>{formatUsd(clearingPriceCents(auction) / 100, { cents: true })}</dd>
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
              </dl>
              <p className={styles.rowFoot}>Funds loan #{loan.loanId.toString()}, agent {loan.termSheet.agentTreasury.slice(0, 6)}…</p>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
