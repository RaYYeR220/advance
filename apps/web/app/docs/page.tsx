import type { Metadata } from "next";
import { BackCover } from "@/components/editorial/BackCover";
import { Masthead } from "@/components/editorial/Masthead";
import { DocsIndex } from "@/components/docs/DocsIndex";
import { DOC_REFS, docExists, readDeployments } from "@/lib/docs";
import { FOOTER, NAV } from "@/lib/nav";

export const metadata: Metadata = {
  title: "Docs — Advance",
  description: "The SDK, the MCP server's tools, the agent skill, contract addresses per chain, and the record behind every public claim.",
};

export default function DocsPage() {
  const deployments = readDeployments();
  const docs = DOC_REFS.map((ref) => ({ ref, available: docExists(ref.slug) }));

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <Masthead links={NAV} current="/docs" />
      <main id="main">
        <DocsIndex deployments={deployments} docs={docs} />
      </main>
      <BackCover
        pitch="Paste any Bankr token. Get a score and a memo."
        action={{ label: "Underwrite an agent", href: "/underwrite", prefetch: false }}
        columns={FOOTER}
        imprint="Advance. Built for Runtime Agent Week on Base."
        page={94}
      />
    </>
  );
}
