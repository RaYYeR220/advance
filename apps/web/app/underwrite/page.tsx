import type { Metadata } from "next";
import { BackCover } from "@/components/editorial/BackCover";
import { Masthead } from "@/components/editorial/Masthead";
import { UnderwritePitch } from "@/components/underwrite/UnderwritePitch";
import { FOOTER, NAV } from "@/lib/nav";

export const metadata: Metadata = {
  title: "Underwrite — Advance",
  description: "Paste a Bankr token and get a free eligibility score: revenue windows, the haircut breakdown and the terms a formula would offer.",
};

export default function UnderwritePage() {
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <Masthead links={NAV} />
      <main id="main">
        <UnderwritePitch />
      </main>
      <BackCover
        pitch="Paste any Bankr token. Get a score and a memo."
        action={{ label: "Underwrite an agent", href: "/underwrite", prefetch: false }}
        columns={FOOTER}
        imprint="Advance. Built for Runtime Agent Week on Base."
        page={64}
      />
    </>
  );
}
