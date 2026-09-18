import { x402Facilitator } from "@x402/core/facilitator";
import type { FacilitatorClient } from "@x402/core/server";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { registerExactEvmScheme } from "@x402/evm/exact/facilitator";
import { createWalletClient, http, publicActions, type Account, type Address } from "viem";
import { baseSepolia } from "viem/chains";
import type { Network, SupportedResponse } from "@x402/core/types";

/**
 * A real x402 facilitator (verify + on-chain settle) running in-process against an anvil
 * fork, wrapped as a `FacilitatorClient` so the Hono resource server can call it directly
 * without any HTTP hop — the reference-facilitator pattern used for testing every paid
 * x402 route in this repo.
 */
export function createInProcessFacilitator(params: {
  rpcUrl: string;
  network: Network;
  relayer: Account;
}): FacilitatorClient {
  const relayerClient = createWalletClient({
    account: params.relayer,
    chain: baseSepolia,
    transport: http(params.rpcUrl),
  }).extend(publicActions);

  const signer = toFacilitatorEvmSigner({
    address: params.relayer.address as Address,
    getCode: (a) => relayerClient.getCode(a),
    readContract: (a) => relayerClient.readContract({ ...a, args: a.args ?? [] } as never),
    verifyTypedData: (a) => relayerClient.verifyTypedData(a as never),
    writeContract: (a) => relayerClient.writeContract({ ...a, args: a.args ?? [] } as never),
    sendTransaction: (a) => relayerClient.sendTransaction(a as never),
    waitForTransactionReceipt: (a) => relayerClient.waitForTransactionReceipt(a),
  });

  const facilitator = new x402Facilitator();
  registerExactEvmScheme(facilitator, { signer, networks: params.network });

  return {
    verify: (payload, requirements) => facilitator.verify(payload, requirements),
    settle: (payload, requirements) => facilitator.settle(payload, requirements),
    getSupported: async () => facilitator.getSupported() as unknown as SupportedResponse,
  };
}
