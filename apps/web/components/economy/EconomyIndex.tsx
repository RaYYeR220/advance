import { RunningHead } from "@/components/editorial/Folio";
import type { EconomyView } from "@/lib/data";
import { agentCardData, sortAgentCards } from "@/lib/economy";
import type { JsonEventLike } from "@/lib/ticker";
import { AgentCard } from "./AgentCard";
import { EventTicker } from "./EventTicker";
import styles from "./EconomyIndex.module.css";

export interface EconomyIndexProps {
  economy: EconomyView;
  recentEvents: readonly JsonEventLike[];
}

/** `/economy`: every funded agent as a halftone portrait card with its runway meter, 7-day
 * revenue, loan status and last action, plus a live event ticker. An honest "nothing funded
 * yet" when the hub has never opened a loan — never a grid of fabricated agents. */
export function EconomyIndex({ economy, recentEvents }: EconomyIndexProps) {
  const cards = sortAgentCards(economy.agents.map(agentCardData));

  return (
    <section className={styles.page}>
      <header>
        <RunningHead page={80} title="Economy" />
        <p className={styles.eyebrow}>Every agent, live</p>
        <h1 className={styles.title}>The whole book, agent by agent</h1>
        <p className={styles.deck}>
          Every agent the hub has ever funded, read straight off its own loan: runway against its grace period,
          seven-day revenue from real sweeps, and its last recorded action.
        </p>
      </header>

      {cards.length === 0 ? (
        <p className={styles.empty}>
          Advance hasn&apos;t funded its first agent yet. Once a loan opens, its portrait, runway and revenue print
          right here.
        </p>
      ) : (
        <ul className={styles.grid}>
          {cards.map((card) => (
            <li key={card.loanId.toString()}>
              <AgentCard card={card} />
            </li>
          ))}
        </ul>
      )}

      <div className={styles.tickerSection} aria-labelledby="ticker-title">
        <h2 className={styles.sectionTitle} id="ticker-title">
          Live activity
        </h2>
        <p className={styles.sectionIntro}>
          Draws, sweeps, repayments, claims and refusals, across every agent, as they&apos;re recorded — refreshed
          automatically.
        </p>
        <EventTicker initialEvents={recentEvents} />
      </div>
    </section>
  );
}
