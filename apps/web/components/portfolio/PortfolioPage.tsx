import type { LoanView } from "@advance/sdk";
import { RunningHead } from "@/components/editorial/Folio";
import { PortfolioIsland } from "@/components/wallet/PortfolioIsland";
import type { SupportedChainId } from "@/lib/env";
import styles from "./PortfolioPage.module.css";

export interface PortfolioPageProps {
  loans: readonly LoanView[];
  chainId: SupportedChainId;
  dynamicEnvironmentId?: string;
}

/** `/portfolio`: the connected lender's own notes per loan, claimable USDC, a claim action, and
 * its repayment history — the Dynamic wallet flow, same pattern as the auction bid form. */
export function PortfolioPage({ loans, chainId, dynamicEnvironmentId }: PortfolioPageProps) {
  return (
    <section className={styles.page}>
      <header>
        <RunningHead page={86} title="Portfolio" />
        <p className={styles.eyebrow}>Your lending book</p>
        <h1 className={styles.title}>What your wallet holds, and what it&apos;s owed</h1>
        <p className={styles.deck}>
          Connect the wallet you bid with. Every note it holds, what&apos;s claimable right now, and every repayment
          it has already claimed — read straight off each loan&apos;s own revenue note.
        </p>
      </header>
      <div className={styles.body}>
        <PortfolioIsland loans={loans} chainId={chainId} environmentId={dynamicEnvironmentId} />
      </div>
    </section>
  );
}
