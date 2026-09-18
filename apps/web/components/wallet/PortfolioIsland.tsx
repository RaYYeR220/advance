"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { createPublicClient, http, type Address, type Hex, type PublicClient } from "viem";
import { base, baseSepolia } from "viem/chains";
import { useDynamicContext } from "@dynamic-labs/sdk-react-core";
import { isEthereumWallet } from "@dynamic-labs/ethereum";
import type { LoanView } from "@advance/sdk";
import { txUrl } from "@/lib/explorer";
import { formatUsd, shortAddress } from "@/lib/format";
import type { SupportedChainId } from "@/lib/env";
import {
  claimHistoryFromJsonEvents,
  portfolioRowsFromReads,
  totalClaimableUsd,
  type PortfolioRow,
  type RepaymentHistoryEntry,
} from "@/lib/portfolio";
import type { JsonEventLike } from "@/lib/ticker";
import { describeWalletError } from "./bidSteps";
import { DisabledPortfolio } from "./DisabledPortfolio";
import { DynamicProvider } from "./DynamicProvider";
import { claimNote, readNoteHoldings } from "./portfolioSteps";
import shared from "./BidPanel.module.css";
import styles from "./PortfolioPanel.module.css";

export interface PortfolioIslandProps {
  environmentId?: string;
  /** Every loan the hub has ever opened — reading which ones this wallet has a stake in needs
   * checking each loan's own note contract; there's no indexer to look the other way round
   * (address → loans), the same limitation `events.ts`'s module doc describes for activity. */
  loans: readonly LoanView[];
  chainId: SupportedChainId;
}

/** The whole client-side portfolio widget: connect a lender wallet, read its note holdings and
 * claimable USDC across every loan, claim, and show its own repayment history. With no
 * environment id configured, renders a disabled form and an explanation instead — never a
 * crash, and never a Dynamic provider mounted with an empty id. */
export function PortfolioIsland({ environmentId, loans, chainId }: PortfolioIslandProps) {
  if (!environmentId) {
    return (
      <section className={shared.panel} aria-labelledby="portfolio-title">
        <h2 className={shared.panelTitle} id="portfolio-title">
          Your notes
        </h2>
        <DisabledPortfolio />
      </section>
    );
  }

  return (
    <DynamicProvider environmentId={environmentId}>
      <PortfolioConnected loans={loans} chainId={chainId} />
    </DynamicProvider>
  );
}

interface ClaimState {
  pending?: boolean;
  hash?: Hex;
  error?: string;
}

