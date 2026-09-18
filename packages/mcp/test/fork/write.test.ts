import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AdvanceClient, type ApproveDecision } from "@advance/sdk";
import { signTermSheet, type TermSheet } from "@advance/core";
import type { Hex } from "viem";
import { wrapAdvanceClient } from "../../src/client.js";
import { buildAdvanceServer, type AdvanceMcpDeps } from "../../src/server.js";
import { toJsonSafe } from "../../src/json.js";
// Reuses the SDK's own anvil-fork harness (deploys a fresh Advance stack via
// `contracts/script/DeploySdkFixture.s.sol`) rather than standing up a second one — this suite
// only exercises one more layer (the MCP tool) on top of exactly what `packages/sdk`'s fork
// suite already proves the contract calls do.
import { startForkHarness, type ForkHarness } from "../../../sdk/test/fork/harness.js";

interface CallToolResult {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
}

function bodyOf(result: CallToolResult): unknown {
  const first = result.content?.[0];
  if (!first || first.type !== "text" || first.text === undefined) {
    throw new Error("expected a single text content block");
  }
  return JSON.parse(first.text);
}

const NOTE_SUPPLY = 5_000_000_000_000_000_000n; // 5e18 -> 5 USDC cap
const FLOOR_CENTS = 80;
const MIN_PRINCIPAL = 2_000_000n; // $2
const AUCTION_BLOCKS = 10n; // divides 1e7; small so the fork mines past it quickly
const DRAW_LIMIT = 1_000_000n; // $1
const DRAW_PERIOD = 86_400n;
const GRACE_PERIOD = 1_209_600n;
const CREATOR_SHARES = 1_000_000_000_000_000_000n; // 1e18 — the fixture pool's only beneficiary

let harness: ForkHarness;
let decision: ApproveDecision;

describe("advance_apply against a fresh anvil-fork deployment", () => {
  beforeAll(async () => {
    harness = await startForkHarness();
    const { fixture, publicClient } = harness;

    const latest = await publicClient.getBlock();
    const termSheet: TermSheet = {
      agentTreasury: harness.accounts.treasury.address,
      agentCard: fixture.agentCard,
      agentId: 0n,
      feesManager: fixture.feesManager,
      poolId: fixture.poolId,
      expectedShares: CREATOR_SHARES,
      noteSupply: NOTE_SUPPLY,
      floorCents: FLOOR_CENTS,
      minPrincipal: MIN_PRINCIPAL,
      auctionBlocks: AUCTION_BLOCKS,
      drawLimit: DRAW_LIMIT,
      drawPeriod: DRAW_PERIOD,
      gracePeriod: GRACE_PERIOD,
      deadline: latest.timestamp + 3600n,
      nonce: 1n,
      memoHash: `0x${"ab".repeat(32)}` as Hex,
    };
    const signature = await signTermSheet(termSheet, 31337, fixture.hub, harness.accounts.underwriter.privateKey);
    decision = { kind: "approve", termSheet, signature } as unknown as ApproveDecision;
  }, 120_000);

  afterAll(async () => {
    await harness?.stop();
  });

  it("opens a real loan on the fork and returns its transaction hashes", async () => {
    const client = new AdvanceClient({
      // Only gates score()/quote() HTTP calls, which this tool never makes.
      chainId: 8453,
      apiUrl: "http://unused.invalid",
      publicClient: harness.publicClient,
      hub: harness.fixture.hub,
    });

    const deps: AdvanceMcpDeps = {
      advance: wrapAdvanceClient(client, harness.publicClient),
      chainId: 8453,
      signer: async () => harness.walletFor(harness.accounts.treasury),
      refusalSource: { latestForAgent: async () => [] },
    };

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = buildAdvanceServer(deps);
    const mcpClient = new Client({ name: "fork-test-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);

    const decisionJson = JSON.parse(JSON.stringify(toJsonSafe(decision)));
    const result = (await mcpClient.callTool({
      name: "advance_apply",
      arguments: { decision: decisionJson, confirm: true },
    })) as CallToolResult;

    expect(result.isError).toBeFalsy();
    const body = bodyOf(result) as {
      loanId: string;
      moveBeneficiaryTxHash: string;
      openLoanTxHash: string;
      openLoanExplorerUrl: string;
    };
    expect(body.moveBeneficiaryTxHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(body.openLoanTxHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(body.openLoanExplorerUrl).toContain(body.openLoanTxHash);

    // Confirm the loan is real, not just a tool-shaped response: read it straight off the hub.
    const loan = await deps.advance.loan(BigInt(body.loanId));
    expect(loan.status).toBe("Auction");
    expect(loan.termSheet.agentTreasury.toLowerCase()).toBe(harness.accounts.treasury.address.toLowerCase());
  }, 120_000);
});
