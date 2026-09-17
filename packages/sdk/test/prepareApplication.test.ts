import { encodeFunctionData, getAddress, type Address, type Hex, type PublicClient } from "viem";
import { describe, expect, it } from "vitest";
import type { TermSheet } from "@advance/core";
import { advanceHubAbi, dopplerFeesManagerAbi } from "../src/abis/index.js";
import { AdvanceClient } from "../src/client.js";
import type { ApproveDecision } from "../src/types.js";

const HUB: Address = getAddress(`0x${"0".repeat(38)}a1`);
const ESCROW: Address = getAddress(`0x${"0".repeat(38)}d0`);

const termSheet: TermSheet = {
  agentTreasury: getAddress(`0x${"1".repeat(40)}`),
  agentCard: getAddress(`0x${"2".repeat(40)}`),
  agentId: 42n,
  feesManager: getAddress(`0x${"3".repeat(40)}`),
  poolId: `0x${"ab".repeat(32)}` as Hex,
  expectedShares: 950000000000000000n,
  noteSupply: 1000000000000000000000n,
  floorCents: 80,
  minPrincipal: 500000000n,
  auctionBlocks: 1000n,
  drawLimit: 100000000n,
  drawPeriod: 86400n,
  gracePeriod: 1209600n,
  deadline: 2000000000n,
  nonce: 1n,
  memoHash: `0x${"cd".repeat(32)}` as Hex,
};

const signature = `0x${"ef".repeat(65)}` as Hex;

// `prepareApplication`/`encodeOpenLoanTx`/`encodeMoveBeneficiaryTx` only read `.termSheet` and
// `.signature` off an `ApproveDecision` — the rest of the (large) `Decision` shape is irrelevant
// to calldata encoding, so this fixture only fills what's actually used.
const decision = { kind: "approve", termSheet, signature } as unknown as ApproveDecision;

/** A `PublicClient` stub that only answers `predictEscrow` reads, for tests that never touch a
 * real chain — `predictEscrow`'s own correctness (an on-chain CREATE2 view) is covered by the
 * anvil-fork suite; this only needs it to prime `prepareApplication`'s escrow cache. */
function stubPublicClient(escrow: Address): PublicClient {
  return {
    async readContract(args: { functionName: string }) {
      if (args.functionName === "predictEscrow") return escrow;
      throw new Error(`stubPublicClient: unexpected readContract call ${args.functionName}`);
    },
  } as unknown as PublicClient;
}

describe("AdvanceClient.prepareApplication", () => {
  it("throws if predictEscrow(termSheet) was never called first", () => {
    const client = new AdvanceClient({
      chainId: 8453,
      apiUrl: "http://unused.invalid",
      publicClient: stubPublicClient(ESCROW),
      hub: HUB,
    });
    expect(() => client.prepareApplication(decision)).toThrow(/predictEscrow/);
  });

  it("produces openLoan calldata identical to the direct viem encoding", async () => {
    const client = new AdvanceClient({
      chainId: 8453,
      apiUrl: "http://unused.invalid",
      publicClient: stubPublicClient(ESCROW),
      hub: HUB,
    });
    await client.predictEscrow(decision.termSheet);

    const { openLoan } = client.prepareApplication(decision);

    expect(openLoan).toEqual({
      to: HUB,
      data: encodeFunctionData({
        abi: advanceHubAbi,
        functionName: "openLoan",
        args: [decision.termSheet, decision.signature],
      }),
      value: 0n,
    });
  });

  it("produces moveBeneficiary calldata identical to the direct viem encoding, targeting the predicted escrow", async () => {
    const client = new AdvanceClient({
      chainId: 8453,
      apiUrl: "http://unused.invalid",
      publicClient: stubPublicClient(ESCROW),
      hub: HUB,
    });
    const escrow = await client.predictEscrow(decision.termSheet);
    expect(escrow).toBe(ESCROW);

    const { moveBeneficiary } = client.prepareApplication(decision);

    expect(moveBeneficiary).toEqual({
      to: decision.termSheet.feesManager,
      data: encodeFunctionData({
        abi: dopplerFeesManagerAbi,
        functionName: "updateBeneficiary",
        args: [decision.termSheet.poolId, ESCROW],
      }),
      value: 0n,
    });
  });

  it("keys the escrow cache by term sheet struct hash, not call order", async () => {
    const otherEscrow: Address = getAddress(`0x${"0".repeat(38)}d1`);
    let call = 0;
    const client = new AdvanceClient({
      chainId: 8453,
      apiUrl: "http://unused.invalid",
      publicClient: {
        async readContract() {
          call++;
          return call === 1 ? ESCROW : otherEscrow;
        },
      } as unknown as PublicClient,
      hub: HUB,
    });

    await client.predictEscrow(termSheet);
    const otherTermSheet: TermSheet = { ...termSheet, nonce: 2n };
    await client.predictEscrow(otherTermSheet);

    const first = client.prepareApplication({ kind: "approve", termSheet, signature } as unknown as ApproveDecision);
    const second = client.prepareApplication({
      kind: "approve",
      termSheet: otherTermSheet,
      signature,
    } as unknown as ApproveDecision);

    expect(first.moveBeneficiary.data).not.toBe(second.moveBeneficiary.data);
  });
});
