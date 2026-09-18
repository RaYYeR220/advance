import type { Metadata } from "next";
import type { Address } from "viem";
import { BackCover } from "@/components/editorial/BackCover";
import { Masthead } from "@/components/editorial/Masthead";
import { DeniedResult } from "@/components/underwrite/DeniedResult";
import { EligibleResult } from "@/components/underwrite/EligibleResult";
import { InvalidToken } from "@/components/underwrite/InvalidToken";
import { ScoreError } from "@/components/underwrite/ScoreError";
import styles from "@/components/underwrite/ScoreResult.module.css";
import { getScore, underwriterApiBase } from "@/lib/data";
import { isAddress } from "@/lib/format";
import { FOOTER, NAV } from "@/lib/nav";

interface PageProps {
  params: Promise<{ token: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { token } = await params;
  return { title: `Score for ${token} — Advance` };
}

export default async function UnderwriteTokenPage({ params }: PageProps) {
  const { token: rawToken } = await params;

  const body = isAddress(rawToken) ? await renderScore(rawToken) : <InvalidToken token={rawToken} />;

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <Masthead links={NAV} />
      <main id="main">
        <section className={styles.page}>{body}</section>
      </main>
      <BackCover
        pitch="Paste any Bankr token. Get a score and a memo."
        action={{ label: "Underwrite an agent", href: "/underwrite", prefetch: false }}
        columns={FOOTER}
        imprint="Advance. Built for Runtime Agent Week on Base."
        page={62}
      />
    </>
  );
}

async function renderScore(token: Address) {
  try {
    const result = await getScore(token);
    const apiBaseUrl = safeApiBase();
    return result.kind === "eligible" ? (
      <EligibleResult token={token} result={result} apiBaseUrl={apiBaseUrl} />
    ) : (
      <DeniedResult token={token} result={result} apiBaseUrl={apiBaseUrl} />
    );
  } catch {
    return <ScoreError token={token} />;
  }
}

function safeApiBase(): string | undefined {
  try {
    return underwriterApiBase();
  } catch {
    return undefined;
  }
}
