import { zeroAddress } from "viem";
import { ButtonLink, TextLink } from "@/components/editorial/Action";
import { PageFoot } from "@/components/editorial/Folio";
import { describeLikeness, likenessFromSeed } from "@/components/halftone/portrait";
import { Certificate } from "@/components/note/Certificate";
import { cx } from "@/lib/cx";
import { formatUsd } from "@/lib/format";
import type { LandingData } from "@/lib/landing-data";
import { HeroFigure, type HeroCallout } from "./HeroFigure";
import styles from "./HeroSpread.module.css";

export interface HeroSpreadProps {
  hero: LandingData["hero"];
  issueDate: string;
}

/** Opening spread: headline and deck on the left page, the agent's likeness on the right, the note across the gutter.
 * No loan has opened yet — `hero.agent` is the zero address — prints a placeholder page instead
 * of a portrait and callouts seeded from an agent that doesn't exist. */
export function HeroSpread({ hero, issueDate }: HeroSpreadProps) {
  const { note } = hero;
  const funded = hero.agent.toLowerCase() !== zeroAddress;

  if (!funded) {
    return (
      <section className={cx("spread", styles.hero)} aria-labelledby="hero-title">
        <div className="gutter" aria-hidden="true" />
        <div className="pg pg-l">
          <h1 id="hero-title" className={styles.title}>
            <span className={styles.line}>Credit for</span>{" "}
            <span className={cx(styles.line, styles.indent)}>agents that</span>{" "}
            <span className={styles.line}>earn.</span>
          </h1>
          <div className={styles.deck} id="underwrite">
            <p className={styles.sub}>
              Advance lends to AI agents against the trading fees their tokens already earn. The loan is sold as a
              note on Uniswap and repaid from the fee stream by contract. When a hijacked agent tries to drain its
              credit, the chain says no.
            </p>
            <div className={styles.actions}>
              <ButtonLink href="/underwrite" prefetch={false}>Underwrite an agent</ButtonLink>
              <TextLink href="#how">How a loan works</TextLink>
            </div>
          </div>
          <PageFoot page={36} publication="Advance" date={issueDate} className={styles.foot} />
        </div>

        <div className="pg pg-r">
          <div className={styles.empty}>
            <p className={styles.emptyKicker}>No loan open yet</p>
            <p className={styles.emptyBody}>
              The first agent to draw credit against its own fees gets its portrait and reputation record printed
              right here — read live from the chain, never from what it claims about itself.
            </p>
          </div>
        </div>

        <div className={styles.notePlacement}>
          <Certificate {...note} />
        </div>
      </section>
    );
  }

  const callouts: HeroCallout[] = [
    {
      title: "Reputation",
      body: `ERC-8004 record: ${hero.loansRepaid} loans repaid, ${hero.defaults} defaults.`,
      anchor: "antenna",
      labelAt: { x: 0.64, y: 0.05 },
    },
    {
      title: "Underwriting",
      body: "Fees read from Base archive nodes, never reported by the agent.",
      anchor: "eye",
      labelAt: { x: 0.03, y: 0.33 },
    },
    {
      title: "Collateral",
      body: `${formatUsd(hero.weeklyFeesUsd)} a week in token fees, escrowed until the cap is repaid.`,
      anchor: "badge",
      labelAt: { x: 0.57, y: 0.735 },
    },
  ];

  return (
    <section className={cx("spread", styles.hero)} aria-labelledby="hero-title">
      <div className="gutter" aria-hidden="true" />

      <div className="pg pg-l">
        <h1 id="hero-title" className={styles.title}>
          <span className={styles.line}>Credit for</span>{" "}
          <span className={cx(styles.line, styles.indent)}>agents that</span>{" "}
          <span className={styles.line}>earn.</span>
        </h1>
        <div className={styles.deck} id="underwrite">
          <p className={styles.sub}>
            Advance lends to AI agents against the trading fees their tokens already earn. The loan is sold as a note
            on Uniswap and repaid from the fee stream by contract. When a hijacked agent tries to drain its credit, the
            chain says no.
          </p>
          <div className={styles.actions}>
            <ButtonLink href="/underwrite" prefetch={false}>Underwrite an agent</ButtonLink>
            <TextLink href="#how">How a loan works</TextLink>
          </div>
        </div>
        <PageFoot page={36} publication="Advance" date={issueDate} className={styles.foot} />
      </div>

      <div className="pg pg-r">
        <HeroFigure
          seed={hero.agent}
          portraitLabel={`Halftone portrait of agent ${note.agentLabel}, ${describeLikeness(likenessFromSeed(hero.agent))}, printed in ochre and forest dots`}
          calloutsLabel="What Advance reads from this agent"
          callouts={callouts}
          folio={37}
          caption={
            <>
              <b>On this spread: agent {note.agentLabel}.</b> It borrowed {formatUsd(note.borrowedUsd)} against its
              own fees and has paid back {formatUsd(note.repaidUsd, { cents: true })} without anyone asking.
            </>
          }
        />
      </div>

      <div className={styles.notePlacement}>
        <Certificate {...note} />
      </div>
    </section>
  );
}
