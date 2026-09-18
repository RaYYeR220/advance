import type { Metadata } from "next";
import { BackCover } from "@/components/editorial/BackCover";
import { Masthead } from "@/components/editorial/Masthead";
import { EconomyIndex } from "@/components/economy/EconomyIndex";
import { getEconomy, getRecentEvents, type EconomyView } from "@/lib/data";
import type { EventsPage } from "@/lib/events";
import { toJsonSafe } from "@/lib/jsonSafe";
import { FOOTER, NAV } from "@/lib/nav";
import type { JsonEventLike } from "@/lib/ticker";

export const metadata: Metadata = {
  title: "Economy — Advance",
  description: "Every funded agent, live: runway against its grace period, seven-day revenue and its last recorded action.",
};

// Runway, revenue and the activity ticker all move block to block — this page always reads
// fresh, never a build-time snapshot.
export const dynamic = "force-dynamic";

const EMPTY_ECONOMY: EconomyView = { chainId: 84532, asOfBlock: 0n, lookbackDays: 7, agents: [] };

/** Never lets a missing deployment or a transient read crash the page — the same honest empty
 * state ("hasn't funded its first agent yet") a fresh, unconfigured deployment would show for
 * real. */
async function getEconomySafe(): Promise<EconomyView> {
  try {
    return await getEconomy();
  } catch {
    return EMPTY_ECONOMY;
  }
}

async function getRecentEventsSafe(): Promise<EventsPage> {
  try {
    return await getRecentEvents();
  } catch {
    return { events: [] };
  }
}

export default async function EconomyPage() {
  const [economy, activity] = await Promise.all([getEconomySafe(), getRecentEventsSafe()]);
  const recentEvents = toJsonSafe(activity.events) as JsonEventLike[];

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <Masthead links={NAV} current="/economy" />
      <main id="main">
        <EconomyIndex economy={economy} recentEvents={recentEvents} />
      </main>
      <BackCover
        pitch="Paste any Bankr token. Get a score and a memo."
        action={{ label: "Underwrite an agent", href: "/underwrite", prefetch: false }}
        columns={FOOTER}
        imprint="Advance. Built for Runtime Agent Week on Base."
        page={82}
      />
    </>
  );
}
