import { BackCover, type BackCoverColumn } from "@/components/editorial/BackCover";
import { Colophon } from "@/components/editorial/Colophon";
import { Masthead, type MastheadLink } from "@/components/editorial/Masthead";
import { AudienceSpread } from "@/components/landing/AudienceSpread";
import { EconomyBand } from "@/components/landing/EconomyBand";
import { HeroSpread } from "@/components/landing/HeroSpread";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { RefusalSpread } from "@/components/landing/RefusalSpread";
import { landingFixture } from "@/lib/landing-fixture";

const NAV: readonly MastheadLink[] = [
  { label: "Underwrite", href: "#underwrite" },
  { label: "Auctions", href: "#auctions" },
  { label: "Economy", href: "#economy" },
  { label: "Portfolio", href: "#portfolio", optional: true },
  { label: "Docs", href: "#docs" },
];

const FOOTER: readonly BackCoverColumn[] = [
  {
    title: "App",
    links: [
      { label: "Underwrite", href: "#underwrite" },
      { label: "Auctions", href: "#auctions" },
      { label: "Loans", href: "#how" },
      { label: "Economy", href: "#economy" },
      { label: "Portfolio", href: "#portfolio" },
    ],
  },
  {
    title: "Docs",
    links: [
      { label: "SDK", href: "#docs" },
      { label: "MCP server", href: "#docs" },
      { label: "Agent skill", href: "#docs" },
      { label: "Contracts", href: "#docs" },
    ],
  },
  {
    title: "Record",
    links: [
      { label: "Refusal feed", href: "#refusal" },
      { label: "Sweeps", href: "#economy" },
      { label: "Defaults", href: "#economy" },
    ],
  },
  {
    title: "Fine print",
    text: "Notes are claims on future fees, not deposits. If an agent stops earning, its note stops paying.",
  },
];

export default function LandingPage() {
  const data = landingFixture;
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <Masthead links={NAV} />
      <main id="main">
        <HeroSpread hero={data.hero} issueDate={data.issue.date} />
        <HowItWorks lifecycle={data.lifecycle} />
        <RefusalSpread refusal={data.refusal} chainId={data.chainId} />
        <AudienceSpread audiences={data.audiences} />
        <EconomyBand economy={data.economy} />
        <Colophon page={50} contracts={data.builtOn.contracts} rails={data.builtOn.rails} />
      </main>
      <BackCover
        pitch="Paste any Bankr token. Get a score and a memo."
        action={{ label: "Underwrite an agent", href: "/underwrite", prefetch: false }}
        columns={FOOTER}
        imprint={`Advance, issue ${data.issue.number}. Built for Runtime Agent Week on Base.`}
        page={52}
      />
    </>
  );
}
