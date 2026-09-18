import type { Metadata } from "next";
import type { LoanView } from "@advance/sdk";
import { BackCover } from "@/components/editorial/BackCover";
import { Masthead } from "@/components/editorial/Masthead";
import { PortfolioPage } from "@/components/portfolio/PortfolioPage";
import { getLoans } from "@/lib/data";
import { loadWebEnv, type SupportedChainId } from "@/lib/env";
import { FOOTER, NAV } from "@/lib/nav";

export const metadata: Metadata = {
  title: "Portfolio — Advance",
  description: "The connected lender's notes per loan, claimable USDC and repayment history.",
};

// Claimable balances change block to block — this page always reads fresh, never a build-time
// snapshot.
export const dynamic = "force-dynamic";

/** Never lets a missing deployment or a transient read crash the page — the connected-wallet
 * panel still renders (and explains itself) even with an empty loan list. */
async function getLoansSafe(): Promise<LoanView[]> {
  try {
    return await getLoans();
  } catch {
    return [];
  }
}

export default async function PortfolioIndexPage() {
  const loans = await getLoansSafe();
  const chainId = safeChainId();

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <Masthead links={NAV} current="/portfolio" />
      <main id="main">
        <PortfolioPage loans={loans} chainId={chainId} dynamicEnvironmentId={process.env.NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID} />
      </main>
      <BackCover
        pitch="Paste any Bankr token. Get a score and a memo."
        action={{ label: "Underwrite an agent", href: "/underwrite", prefetch: false }}
        columns={FOOTER}
        imprint="Advance. Built for Runtime Agent Week on Base."
        page={88}
      />
    </>
  );
}

/** `loadWebEnv`'s own chain-id default, without requiring `ADVANCE_HUB`/`UNDERWRITER_API_URL`
 * to be set — the connected-wallet panel below still needs a chain to build its own viem client
 * against even when the server-side deployment config is incomplete. */
function safeChainId(): SupportedChainId {
  try {
    return loadWebEnv().chainId;
  } catch {
    return Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? "84532") === 8453 ? 8453 : 84532;
  }
}
