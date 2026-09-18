import type { Metadata } from "next";
import { BackCover } from "@/components/editorial/BackCover";
import { Masthead } from "@/components/editorial/Masthead";
import { LoanDetail } from "@/components/loans/LoanDetail";
import { InvalidLoanId, LoanError, LoanNotFound } from "@/components/loans/LoanEmptyStates";
import { clearingPriceCents } from "@/lib/auctions";
import { getAuction, getLatestBlock, getLoan, getLoanActivity } from "@/lib/data";
import { loadWebEnv } from "@/lib/env";
import {
  cardReceiptsFromEvents,
  drawMeterFromLoan,
  harvestEntriesFromEvents,
  noteTermsFromLoan,
  statusHistoryFromEvents,
  sweepsUsdFromHarvests,
} from "@/lib/loanDetail";
import { FOOTER, NAV } from "@/lib/nav";
import { groupRefusalsByLayer } from "@/lib/refusals";

interface PageProps {
  params: Promise<{ loanId: string }>;
}

const LOAN_ID_PATTERN = /^\d+$/;

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { loanId } = await params;
  return { title: `Loan #${loanId} — Advance` };
}

export default async function LoanDetailPage({ params }: PageProps) {
  const { loanId: rawLoanId } = await params;
  const body = LOAN_ID_PATTERN.test(rawLoanId) ? await renderLoan(BigInt(rawLoanId), rawLoanId) : <InvalidLoanId loanId={rawLoanId} />;

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <Masthead links={NAV} />
      <main id="main">{body}</main>
      <BackCover
        pitch="Paste any Bankr token. Get a score and a memo."
        action={{ label: "Underwrite an agent", href: "/underwrite", prefetch: false }}
        columns={FOOTER}
        imprint="Advance. Built for Runtime Agent Week on Base."
        page={73}
      />
    </>
  );
}

async function renderLoan(loanId: bigint, rawLoanId: string) {
  try {
    const loan = await getLoan(loanId);
    if (!loan) return <LoanNotFound loanId={rawLoanId} />;

    const [auction, activity, latestBlock] = await Promise.all([getAuction(loanId), getLoanActivity(loanId), getLatestBlock()]);
    const webEnv = loadWebEnv();

    const harvests = harvestEntriesFromEvents(loan, activity.events);
    const clearingCents = auction ? clearingPriceCents(auction) : loan.termSheet.floorCents;

    const noteTerms = noteTermsFromLoan(loan, {
      clearingPriceCents: clearingCents,
      sweepsUsd: sweepsUsdFromHarvests(harvests),
      latestBlock: Number(latestBlock),
    });

    const agentEvents = activity.events.filter((e) => e.source === "agent");
    const drawMeter = drawMeterFromLoan(loan);
    const receipts = cardReceiptsFromEvents(agentEvents);
    const refusalsByLayer = groupRefusalsByLayer(agentEvents);
    const statusHistory = statusHistoryFromEvents(loan, activity.events);

    return (
      <LoanDetail
        loan={loan}
        chainId={webEnv.chainId}
        noteTerms={noteTerms}
        drawMeter={drawMeter}
        harvests={harvests}
        receipts={receipts}
        refusalsByLayer={refusalsByLayer}
        statusHistory={statusHistory}
      />
    );
  } catch {
    return <LoanError loanId={rawLoanId} />;
  }
}
