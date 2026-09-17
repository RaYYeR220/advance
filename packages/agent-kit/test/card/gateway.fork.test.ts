import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, createWalletClient, erc20Abi, http, type Address, type Hex, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme as registerClientScheme } from "@x402/evm/exact/client";
import type { Network, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { createCardFetch } from "../../src/card/gateway.js";
import { cardSigner } from "../../src/card/signer.js";
import { EventStore } from "../../src/events.js";
import { FileStore } from "../../src/store.js";
import type { EvmTypedData } from "../../src/dynamic.js";
import { startAnvilFork, type AnvilFork } from "../helpers/anvil-fork.js";
import { createInProcessFacilitator } from "../helpers/in-process-facilitator.js";

// This suite forks live Base mainnet, so it only runs with BASE_RPC_URL set (see
// internal/.env, never printed/committed) - unset, it self-skips like every other
// fork suite in this repo.
const BASE_RPC_URL = process.env.BASE_RPC_URL;
const describeIfFork = BASE_RPC_URL ? describe : describe.skip;

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
// Real payTo captured from Bankr's live x402 402 response (internal/spikes/card1271-x402/bankr-402.json).
const BANKR_PAYTO = "0x8AEE621035D93Deb3C0C1177fac252dC2dd501a0" as Address;
const OTHER_TEST_PAYEE = "0x2222222222222222222222222222222222222222" as Address;
const EVIL = "0x000000000000000000000000000000000000dEaD" as Address;
const NETWORK: Network = "eip155:8453";
const PER_CALL_CAP = 10_000n; // 0.01 USDC atomic units, matching the spike's cap.
const MAX_AUTH_WINDOW = 3600n;

const here = dirname(fileURLToPath(import.meta.url));
const artifactPath = resolve(here, "../../../../contracts/out/AgentCard.sol/AgentCard.json");

interface ForgeArtifact {
  abi: readonly unknown[];
  bytecode: { object: Hex };
}

function loadArtifact(): ForgeArtifact {
  try {
    return JSON.parse(readFileSync(artifactPath, "utf8")) as ForgeArtifact;
  } catch (err) {
    throw new Error(
      `gateway.fork.test: could not read ${artifactPath} - run "forge build" in contracts/ first (${String(err)})`,
    );
  }
}

/** Wraps a local viem account behind the exact interface `cardSigner`/`createCardFetch`
 * need from Dynamic (`signTypedData(label, typedData) -> Hex`) - the fake Dynamic
 * client the brief calls for, standing in for a real MPC-signed owner key. */
function fakeKeysFor(account: ReturnType<typeof privateKeyToAccount>) {
  return {
    async signTypedData(_label: string, typedData: EvmTypedData): Promise<Hex> {
      return account.signTypedData(typedData as never);
    },
  };
}

describeIfFork("card gateway (anvil fork of Base mainnet + in-process x402 facilitator)", () => {
  let fork: AnvilFork;
  let publicClient: PublicClient;
  let owner: ReturnType<typeof privateKeyToAccount>;
  let card: Address;
  let facilitator: ReturnType<typeof createInProcessFacilitator>["facilitator"];
  let eventsDir: string;
  let events: EventStore;

  beforeAll(async () => {
    const artifact = loadArtifact();
    fork = await startAnvilFork(BASE_RPC_URL!, 8557);
    // Cast needed only for TS type identity: `@advance/core` pulls in its own
    // separately-installed `viem` instance (a pnpm peer-resolution artifact, not a
    // real version skew - both are viem 2.56.6), so `viem/chains`' op-stack
    // augmentation of `base` gets declared twice in this compilation and the two
    // resulting `PublicClient<...>` instantiations don't structurally unify. The
    // runtime object underneath is an ordinary, correctly-configured PublicClient.
    publicClient = createPublicClient({ chain: base, transport: http(fork.rpcUrl) }) as PublicClient;

    const deployer = privateKeyToAccount(generatePrivateKey());
    const relayer = privateKeyToAccount(generatePrivateKey());
    owner = privateKeyToAccount(generatePrivateKey());
    await fork.setBalance(deployer.address, 10n ** 18n);
    await fork.setBalance(relayer.address, 10n ** 18n);

    const deployerClient = createWalletClient({ account: deployer, chain: base, transport: http(fork.rpcUrl) });
    const deployHash = await deployerClient.deployContract({
      abi: artifact.abi,
      bytecode: artifact.bytecode.object,
      args: [owner.address, deployer.address, USDC, PER_CALL_CAP, MAX_AUTH_WINDOW, [BANKR_PAYTO, OTHER_TEST_PAYEE]],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
    card = receipt.contractAddress!;

    await fork.setUsdcBalance(USDC, card, 1_000_000n); // 1 USDC (6 decimals)

    facilitator = createInProcessFacilitator({ rpcUrl: fork.rpcUrl, network: NETWORK, relayer }).facilitator;

    eventsDir = mkdtempSync(join(tmpdir(), "agent-kit-gateway-fork-"));
    events = new EventStore(new FileStore(eventsDir));
  }, 60_000);

  afterAll(async () => {
    await fork?.stop();
    if (eventsDir) rmSync(eventsDir, { recursive: true, force: true });
  });

  /** A minimal paid resource, backed by the real in-process facilitator and the
   * real anvil-forked chain - exactly what `createCardFetch` is meant to pay. */
  function paidResourceFetch(payTo: Address, amount = "1000"): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const requirement: PaymentRequirements = {
        scheme: "exact",
        network: NETWORK,
        asset: USDC,
        amount,
        payTo,
        maxTimeoutSeconds: 60,
        extra: { name: "USD Coin", version: "2" },
      };
      const sigHeader = request.headers.get("PAYMENT-SIGNATURE");
      if (!sigHeader) {
        const paymentRequired: PaymentRequired = {
          x402Version: 2,
          resource: { url: request.url },
          accepts: [requirement],
        };
        return new Response(null, {
          status: 402,
          headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired) },
        });
      }

      const paymentPayload = decodePaymentSignatureHeader(sigHeader);
      const verifyResult = await facilitator.verify(paymentPayload, requirement);
      if (!verifyResult.isValid) {
        return new Response(JSON.stringify({ error: verifyResult.invalidReason }), { status: 402 });
      }
      const settleResult = await facilitator.settle(paymentPayload, requirement);
      if (!settleResult.success) {
        return new Response(JSON.stringify({ error: settleResult.errorReason }), { status: 402 });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json", "PAYMENT-RESPONSE": encodePaymentResponseHeader(settleResult) },
      });
    }) as typeof fetch;
  }

  it(
    "pays an allowlisted payee end to end: signs, settles on-chain, and logs a receipt",
    async () => {
      const keys = fakeKeysFor(owner);
      const cardFetch = createCardFetch({
        agent: "agent-fork",
        card,
        keys,
        events,
        chain: publicClient,
        fetchImpl: paidResourceFetch(BANKR_PAYTO),
      });

      const before = await publicClient.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [BANKR_PAYTO],
      });

      const res = await cardFetch("https://service.example/resource");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });

      const after = await publicClient.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [BANKR_PAYTO],
      });
      expect(after - before).toEqual(1000n);

      const all = await events.list();
      const receipts = all.filter((e) => e.kind === "receipt");
      expect(receipts).toHaveLength(1);
      expect(receipts[0]!.data).toMatchObject({ payTo: BANKR_PAYTO, amount: "1000" });
      expect(receipts[0]!.txHash).toBeDefined();
    },
    30_000,
  );

  it(
    "refuses a non-allowlisted payee at the gateway, before any signature is requested and with no on-chain effect",
    async () => {
      let signCalls = 0;
      const realKeys = fakeKeysFor(owner);
      const spyKeys = {
        async signTypedData(label: string, typedData: EvmTypedData): Promise<Hex> {
          signCalls += 1;
          return realKeys.signTypedData(label, typedData);
        },
      };

      const cardFetch = createCardFetch({
        agent: "agent-fork",
        card,
        keys: spyKeys,
        events,
        chain: publicClient,
        fetchImpl: paidResourceFetch(EVIL),
      });

      const before = await publicClient.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [card],
      });

      const res = await cardFetch("https://service.example/resource");
      expect(res.status).toBe(402);
      expect(await res.json()).toEqual({ refused: true, reason: "payee_not_allowlisted" });
      expect(signCalls).toEqual(0);

      const after = await publicClient.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [card],
      });
      expect(after).toEqual(before);

      const all = await events.list();
      expect(all.some((e) => e.kind === "refusal" && e.data["reason"] === "payee_not_allowlisted")).toBe(true);
    },
    30_000,
  );

  it(
    "forced bypass: skipping the gateway entirely and asking the facilitator to settle a non-allowlisted blob still fails on-chain",
    async () => {
      const bypassClient = new x402Client();
      const bypassSigner = cardSigner(card, "agent-fork", { keys: fakeKeysFor(owner), usdc: USDC });
      registerClientScheme(bypassClient, { signer: bypassSigner, networks: [NETWORK] });

      const requirement: PaymentRequirements = {
        scheme: "exact",
        network: NETWORK,
        asset: USDC,
        amount: "1000",
        payTo: EVIL,
        maxTimeoutSeconds: 60,
        extra: { name: "USD Coin", version: "2" },
      };
      const paymentRequired: PaymentRequired = {
        x402Version: 2,
        resource: { url: "https://bypass.example/resource" },
        accepts: [requirement],
      };

      // cardSigner itself does not enforce the payee allowlist - only the gateway's
      // precheck and the card contract do - so this succeeds in producing a payload.
      const payload = await bypassClient.createPaymentPayload(paymentRequired);

      const verifyResult = await facilitator.verify(payload, requirement);
      expect(verifyResult.isValid).toBe(false);
      expect(verifyResult.invalidReason).toEqual("invalid_exact_evm_signature");

      const settleResult = await facilitator.settle(payload, requirement);
      expect(settleResult.success).toBe(false);
      expect(settleResult.errorReason).toEqual("invalid_exact_evm_signature");
    },
    30_000,
  );
});
