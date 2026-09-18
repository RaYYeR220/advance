import Link from "next/link";
import type { Erc8004FeedbackView, LoanStatus, LoanView } from "@advance/sdk";
import { RunningHead } from "@/components/editorial/Folio";
import { Certificate } from "@/components/note/Certificate";
import type { NoteTerms } from "@/lib/landing-data";
import type { CardReceipt, DrawMeterData, HarvestEntry, StatusHistoryEntry } from "@/lib/loanDetail";
import type { RefusalsByLayer } from "@/lib/refusals";
import type { SupportedChainId } from "@/lib/env";
import { CardSpendFeed } from "./CardSpendFeed";
import { DrawMeter } from "./DrawMeter";
import { Erc8004Feedback } from "./Erc8004Feedback";
import { HarvestTimeline } from "./HarvestTimeline";
import { RefusalExhibits } from "./RefusalExhibits";
import { StatusHistory } from "./StatusHistory";
import styles from "./LoanDetail.module.css";

export interface LoanDetailProps {
  loan: LoanView;
  chainId: SupportedChainId;
  noteTerms: NoteTerms;
  drawMeter: DrawMeterData;
  harvests: readonly HarvestEntry[];
  receipts: readonly CardReceipt[];
  refusalsByLayer: RefusalsByLayer;
  statusHistory: readonly StatusHistoryEntry[];
  feedback: Erc8004FeedbackView | null;
}

const STATUS_COPY: Record<LoanStatus, string> = {
  None: "None",
  Auction: "In auction",
  Active: "Active",
  Repaid: "Repaid",
  Defaulted: "Defaulted",
  Failed: "Auction failed",
  Aborted: "Aborted",
};

/** `/loans/[loanId]`: the revenue-note certificate, the escrow harvest timeline, the draw
 * meter, the card spend feed, every refusal by layer, ERC-8004 feedback and status history —
 * the whole enforcement record for one loan, in one place. */
export function LoanDetail({ loan, chainId, noteTerms, drawMeter, harvests, receipts, refusalsByLayer, statusHistory, feedback }: LoanDetailProps) {
  return (
    <section className={styles.page}>
      <header>
        <RunningHead page={72} title="Loans" />
        <p className={styles.eyebrow}>Revenue-backed credit</p>
        <div className={styles.titleRow}>
          <h1 className={styles.title}>Loan #{loan.loanId.toString()}</h1>
          <span className={styles.status}>{STATUS_COPY[loan.status]}</span>
        </div>
        <p className={styles.deck}>
          Every fact below is read straight off the loan&apos;s own contracts and its recorded activity — the escrow
          that holds its fee rights, the credit line that gates its card, and the enforcement that has actually fired.
        </p>
        <p className={styles.link}>
          <Link href={`/auctions/${loan.loanId}`}>The auction that priced this loan&apos;s notes →</Link>
        </p>
      </header>

      <div className={styles.certificate}>
        <Certificate {...noteTerms} />
      </div>

      <section className={styles.section} aria-labelledby="draw-title">
        <h2 className={styles.sectionTitle} id="draw-title">
          Draw meter
        </h2>
        <p className={styles.sectionIntro}>Drawn against the credit line&apos;s own per-period limit, on-chain.</p>
        <DrawMeter meter={drawMeter} />
      </section>

      <section className={styles.section} aria-labelledby="harvests-title">
        <h2 className={styles.sectionTitle} id="harvests-title">
          Escrow harvests
        </h2>
        <p className={styles.sectionIntro}>Every sweep of real fee revenue into the escrow, with the USDC it distributed.</p>
        <HarvestTimeline harvests={harvests} chainId={chainId} />
      </section>

      <section className={styles.section} aria-labelledby="spend-title">
        <h2 className={styles.sectionTitle} id="spend-title">
          Card spend
        </h2>
        <p className={styles.sectionIntro}>x402 receipts the card has settled: payee, amount, transaction.</p>
        <CardSpendFeed receipts={receipts} chainId={chainId} />
      </section>

      <section className={styles.section} aria-labelledby="refusals-title">
        <h2 className={styles.sectionTitle} id="refusals-title">
          Refusal exhibits
        </h2>
        <p className={styles.sectionIntro}>
          Every attempt this loan&apos;s enforcement stopped, grouped by the layer that stopped it.
        </p>
        <RefusalExhibits grouped={refusalsByLayer} chainId={chainId} />
      </section>

      <section className={styles.section} aria-labelledby="feedback-title">
        <h2 className={styles.sectionTitle} id="feedback-title">
          ERC-8004 feedback
        </h2>
        <Erc8004Feedback feedback={feedback} chainId={chainId} />
      </section>

      <section className={styles.section} aria-labelledby="history-title">
        <h2 className={styles.sectionTitle} id="history-title">
          Status history
        </h2>
        <StatusHistory history={statusHistory} chainId={chainId} />
      </section>
    </section>
  );
}
