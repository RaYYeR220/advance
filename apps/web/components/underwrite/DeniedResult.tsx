import type { Address } from "viem";
import type { ScoreResult } from "@advance/sdk";
import { shortAddress } from "@/lib/format";
import { EvidenceNote } from "./EvidenceNote";
import { ReasonExhibit } from "./ReasonExhibit";
import { ScoreHeader } from "./ScoreHeader";
import styles from "./ScoreResult.module.css";

type Deny = Extract<ScoreResult, { kind: "deny" }>;

export interface DeniedResultProps {
  token: Address;
  result: Deny;
  apiBaseUrl?: string;
}

/** A denied score: every deny reason as a plain-language exhibit, plus the evidence it was
 * read from. */
export function DeniedResult({ token, result, apiBaseUrl }: DeniedResultProps) {
  const { reasons, evidence, evidenceHash } = result;
  return (
    <>
      <ScoreHeader
        page={61}
        eyebrow="Not eligible yet"
        title={`No terms for ${shortAddress(token)}`}
        token={{ address: token, chainId: evidence.chainId }}
      />
      <section className={styles.section} aria-labelledby="reasons-title">
        <h2 id="reasons-title">
          {reasons.length} {reasons.length === 1 ? "reason" : "reasons"}
        </h2>
        <p className={styles.sectionIntro}>Every rule that fired, in the order the engine checked them.</p>
        {reasons.map((reason, index) => (
          <ReasonExhibit key={reason} reason={reason} index={index} />
        ))}
      </section>
      <EvidenceNote hash={evidenceHash} apiBaseUrl={apiBaseUrl} />
    </>
  );
}
