import { q96ToCents, TICK_SPACING_Q96, type AuctionView, type LoanView } from "@advance/sdk";
import type { AuctionStep } from "./landing-data";

/**
 * Pure auction-list/detail maths shared by `/auctions` and `/auctions/[loanId]`. Every
 * function here takes plain `LoanView`/`AuctionView` reads (or numbers derived from them) —
 * no chain I/O — so it's exercised directly with fixtures in tests.
 */

export interface AuctionListItem {
  loan: LoanView;
  auction: AuctionView;
}

/** `AuctionView.clearingPriceQ96` isn't guaranteed to land exactly on a tick boundary between
 * checkpoints; rounds down to the nearest tick so `q96ToCents` never throws on a live read.
 * Mirrors `data.ts`'s own `roundToTick` (kept local here rather than shared, since it's a
 * one-line, side-effect-free conversion). */
function roundToTick(priceQ96: bigint): bigint {
  return (priceQ96 / TICK_SPACING_Q96) * TICK_SPACING_Q96;
}

/** The auction's current clearing price, in whole cents. */
export function clearingPriceCents(auction: AuctionView): number {
  return q96ToCents(roundToTick(auction.clearingPriceQ96));
}

/** An auction is "live" while it still has blocks left to run — regardless of whether it has
 * already crossed the graduation threshold, since a CCA keeps accepting bids until its end
 * block. */
export function isLiveAuction(item: AuctionListItem): boolean {
  return item.auction.blocksLeft > 0n;
}

/** Live auctions first (soonest-ending first), then ended ones, most recently opened first —
 * the order `/auctions` lists them in. */
export function sortAuctionListItems(items: readonly AuctionListItem[]): AuctionListItem[] {
  const live = items.filter(isLiveAuction).sort((a, b) => (a.auction.blocksLeft < b.auction.blocksLeft ? -1 : a.auction.blocksLeft > b.auction.blocksLeft ? 1 : 0));
  const ended = items
    .filter((item) => !isLiveAuction(item))
    .sort((a, b) => (a.loan.openedAt > b.loan.openedAt ? -1 : a.loan.openedAt < b.loan.openedAt ? 1 : 0));
  return [...live, ...ended];
}

export interface AuctionChartData {
  startBlock: number;
  blocks: number;
  floorCents: number;
  /** The clearing-price schedule as far as it's observable: the term sheet's floor at block 0,
   * and (once at least one block has elapsed) the auction's current observed clearing price at
   * its current elapsed block. A CCA's full per-block schedule isn't exposed by any chain read
   * this app has — this is the same honest two-point read `getLandingData` uses, not an
   * invented full curve. */
  steps: AuctionStep[];
  elapsedBlocks: number;
  clearingPriceCents: number;
}

/** Builds the chart data for one loan's auction. `auction.blocksLeft` already bakes in "as of
 * the latest block" (see `AuctionView`'s own doc), so this needs no separate block-number
 * read of its own. */
export function auctionChartData(loan: LoanView, auction: AuctionView): AuctionChartData {
  const blocks = Number(loan.termSheet.auctionBlocks);
  const startBlock = Number(auction.endBlock - loan.termSheet.auctionBlocks);
  const elapsedRaw = blocks - Number(auction.blocksLeft);
  const elapsedBlocks = Math.max(0, Math.min(blocks, elapsedRaw));
  const floorCents = loan.termSheet.floorCents;
  const clearing = clearingPriceCents(auction);

  const steps: AuctionStep[] =
    elapsedBlocks > 0 ? [{ fromBlock: 0, priceCents: floorCents }, { fromBlock: elapsedBlocks, priceCents: clearing }] : [{ fromBlock: 0, priceCents: floorCents }];

  return { startBlock, blocks, floorCents, steps, elapsedBlocks, clearingPriceCents: clearing };
}
