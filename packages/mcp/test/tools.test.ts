import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildAdvanceServer, type AdvanceMcpDeps } from "../src/server.js";
import { RefusalSourceUnavailable, type RefusalEvent, type RefusalSource } from "../src/refusalSource.js";
import { toJsonSafe } from "../src/json.js";
import {
  AGENT_CARD,
  AGENT_TREASURY,
  SAMPLE_APPROVE_DECISION,
  TOKEN,
  TX_HASH,
  createFakeAdvanceOperations,
  fakeWallet,
} from "./fixtures.js";

interface CallToolResult {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
}

const NO_REFUSALS: RefusalSource = { latestForAgent: async () => [] };
const NO_SIGNER = async () => undefined;

async function connectedClient(deps: AdvanceMcpDeps): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildAdvanceServer(deps);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function bodyOf(result: CallToolResult): unknown {
  const first = result.content?.[0];
  if (!first || first.type !== "text" || first.text === undefined) {
    throw new Error("expected a single text content block");
  }
  return JSON.parse(first.text);
}

describe("advance mcp server", () => {
  it("lists the full advance tool set", async () => {
    const deps: AdvanceMcpDeps = {
      advance: createFakeAdvanceOperations(),
      chainId: 84532,
      signer: NO_SIGNER,
      refusalSource: NO_REFUSALS,
    };
    const client = await connectedClient(deps);

    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "advance_apply",
        "advance_bid_on_note",
        "advance_claim_repayments",
        "advance_draw_credit",
        "advance_explain_refusal",
        "advance_get_quote",
        "advance_list_auctions",
        "advance_loan_status",
        "advance_score_token",
      ].sort(),
    );
    // Every tool carries a non-trivial, agent-facing description.
    for (const tool of tools) {
      expect(tool.description?.length ?? 0).toBeGreaterThan(40);
    }
  });

  it("advance_score_token returns shaped JSON with bigints as decimal strings", async () => {
    const advance = createFakeAdvanceOperations();
    const deps: AdvanceMcpDeps = { advance, chainId: 84532, signer: NO_SIGNER, refusalSource: NO_REFUSALS };
    const client = await connectedClient(deps);

    const result = (await client.callTool({
      name: "advance_score_token",
      arguments: { token: TOKEN },
    })) as CallToolResult;

    expect(result.isError).toBeFalsy();
    const body = bodyOf(result) as { kind: string; terms: { capMicroUsd: string } };
    expect(body.kind).toBe("eligible");
    expect(body.terms.capMicroUsd).toBe("10000000");
    expect(advance.calls.score).toEqual([[TOKEN]]);
  });

  it("advance_loan_status reads a loan and attaches explorer links", async () => {
    const advance = createFakeAdvanceOperations();
    const deps: AdvanceMcpDeps = { advance, chainId: 84532, signer: NO_SIGNER, refusalSource: NO_REFUSALS };
    const client = await connectedClient(deps);

    const result = (await client.callTool({
      name: "advance_loan_status",
      arguments: { loanId: "1" },
    })) as CallToolResult;

    expect(result.isError).toBeFalsy();
    const body = bodyOf(result) as { status: string; cap: string; links: { escrow: string } };
    expect(body.status).toBe("Auction");
    expect(body.cap).toBe("10000000");
    expect(body.links.escrow).toContain("sepolia.basescan.org");
    expect(advance.calls.loan).toEqual([[1n]]);
  });

  it("advance_list_auctions merges loans with their live auction state", async () => {
    const advance = createFakeAdvanceOperations();
    const deps: AdvanceMcpDeps = { advance, chainId: 84532, signer: NO_SIGNER, refusalSource: NO_REFUSALS };
    const client = await connectedClient(deps);

    const result = (await client.callTool({
      name: "advance_list_auctions",
      arguments: {},
    })) as CallToolResult;

    expect(result.isError).toBeFalsy();
    const body = bodyOf(result) as { auctions: Array<{ loanId: string; clearingPriceCents?: number }> };
    expect(body.auctions).toHaveLength(1);
    expect(body.auctions[0]?.loanId).toBe("1");
    expect(body.auctions[0]?.clearingPriceCents).toBe(80);
  });

  it("a write tool called without confirm returns a structured confirmation_required error", async () => {
    const advance = createFakeAdvanceOperations();
    const deps: AdvanceMcpDeps = {
      advance,
      chainId: 84532,
      signer: async () => fakeWallet(),
      refusalSource: NO_REFUSALS,
    };
    const client = await connectedClient(deps);

    const result = (await client.callTool({
      name: "advance_draw_credit",
      arguments: { card: AGENT_CARD, loanId: "1", amount: "1000" },
    })) as CallToolResult;

    expect(result.isError).toBe(true);
    const body = bodyOf(result) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("confirmation_required");
    expect(advance.calls.draw).toBeUndefined();
  });

  it("a write tool with confirm but no configured signer returns a structured signer_not_configured error", async () => {
    const advance = createFakeAdvanceOperations();
    const deps: AdvanceMcpDeps = { advance, chainId: 84532, signer: NO_SIGNER, refusalSource: NO_REFUSALS };
    const client = await connectedClient(deps);

    const result = (await client.callTool({
      name: "advance_bid_on_note",
      arguments: { loanId: "1", notes: "1000000000000000000", maxPriceCents: 80, confirm: true },
    })) as CallToolResult;

    expect(result.isError).toBe(true);
    const body = bodyOf(result) as { error: string };
    expect(body.error).toBe("signer_not_configured");
    expect(advance.calls.bid).toBeUndefined();
  });

  it("a write tool with confirm and a signer sends the transaction and returns its hash", async () => {
    const advance = createFakeAdvanceOperations();
    const deps: AdvanceMcpDeps = {
      advance,
      chainId: 84532,
      signer: async () => fakeWallet(),
      refusalSource: NO_REFUSALS,
    };
    const client = await connectedClient(deps);

    const result = (await client.callTool({
      name: "advance_claim_repayments",
      arguments: { loanId: "1", confirm: true },
    })) as CallToolResult;

    expect(result.isError).toBeFalsy();
    const body = bodyOf(result) as { hash: string; amount: string; explorerUrl: string };
    expect(body.hash).toBe(TX_HASH);
    expect(body.amount).toBe("100000");
    expect(body.explorerUrl).toContain(TX_HASH);
    expect(advance.calls.claim).toHaveLength(1);
  });

  it("advance_apply drives predictEscrow, the beneficiary move and openLoan, in order", async () => {
    const advance = createFakeAdvanceOperations();
    const deps: AdvanceMcpDeps = {
      advance,
      chainId: 84532,
      signer: async () => fakeWallet(),
      refusalSource: NO_REFUSALS,
    };
    const client = await connectedClient(deps);
    const decisionJson = JSON.parse(JSON.stringify(toJsonSafe(SAMPLE_APPROVE_DECISION)));

    const result = (await client.callTool({
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
    expect(body.loanId).toBe("1");
    expect(body.moveBeneficiaryTxHash).toBe(TX_HASH);
    expect(body.openLoanTxHash).toBe(TX_HASH);
    expect(body.openLoanExplorerUrl).toContain(TX_HASH);
    expect(advance.calls.predictEscrow).toHaveLength(1);
    expect(advance.calls.sendPreparedTx).toHaveLength(1);
    expect(advance.calls.openLoan).toHaveLength(1);
  });

  it("advance_apply refuses a denied decision without touching the chain", async () => {
    const advance = createFakeAdvanceOperations();
    const deps: AdvanceMcpDeps = {
      advance,
      chainId: 84532,
      signer: async () => fakeWallet(),
      refusalSource: NO_REFUSALS,
    };
    const client = await connectedClient(deps);

    const result = (await client.callTool({
      name: "advance_apply",
      arguments: { decision: { kind: "deny", reasons: ["too_young"] }, confirm: true },
    })) as CallToolResult;

    expect(result.isError).toBe(true);
    const body = bodyOf(result) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("decision_not_approved");
    expect(advance.calls.predictEscrow).toBeUndefined();
  });

  describe("advance_apply input validation", () => {
    function deps(): AdvanceMcpDeps {
      return {
        advance: createFakeAdvanceOperations(),
        chainId: 84532,
        signer: async () => fakeWallet(),
        refusalSource: NO_REFUSALS,
      };
    }

    async function callApply(decision: unknown): Promise<{ result: CallToolResult; advance: ReturnType<typeof createFakeAdvanceOperations> }> {
      const d = deps();
      const client = await connectedClient(d);
      const result = (await client.callTool({
        name: "advance_apply",
        arguments: { decision, confirm: true },
      })) as CallToolResult;
      return { result, advance: d.advance as ReturnType<typeof createFakeAdvanceOperations> };
    }

    it("rejects the zero address in a term sheet field", async () => {
      const decisionJson = JSON.parse(JSON.stringify(toJsonSafe(SAMPLE_APPROVE_DECISION))) as {
        termSheet: Record<string, unknown>;
      };
      decisionJson.termSheet.agentTreasury = "0x0000000000000000000000000000000000000000";

      const { result, advance } = await callApply(decisionJson);

      expect(result.isError).toBe(true);
      const body = bodyOf(result) as { error: string; message: string };
      expect(body.error).toBe("invalid_decision");
      expect(body.message).toContain("agentTreasury");
      expect(advance.calls.predictEscrow).toBeUndefined();
    });

    it("rejects a badly checksummed address", async () => {
      const decisionJson = JSON.parse(JSON.stringify(toJsonSafe(SAMPLE_APPROVE_DECISION))) as {
        termSheet: Record<string, unknown>;
      };
      // Valid hex, wrong EIP-55 casing (uppercase letters where the checksum requires lowercase).
      decisionJson.termSheet.agentCard = "0xABCDEF1234567890ABCDEF1234567890ABCDEF12";

      const { result, advance } = await callApply(decisionJson);

      expect(result.isError).toBe(true);
      const body = bodyOf(result) as { error: string; message: string };
      expect(body.error).toBe("invalid_decision");
      expect(body.message).toContain("agentCard");
      expect(advance.calls.predictEscrow).toBeUndefined();
    });

    it("rejects an id/amount out of its Solidity type's range", async () => {
      const decisionJson = JSON.parse(JSON.stringify(toJsonSafe(SAMPLE_APPROVE_DECISION))) as {
        termSheet: Record<string, unknown>;
      };
      // floorCents is uint16 (max 65535).
      decisionJson.termSheet.floorCents = 70_000;

      const { result, advance } = await callApply(decisionJson);

      expect(result.isError).toBe(true);
      const body = bodyOf(result) as { error: string; message: string };
      expect(body.error).toBe("invalid_decision");
      expect(body.message).toContain("floorCents");
      expect(advance.calls.predictEscrow).toBeUndefined();
    });

    it("rejects a malformed signature", async () => {
      const decisionJson = JSON.parse(JSON.stringify(toJsonSafe(SAMPLE_APPROVE_DECISION))) as Record<string, unknown>;
      decisionJson.signature = "0xnotasignature";

      const { result, advance } = await callApply(decisionJson);

      expect(result.isError).toBe(true);
      const body = bodyOf(result) as { error: string; message: string };
      expect(body.error).toBe("invalid_decision");
      expect(body.message).toContain("signature");
      expect(advance.calls.predictEscrow).toBeUndefined();
    });

    it("rejects a term sheet missing a required field", async () => {
      const decisionJson = JSON.parse(JSON.stringify(toJsonSafe(SAMPLE_APPROVE_DECISION))) as {
        termSheet: Record<string, unknown>;
      };
      delete decisionJson.termSheet.noteSupply;

      const { result, advance } = await callApply(decisionJson);

      expect(result.isError).toBe(true);
      const body = bodyOf(result) as { error: string };
      expect(body.error).toBe("invalid_decision");
      expect(advance.calls.predictEscrow).toBeUndefined();
    });
  });

  it("advance_explain_refusal reports events_unavailable when the feed isn't configured", async () => {
    const advance = createFakeAdvanceOperations();
    const refusalSource: RefusalSource = {
      latestForAgent: async () => {
        throw new RefusalSourceUnavailable("ADVANCE_EVENTS_URL is not configured");
      },
    };
    const deps: AdvanceMcpDeps = { advance, chainId: 84532, signer: NO_SIGNER, refusalSource };
    const client = await connectedClient(deps);

    const result = (await client.callTool({
      name: "advance_explain_refusal",
      arguments: { agent: AGENT_TREASURY },
    })) as CallToolResult;

    expect(result.isError).toBe(true);
    const body = bodyOf(result) as { error: string };
    expect(body.error).toBe("events_unavailable");
  });

  it("advance_explain_refusal turns a real event into a plain-English explanation", async () => {
    const event: RefusalEvent = {
      ts: 1_700_000_000,
      agent: AGENT_TREASURY,
      kind: "refusal",
      data: { layer: "pretrade", reason: "payTo outside the card's allowlist", payTo: AGENT_CARD, amount: "1000000" },
    };
    const advance = createFakeAdvanceOperations();
    const refusalSource: RefusalSource = { latestForAgent: async () => [event] };
    const deps: AdvanceMcpDeps = { advance, chainId: 84532, signer: NO_SIGNER, refusalSource };
    const client = await connectedClient(deps);

    const result = (await client.callTool({
      name: "advance_explain_refusal",
      arguments: { agent: AGENT_TREASURY, limit: 5 },
    })) as CallToolResult;

    expect(result.isError).toBeFalsy();
    const body = bodyOf(result) as { events: Array<{ explanation: string; data: { reason: string } }> };
    expect(body.events).toHaveLength(1);
    expect(body.events[0]?.explanation).toContain("pretrade");
    expect(body.events[0]?.data.reason).toContain("allowlist");
  });
});
