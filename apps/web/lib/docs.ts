import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Address } from "viem";
import type { SupportedChainId } from "./env";

/**
 * `/docs`: contract addresses read straight off `contracts/deployments/*.json` (this app's own
 * repository, three directories up from `apps/web/lib`), and the repository's own claim/proof/
 * judge/security write-ups. Both are honest by construction: a missing or malformed file reads
 * as "not deployed"/"not available", never an invented address or a broken link.
 */

const DEFAULT_DEPLOYMENTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../contracts/deployments");
const DEFAULT_DOCS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../docs");

const CHAIN_IDS: readonly SupportedChainId[] = [8453, 84532];

function isAddress(value: unknown): value is Address {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

export interface ChainDeployment {
  chainId: SupportedChainId;
  deployed: boolean;
  hub?: Address;
  escrowDeployer?: Address;
  loanDeployer?: Address;
  underwriter?: Address;
  owner?: Address;
  block?: number;
}

/** One chain's deployment record, or `{ deployed: false }` when the file is missing, unreadable
 * or doesn't carry a well-formed `hub` address — never a half-built record standing in for a
 * real one. */
export function readDeployment(chainId: SupportedChainId, deploymentsDir: string = DEFAULT_DEPLOYMENTS_DIR): ChainDeployment {
  try {
    const raw = fs.readFileSync(path.join(deploymentsDir, `${chainId}.json`), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!isAddress(parsed.hub)) return { chainId, deployed: false };
    return {
      chainId,
      deployed: true,
      hub: parsed.hub,
      escrowDeployer: isAddress(parsed.escrowDeployer) ? parsed.escrowDeployer : undefined,
      loanDeployer: isAddress(parsed.loanDeployer) ? parsed.loanDeployer : undefined,
      underwriter: isAddress(parsed.underwriter) ? parsed.underwriter : undefined,
      owner: isAddress(parsed.owner) ? parsed.owner : undefined,
      block: typeof parsed.block === "number" ? parsed.block : undefined,
    };
  } catch {
    return { chainId, deployed: false };
  }
}

/** Every chain Advance targets — Base mainnet then Base Sepolia — regardless of which one this
 * deployment itself runs against, so the page can show both honestly. */
export function readDeployments(deploymentsDir: string = DEFAULT_DEPLOYMENTS_DIR): ChainDeployment[] {
  return CHAIN_IDS.map((chainId) => readDeployment(chainId, deploymentsDir));
}

export interface DocRef {
  slug: string;
  title: string;
  file: string;
  description: string;
}

export const DOC_REFS: readonly DocRef[] = [
  { slug: "claims", title: "Claims ledger", file: "CLAIMS.md", description: "Every public claim, tagged verified, reproducible, modeled or not claimed." },
  { slug: "proof", title: "Proof", file: "PROOF.md", description: "Every address and transaction the claims ledger points at." },
  { slug: "judges", title: "For judges", file: "JUDGES.md", description: "A five-minute path through the live app and the record behind it." },
  { slug: "security", title: "Security", file: "SECURITY.md", description: "Our own audit of our own code, including what we could not fix and why." },
];

export interface DocContent {
  ref: DocRef;
  source: string;
}

/** One doc's raw markdown source, or `undefined` when `slug` isn't recognized or the file
 * doesn't exist in this checkout yet — the honest state for a doc that hasn't been written. */
export function readDoc(slug: string, docsDir: string = DEFAULT_DOCS_DIR): DocContent | undefined {
  const ref = DOC_REFS.find((d) => d.slug === slug);
  if (!ref) return undefined;
  try {
    const source = fs.readFileSync(path.join(docsDir, ref.file), "utf8");
    return { ref, source };
  } catch {
    return undefined;
  }
}

/** Whether `slug`'s file exists in this checkout — used to render a live link vs. a plain
 * "not published yet" line without reading the whole file. */
export function docExists(slug: string, docsDir: string = DEFAULT_DOCS_DIR): boolean {
  return readDoc(slug, docsDir) !== undefined;
}
