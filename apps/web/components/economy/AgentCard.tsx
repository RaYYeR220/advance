import Link from "next/link";
import type { LoanStatus } from "@advance/sdk";
import { HalftonePortrait } from "@/components/halftone/HalftonePortrait";
import { INSET_FRAMING } from "@/components/halftone/portrait";
import type { AgentCardData } from "@/lib/economy";
import { formatUsd, shortAddress } from "@/lib/format";
import { RunwayMeter } from "./RunwayMeter";
import styles from "./EconomyIndex.module.css";

export interface AgentCardProps {
  card: AgentCardData;
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

/** One agent's halftone portrait, runway meter, 7-day revenue, loan status and last action,
 * linking through to its loan's own record. */
export function AgentCard({ card }: AgentCardProps) {
  const label = shortAddress(card.agentTreasury);
  return (
    <Link href={`/loans/${card.loanId}`} className={styles.card}>
      <div className={styles.portraitFrame}>
        <HalftonePortrait seed={card.agentTreasury} framing={INSET_FRAMING} label={`Agent ${label}`} />
      </div>
      <div className={styles.cardBody}>
        <div className={styles.cardHead}>
          <span className={styles.cardAgent}>{label}</span>
          <span className={styles.cardStatus} data-status={card.status}>
            {STATUS_COPY[card.status]}
          </span>
        </div>
        {card.runway ? (
          <RunwayMeter runway={card.runway} />
        ) : (
          <p className={styles.cardNote}>Runway applies to active loans only.</p>
        )}
        <dl className={styles.cardStats}>
          <div>
            <dt>7-day revenue</dt>
            <dd>{formatUsd(card.revenue7dUsd, { cents: true })}</dd>
          </div>
          <div>
            <dt>Repaid of cap</dt>
            <dd>
              {formatUsd(card.repaidUsd)} / {formatUsd(card.capUsd)}
            </dd>
          </div>
        </dl>
        <p className={styles.cardAction}>{card.lastAction ? card.lastAction.label : "No activity recorded yet."}</p>
      </div>
    </Link>
  );
}
