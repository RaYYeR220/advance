import { BackCover } from "@/components/editorial/BackCover";
import { Colophon } from "@/components/editorial/Colophon";
import { Masthead } from "@/components/editorial/Masthead";
import { AudienceSpread } from "@/components/landing/AudienceSpread";
import { EconomyBand } from "@/components/landing/EconomyBand";
import { HeroSpread } from "@/components/landing/HeroSpread";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { RefusalSpread } from "@/components/landing/RefusalSpread";
import { getLandingDataSafe } from "@/lib/data";
import { FOOTER, NAV } from "@/lib/nav";

export default async function LandingPage() {
  const data = await getLandingDataSafe();
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
