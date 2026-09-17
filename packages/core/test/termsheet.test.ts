import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getAddress, keccak256, toBytes } from "viem";
import { privateKeyToAddress } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  signTermSheet,
  termSheetDigest,
  termSheetDomain,
  termSheetStructHash,
  termSheetTypeString,
  termSheetTypes,
  verifyTermSheet,
  type TermSheet,
} from "../src/termsheet.js";

const EXPECTED_TYPE_STRING =
  "TermSheet(address agentTreasury,address agentCard,uint256 agentId,address feesManager,bytes32 poolId,uint256 expectedShares,uint256 noteSupply,uint16 floorCents,uint128 minPrincipal,uint64 auctionBlocks,uint128 drawLimit,uint64 drawPeriod,uint64 gracePeriod,uint64 deadline,uint256 nonce,bytes32 memoHash)";

const HUB = "0x00000000000000000000000000000000000A11CE" as const;
const CHAIN_ID = 8453;
const TEST_PRIVATE_KEY =
  "0x25c1a68a978b06379aa93931b26bef58b77c5fb7c64fd4bd5c93f490c085109c" as const;

const termSheet: TermSheet = {
  agentTreasury: "0x96C33027948124a63E885fc34C29692d5A898765",
  agentCard: "0x1111111111111111111111111111111111111111",
  agentId: 88336n,
  feesManager: "0xBDF938149ac6a781F94FAa0ed45E6A0e984c6544",
  poolId:
    "0x5e9782079683037fc8bb57625683359d9efaef80f2b829c4bb5b1896c6bb40b6",
  expectedShares: 950000000000000000n,
  noteSupply: 5000000000000000000n,
  floorCents: 80,
  minPrincipal: 2000000n,
  auctionBlocks: 500n,
  drawLimit: 250000n,
  drawPeriod: 86400n,
  gracePeriod: 1209600n,
  deadline: 1790000000n,
  nonce: 1n,
  memoHash: keccak256(toBytes("advance-vector")),
};

const vectorPath = resolve(
  import.meta.dirname,
  "../../../contracts/test/vectors/termsheet.json",
);
const vectorExists = existsSync(vectorPath);

describe("termsheet", () => {
  it("typehash string matches the canonical TermSheet EIP-712 type string verbatim", () => {
    expect(termSheetTypeString).toBe(EXPECTED_TYPE_STRING);
  });

  it("has a single TermSheet type entry in field order", () => {
    expect(termSheetTypes).toEqual({
      TermSheet: [
        { name: "agentTreasury", type: "address" },
        { name: "agentCard", type: "address" },
        { name: "agentId", type: "uint256" },
        { name: "feesManager", type: "address" },
        { name: "poolId", type: "bytes32" },
        { name: "expectedShares", type: "uint256" },
        { name: "noteSupply", type: "uint256" },
        { name: "floorCents", type: "uint16" },
        { name: "minPrincipal", type: "uint128" },
        { name: "auctionBlocks", type: "uint64" },
        { name: "drawLimit", type: "uint128" },
        { name: "drawPeriod", type: "uint64" },
        { name: "gracePeriod", type: "uint64" },
        { name: "deadline", type: "uint64" },
        { name: "nonce", type: "uint256" },
        { name: "memoHash", type: "bytes32" },
      ],
    });
  });

  it("domain uses Advance / version 1 / given chainId and hub", () => {
    expect(termSheetDomain(CHAIN_ID, HUB)).toEqual({
      name: "Advance",
      version: "1",
      chainId: CHAIN_ID,
      // EIP-55 checksum of HUB — same 20 bytes, canonical casing.
      verifyingContract: getAddress(HUB),
    });
  });

  it("computes a stable struct hash and digest, and signs/recovers", async () => {
    const structHash = termSheetStructHash(termSheet);
    const digest = termSheetDigest(termSheet, CHAIN_ID, HUB);

    expect(structHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(digest).toMatch(/^0x[0-9a-f]{64}$/);

    console.log("TermSheet vector structHash:", structHash);
    console.log("TermSheet vector digest:", digest);

    const signature = await signTermSheet(
      termSheet,
      CHAIN_ID,
      HUB,
      TEST_PRIVATE_KEY,
    );
    const signerAddress = privateKeyToAddress(TEST_PRIVATE_KEY);

    const isValid = await verifyTermSheet(
      termSheet,
      CHAIN_ID,
      HUB,
      signature,
      signerAddress,
    );
    expect(isValid).toBe(true);

    const isInvalid = await verifyTermSheet(
      termSheet,
      CHAIN_ID,
      HUB,
      signature,
      "0x2222222222222222222222222222222222222222",
    );
    expect(isInvalid).toBe(false);
  });

  it.skipIf(!vectorExists)(
    "digest matches the contracts cross-check vector",
    () => {
      const vector = JSON.parse(readFileSync(vectorPath, "utf8")) as {
        digest: string;
      };
      const digest = termSheetDigest(termSheet, CHAIN_ID, HUB);
      expect(digest).toBe(vector.digest);
    },
  );
});