function PortfolioConnected({ loans, chainId }: { loans: readonly LoanView[]; chainId: SupportedChainId }) {
  const { primaryWallet, setShowAuthFlow, handleLogOut, sdkHasLoaded } = useDynamicContext();
  const [rows, setRows] = useState<PortfolioRow[] | null>(null);
  const [history, setHistory] = useState<RepaymentHistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [readError, setReadError] = useState<string | undefined>();
  const [claims, setClaims] = useState<Record<string, ClaimState>>({});

  const address = primaryWallet && isEthereumWallet(primaryWallet) ? (primaryWallet.address as Address) : undefined;

  const refresh = useCallback(async () => {
    if (!address) return;
    setLoading(true);
    setReadError(undefined);
    try {
      const chain = chainId === 8453 ? base : baseSepolia;
      // Cast: viem's `Client` generics don't structurally unify across independently inferred
      // `createPublicClient` calls (a well-known viem/TypeScript limitation, same as
      // `BidForm`'s own cast) — the runtime client is fully compatible with `PublicClient`.
      const publicClient = createPublicClient({ chain, transport: http() }) as unknown as PublicClient;
      const reads = await readNoteHoldings(publicClient, loans, address);
      const portfolioRows = portfolioRowsFromReads(reads);
      setRows(portfolioRows);

      const pages = await Promise.all(
        portfolioRows.map(async (row): Promise<{ events?: JsonEventLike[] }> => {
          try {
            const res = await fetch(`/api/events?loanId=${row.loanId.toString()}&types=Claimed&limit=200`);
            return res.ok ? ((await res.json()) as { events?: JsonEventLike[] }) : { events: [] };
          } catch {
            return { events: [] };
          }
        }),
      );
      const events = pages.flatMap((page) => page.events ?? []);
      setHistory(claimHistoryFromJsonEvents(events, address));
    } catch (err) {
      setReadError(describeWalletError(err));
    } finally {
      setLoading(false);
    }
  }, [address, loans, chainId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!sdkHasLoaded) {
    return (
      <section className={shared.panel} aria-labelledby="portfolio-title">
        <h2 className={shared.panelTitle} id="portfolio-title">
          Your notes
        </h2>
        <p className={shared.loading}>Loading wallet…</p>
      </section>
    );
  }

  if (!primaryWallet || !address) {
    return (
      <section className={shared.panel} aria-labelledby="portfolio-title">
        <h2 className={shared.panelTitle} id="portfolio-title">
          Your notes
        </h2>
        <p className={shared.copy}>Connect a lender wallet to see the notes you hold and what&apos;s claimable.</p>
        <button type="button" className="button" onClick={() => setShowAuthFlow(true)}>
          Connect wallet
        </button>
      </section>
    );
  }

  async function runClaim(row: PortfolioRow) {
    const key = row.loanId.toString();
    setClaims((prev) => ({ ...prev, [key]: { pending: true } }));
    try {
      if (!primaryWallet || !isEthereumWallet(primaryWallet)) throw new Error("Connect an Ethereum-compatible wallet first.");
      const wallet = await primaryWallet.getWalletClient();
      const chain = chainId === 8453 ? base : baseSepolia;
      const publicClient = createPublicClient({ chain, transport: http() }) as unknown as PublicClient;
      const { hash } = await claimNote(wallet, publicClient, row.note);
      setClaims((prev) => ({ ...prev, [key]: { hash } }));
      await refresh();
    } catch (err) {
      setClaims((prev) => ({ ...prev, [key]: { error: describeWalletError(err) } }));
    }
  }

  return (
    <section className={shared.panel} aria-labelledby="portfolio-title">
      <h2 className={shared.panelTitle} id="portfolio-title">
        Your notes
      </h2>
      <p className={shared.copy}>
        Connected as {shortAddress(address)}.{" "}
        <button type="button" className={shared.link} onClick={() => handleLogOut()}>
          Disconnect
        </button>
      </p>

      {loading ? <p className={shared.loading}>Reading your notes…</p> : null}
      {readError ? (
        <p className={shared.error} role="alert">
          {readError}
        </p>
      ) : null}

      {!loading && rows !== null && rows.length === 0 ? (
        <p className={shared.copy}>This wallet holds no notes and has nothing claimable right now.</p>
      ) : null}

      {rows && rows.length > 0 ? (
        <>
          <p className={styles.total}>
            <b>{formatUsd(totalClaimableUsd(rows), { cents: true })}</b>
            claimable across {rows.length} loan{rows.length === 1 ? "" : "s"}
          </p>
          <ul className={shared.bidList}>
            {rows.map((row) => {
              const claim = claims[row.loanId.toString()];
              return (
                <li key={row.loanId.toString()} className={shared.bidRow}>
                  <Link href={`/loans/${row.loanId.toString()}`} className={styles.rowLoan}>
                    Loan #{row.loanId.toString()}
                  </Link>
                  <span className={styles.rowStat}>
                    <b>{formatUsd(row.notesUsd)}</b> in notes
                  </span>
                  <span className={styles.rowStat}>
                    <b>{formatUsd(row.claimableUsd, { cents: true })}</b> claimable
                  </span>
                  <span className={shared.bidActions}>
                    {claim?.hash ? (
                      <a href={txUrl(chainId, claim.hash)} target="_blank" rel="noreferrer">
                        claim tx
                      </a>
                    ) : (
                      <button
                        type="button"
                        className={shared.smallButton}
                        disabled={row.claimableUsd <= 0 || claim?.pending === true}
                        onClick={() => void runClaim(row)}
                      >
                        {claim?.pending ? "Claiming…" : "Claim"}
                      </button>
                    )}
                  </span>
                  {claim?.error ? (
                    <p className={shared.error} role="alert">
                      {claim.error}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      ) : null}

      <div className={styles.section}>
        <h3 className={shared.panelTitle}>Repayment history</h3>
        {history.length === 0 ? (
          <p className={shared.copy}>No repayments claimed by this wallet yet.</p>
        ) : (
          <ul className={shared.bidList}>
            {history.map((entry) => (
              <li key={entry.id} className={shared.bidRow}>
                <Link href={`/loans/${entry.loanId.toString()}`} className={styles.rowLoan}>
                  Loan #{entry.loanId.toString()}
                </Link>
                <span className={styles.rowStat}>
                  <b>{formatUsd(entry.amountUsd, { cents: true })}</b> claimed
                </span>
                <a href={txUrl(chainId, entry.txHash)} target="_blank" rel="noreferrer">
                  view tx
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
