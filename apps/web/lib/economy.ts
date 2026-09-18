import type { LoanStatus } from "@advance/sdk";
import type { EconomyAgent } from "./data";
import { formatDuration, microUsdToUsd } from "./format";

/**
 * Pure `/economy` maths and shaping — one row per funded agent, ready for the halftone card
 * grid. Every function takes an already-fetched `EconomyAgent` (see `data.ts`'s `getEconomy`),
 * no I/O, so it's exercised directly with fixtures in tests.
 */

export interface RunwayData {
  /** `runwaySeconds / gracePeriodSeconds`, clamped to `[0, 1]`. */
  ratio: number;
  label: string;
}

/** The runway meter for one agent: `null` when the loan isn't `Active` (grace-period tracking
 * doesn't apply to any other status) or its grace period is zero (nothing to divide by). */
export function runwayData(agent: Pick<EconomyAgent, "runwaySeconds" | "gracePeriodSeconds">): RunwayData | null {
  if (agent.runwaySeconds === null || agent.gracePeriodSeconds <= 0n) return null;
  const ratio = Math.min(1, Math.max(0, Number(agent.runwaySeconds) / Number(agent.gracePeriodSeconds)));
  return { ratio, label: formatDuration(Number(agent.runwaySeconds)) };
}

/** Plain-language labels for the event types `EconomyAgent.lastEventType` can carry — the same
 * on-chain/off-chain vocabulary `loanDetail.ts`'s `LIFECYCLE_LABELS` and `RefusalExhibits` use,
 * gathered here since `/economy`'s card needs one line covering every type, not just the
 * lifecycle subset. */
const EVENT_TYPE_LABELS: Record<string, string> = {
  LoanOpened: "Auction opened",
  LoanActivated: "Loan activated",
  LoanRepaid: "Cap repaid",
  LoanDefaulted: "Marked in default",
  LoanFailed: "Auction failed",
  Drawn: "Card draw",
  Harvested: "Escrow harvest",
  Distributed: "Repayment distributed",
  Claimed: "Lender claim",
  CardTransfer: "Card transfer",
  receipt: "Card payment",
  refusal: "Payment refused",
  settlement_failed: "Settlement failed",
};

/** A plain label for the agent's last recorded action — the event's own type string, humanized
 * where a label is known, verbatim otherwise (never hidden: an unrecognized type is still real
 * activity worth showing). `null` when nothing has ever been recorded for this loan. */
export function lastActionLabel(type: string | null): string | null {
  if (type === null) return null;
  return EVENT_TYPE_LABELS[type] ?? type;
}

export interface AgentCardData {
  agentTreasury: EconomyAgent["agentTreasury"];
  loanId: bigint;
  status: LoanStatus;
  capUsd: number;
  repaidUsd: number;
  drawnUsd: number;
  availableUsd: number;
  revenue7dUsd: number;
  runway: RunwayData | null;
  lastAction: { label: string; timestamp: number } | null;
}

/** One agent's `EconomyAgent` shaped into display-ready USD figures and labels. */
export function agentCardData(agent: EconomyAgent): AgentCardData {
  const label = lastActionLabel(agent.lastEventType);
  return {
    agentTreasury: agent.agentTreasury,
    loanId: agent.loanId,
    status: agent.status,
    capUsd: microUsdToUsd(agent.cap),
    repaidUsd: microUsdToUsd(agent.repaid),
    drawnUsd: microUsdToUsd(agent.drawn),
    availableUsd: microUsdToUsd(agent.available),
    revenue7dUsd: microUsdToUsd(agent.revenue7dUsdc),
    runway: runwayData(agent),
    lastAction: label && agent.lastEventAt !== null ? { label, timestamp: agent.lastEventAt } : null,
  };
}

/** Active loans first, most urgent (least runway) first; then every other status, most
 * recently active first. The ordering a reader actually wants: agents closest to default
 * lead the page. */
export function sortAgentCards(agents: readonly AgentCardData[]): AgentCardData[] {
  const active = agents
    .filter((a) => a.status === "Active")
    .sort((a, b) => (a.runway?.ratio ?? 1) - (b.runway?.ratio ?? 1));
  const rest = agents
    .filter((a) => a.status !== "Active")
    .sort((a, b) => (b.lastAction?.timestamp ?? 0) - (a.lastAction?.timestamp ?? 0));
  return [...active, ...rest];
}
