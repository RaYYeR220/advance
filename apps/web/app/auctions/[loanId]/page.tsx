import type { Metadata } from "next";
import { BackCover } from "@/components/editorial/BackCover";
import { Masthead } from "@/components/editorial/Masthead";
import { AuctionDetail } from "@/components/auctions/AuctionDetail";
import { AuctionError, AuctionNotFound, InvalidLoanId } from "@/components/auctions/AuctionEmptyStates";
import { getAuction, getLoan } from "@/lib/data";
import { loadWebEnv } from "@/lib/env";
import { FOOTER, NAV } from "@/lib/nav";

interface PageProps {
  params: Promise<{ loanId: string }>;
}

const LOAN_ID_PATTERN = /^\d+$/;

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { loanId } = await params;
  return { title: `Auction #${loanId} — Advance` };
}

export default async function AuctionDetailPage({ params }: PageProps) {
  const { loanId: rawLoanId } = await params;
  const body = LOAN_ID_PATTERN.test(rawLoanId) ? await renderAuction(BigInt(rawLoanId), rawLoanId) : <InvalidLoanId loanId={rawLoanId} />;

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
        page={69}
      />
    </>
  );
}

async function renderAuction(loanId: bigint, rawLoanId: string) {
  try {
    const [loan, auction] = await Promise.all([getLoan(loanId), getAuction(loanId)]);
    if (!loan || !auction) return <AuctionNotFound loanId={rawLoanId} />;

    const webEnv = loadWebEnv();
    return (
      <AuctionDetail
        loan={loan}
        auction={auction}
        chainId={webEnv.chainId}
        hub={webEnv.hub}
        dynamicEnvironmentId={process.env.NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID}
      />
    );
  } catch {
    return <AuctionError loanId={rawLoanId} />;
  }
}
