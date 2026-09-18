import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { AdvanceClient } from "@advance/sdk";
import { chainById, type SupportedChainId } from "@advance/core";
import type { AdvanceOperations } from "./types.js";

export interface AdvanceClientConfig {
  chainId: SupportedChainId;
  rpcUrl: string;
  apiUrl: string;
  hub: Address;
}

/**
 * Builds the real `AdvanceOperations` these tools run against production: an `@advance/sdk`
 * `AdvanceClient` over a live `PublicClient`, plus `sendPreparedTx` (not on `AdvanceClient`
 * itself) for sending the unsigned `TxRequest`s `prepareApplication` returns. Never re-implements
 * a chain read or write the SDK already has — this is composition, not a second client.
 */
export function buildAdvanceOperations(config: AdvanceClientConfig): AdvanceOperations {
  const publicClient = createPublicClient({
    chain: chainById(config.chainId),
    transport: http(config.rpcUrl),
  }) as PublicClient;

  const client = new AdvanceClient({
    chainId: config.chainId,
    apiUrl: config.apiUrl,
    publicClient,
    hub: config.hub,
  });

  return wrapAdvanceClient(client, publicClient);
}

/**
 * The composition step `buildAdvanceOperations` uses, split out so a test can hand it an
 * `AdvanceClient` already pointed at an anvil fork (a `chainId`/`publicClient` this module's own
 * `chainById`-based construction can't produce) without duplicating the `sendPreparedTx` glue.
 */
export function wrapAdvanceClient(client: AdvanceClient, publicClient: PublicClient): AdvanceOperations {
  return {
    score: (token) => client.score(token),
    quote: (req) => client.quote(req),
    evidence: (hash) => client.evidence(hash),
    predictEscrow: (ts) => client.predictEscrow(ts),
    prepareApplication: (decision) => client.prepareApplication(decision),
    openLoan: (wallet, decision) => client.openLoan(wallet, decision),
    loan: (loanId) => client.loan(loanId),
    loans: (filter) => client.loans(filter),
    auction: (loanId) => client.auction(loanId),
    bid: (wallet, p) => client.bid(wallet, p),
    claim: (wallet, loanId) => client.claim(wallet, loanId),
    draw: (wallet, p) => client.draw(wallet, p),
    async sendPreparedTx(wallet, tx) {
      const account = wallet.account;
      if (!account) {
        throw new Error("advance mcp: wallet client has no bound account — construct it with `account` set");
      }
      const hash = await wallet.sendTransaction({
        account,
        chain: wallet.chain,
        to: tx.to,
        data: tx.data,
        value: tx.value,
      });
      await publicClient.waitForTransactionReceipt({ hash });
      return { hash };
    },
  };
}
