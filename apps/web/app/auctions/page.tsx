import type { Metadata } from "next";
import { BackCover } from "@/components/editorial/BackCover";
import { Masthead } from "@/components/editorial/Masthead";
import { AuctionsIndex } from "@/components/auctions/AuctionsIndex";
import { getAuctions } from "@/lib/data";
import type { AuctionListItem } from "@/lib/auctions";
import { FOOTER, NAV } from "@/lib/nav";

export const metadata: Metadata = {
  title: "Auctions — Advance",
  description: "Every loan's continuous clearing auction: clearing price, raised vs. required, blocks left.",
};

// Live auction state (clearing price, blocks left, graduation) changes block to block — this
// page always reads fresh, never a build-time snapshot.
export const dynamic = "force-dynamic";

/** Never lets a missing deployment or a transient read crash the page — the same honest empty
 * state (`No loan has opened an auction yet`) a fresh, unconfigured deployment would show for
 * real. */
async function getAuctionsSafe(): Promise<AuctionListItem[]> {
  try {
    return await getAuctions();
  } catch {
    return [];
  }
}

export default async function AuctionsPage() {
  const items = await getAuctionsSafe();
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <Masthead links={NAV} />
      <main id="main">
        <AuctionsIndex items={items} />
      </main>
      <BackCover
        pitch="Paste any Bankr token. Get a score and a memo."
        action={{ label: "Underwrite an agent", href: "/underwrite", prefetch: false }}
        columns={FOOTER}
        imprint="Advance. Built for Runtime Agent Week on Base."
        page={67}
      />
    </>
  );
}
