import Link from "next/link";
import { RunningHead } from "@/components/editorial/Folio";
import type { ChainDeployment, DocRef } from "@/lib/docs";
import { addressUrl, blockUrl, chainName } from "@/lib/explorer";
import { formatBlock, shortAddress } from "@/lib/format";
import styles from "./DocsIndex.module.css";

export interface DocsIndexProps {
  deployments: readonly ChainDeployment[];
  docs: readonly { ref: DocRef; available: boolean }[];
}

const MCP_TOOLS = [
  "advance_score_token — free eligibility check",
  "advance_get_quote — paid, signed term sheet",
  "advance_apply — moves the fee beneficiary, opens the loan",
  "advance_list_auctions / advance_loan_status — read state",
  "advance_bid_on_note — lender: bid on a note auction",
  "advance_draw_credit — borrower: draw onto the agent card",
  "advance_claim_repayments — lender: claim owed USDC",
  "advance_explain_refusal — plain-English reason for a refusal",
];

/** `/docs`: a real quickstart (the SDK in a few lines, the MCP server's tools, the agent
 * skill), contract addresses per chain read straight off `contracts/deployments/*.json`, and
 * links to the repository's own claim/proof/judge/security write-ups. */
export function DocsIndex({ deployments, docs }: DocsIndexProps) {
  return (
    <section className={styles.page}>
      <header>
        <RunningHead page={92} title="Docs" />
        <p className={styles.eyebrow}>Quickstart</p>
        <h1 className={styles.title}>Point an agent at Advance in a few lines</h1>
        <p className={styles.deck}>
          Three equivalent ways in — a typed SDK, an MCP server, or a drop-in agent skill — plus every deployed
          contract address and the record behind every public claim.
        </p>
      </header>

      <div className={styles.section} id="sdk">
        <h2 className={styles.sectionTitle}>SDK</h2>
        <p className={styles.sectionIntro}>
          <code>@advance/sdk</code> — a typed client over the same reads and writes the app itself uses. Holds no
          keys; every write takes a viem wallet client from the caller.
        </p>
        <pre className={styles.pre}>
          <code>{SDK_SAMPLE}</code>
        </pre>
      </div>

      <div className={styles.section} id="mcp">
        <h2 className={styles.sectionTitle}>MCP server</h2>
        <p className={styles.sectionIntro}>
          <code>@advance/mcp</code> exposes the same protocol as MCP tools, over stdio or Streamable HTTP, for any
          MCP-speaking agent runtime.
        </p>
        <div className={styles.subsection}>
          <h3 className={styles.subsectionTitle}>Tools</h3>
          <ul className={styles.toolList}>
            {MCP_TOOLS.map((tool) => (
              <li key={tool}>{tool}</li>
            ))}
          </ul>
        </div>
        <div className={styles.subsection}>
          <h3 className={styles.subsectionTitle}>Pointing an agent at it</h3>
          <pre className={styles.pre}>
            <code>{MCP_CONFIG_SAMPLE}</code>
          </pre>
        </div>
      </div>

      <div className={styles.section} id="skill">
        <h2 className={styles.sectionTitle}>Agent skill</h2>
        <p className={styles.sectionIntro}>
          A drop-in skill named <code>advance</code>: revenue-backed credit for an agent whose own token has real fee
          revenue and whose runway is getting low. Score eligibility, get a signed quote, open a loan and draw
          against it — placed in a compatible agent runtime&apos;s skills directory, it&apos;s picked up
          automatically, no separate integration step.
        </p>
      </div>

      <div className={styles.section} id="contracts">
        <h2 className={styles.sectionTitle}>Contract addresses</h2>
        <p className={styles.sectionIntro}>Read straight off this repository&apos;s own deployment records — never typed in by hand.</p>
        <ul className={styles.chainList}>
          {deployments.map((deployment) => (
            <ChainRow key={deployment.chainId} deployment={deployment} />
          ))}
        </ul>
      </div>

      <div className={styles.section} id="record">
        <h2 className={styles.sectionTitle}>The record</h2>
        <p className={styles.sectionIntro}>What every public claim is backed by, and what we deliberately do not claim.</p>
        <ul className={styles.docList}>
          {docs.map(({ ref, available }) => (
            <li key={ref.slug} className={styles.docRow}>
              {available ? (
                <Link className={styles.docTitle} href={`/docs/${ref.slug}`}>
                  {ref.title}
                </Link>
              ) : (
                <span className={styles.docTitle}>{ref.title}</span>
              )}
              {available ? null : <span className={styles.docUnavailable}>Not published yet</span>}
              <span className={styles.docDescription}>{ref.description}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function ChainRow({ deployment }: { deployment: ChainDeployment }) {
  const name = chainName(deployment.chainId);
  return (
    <li className={styles.chain}>
      <div className={styles.chainHead}>
        <span className={styles.chainName}>{name}</span>
        <span className={styles.chainState} data-deployed={deployment.deployed || undefined}>
          {deployment.deployed ? "Deployed" : "Not deployed"}
        </span>
      </div>
      {deployment.deployed && deployment.hub ? (
        <dl className={styles.addresses}>
          <div>
            <dt>AdvanceHub</dt>
            <dd>
              <a href={addressUrl(deployment.chainId, deployment.hub)} target="_blank" rel="noreferrer" title={deployment.hub}>
                {shortAddress(deployment.hub)}
              </a>
            </dd>
          </div>
          {deployment.underwriter ? (
            <div>
              <dt>Underwriter signer</dt>
              <dd>
                <a
                  href={addressUrl(deployment.chainId, deployment.underwriter)}
                  target="_blank"
                  rel="noreferrer"
                  title={deployment.underwriter}
                >
                  {shortAddress(deployment.underwriter)}
                </a>
              </dd>
            </div>
          ) : null}
          {deployment.owner ? (
            <div>
              <dt>Owner</dt>
              <dd>
                <a href={addressUrl(deployment.chainId, deployment.owner)} target="_blank" rel="noreferrer" title={deployment.owner}>
                  {shortAddress(deployment.owner)}
                </a>
              </dd>
            </div>
          ) : null}
          {deployment.block !== undefined ? (
            <div>
              <dt>Deployed at block</dt>
              <dd>
                <a href={blockUrl(deployment.chainId, deployment.block)} target="_blank" rel="noreferrer">
                  {formatBlock(deployment.block)}
                </a>
              </dd>
            </div>
          ) : null}
        </dl>
      ) : (
        <p className={styles.notDeployed}>Not deployed yet on {name}.</p>
      )}
    </li>
  );
}

const SDK_SAMPLE = `import { AdvanceClient } from "@advance/sdk";

const advance = new AdvanceClient({ chainId, apiUrl, publicClient, hub });

const score = await advance.score(token);                 // free eligibility check
const decision = await advance.quote({ token, agentCard, agentId }); // paid, signed term sheet
if (decision.kind === "approve") {
  const { moveBeneficiary, openLoan } = advance.prepareApplication(decision);
  // sign and send both with your own wallet
}

// lending
await advance.bid(wallet, { loanId, notes, maxPriceCents });
await advance.claim(wallet, loanId);`;

const MCP_CONFIG_SAMPLE = `{
  "mcpServers": {
    "advance": {
      "command": "npx",
      "args": ["-y", "@advance/mcp"],
      "env": {
        "CHAIN_ID": "84532",
        "ADVANCE_API_URL": "https://underwriter.example.com",
        "ADVANCE_HUB": "0x...",
        "BASE_SEPOLIA_RPC_URL": "https://sepolia.base.org"
      }
    }
  }
}`;
