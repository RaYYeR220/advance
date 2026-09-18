/**
 * Manual, one-off control for `gateway-card-payer.mjs` (not part of the automated test suite):
 * same Bankr LLM gateway, same 0.001 USDC amount, but an ordinary EOA payer instead of the
 * ERC-1271 AgentCard. Result recorded in `docs/PROOF.md` -> Mainnet AgentCard: HTTP 500, no
 * settlement here either — the same failure the card payer hit, so it is the gateway's own bug,
 * not something specific to a contract payer.
 *
 * Usage (from `packages/agent-kit`):
 *   DEPLOYER_PRIVATE_KEY=0x... node scripts/gateway-control-eoa.mjs
 *
 * DEPLOYER_PRIVATE_KEY just needs to be any EOA holding a little USDC on Base mainnet — it does
 * not need to be a real deployer key.
 */
import { privateKeyToAccount } from "viem/accounts";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";

const account = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY);
const URL = "https://x402.bankr.bot/0xcea8f39419541e6ac9efbdd37b60657b4093ef08/compute/v1/chat/completions";
const body = JSON.stringify({ model: "auto", messages: [{ role: "user", content: "Reply with exactly: ok" }], max_tokens: 10 });

const first = await fetch(URL, { method: "POST", headers: { "content-type": "application/json" }, body });
console.log("unpaid status", first.status);
const req = await first.json();
console.log("requirements", JSON.stringify(req).slice(0, 400));

const client = new x402Client();
registerExactEvmScheme(client, { signer: { address: account.address, signTypedData: (td) => account.signTypedData(td) } });
const payload = await client.createPaymentPayload(req);
const header = client.encodePayment ? client.encodePayment(payload) : Buffer.from(JSON.stringify(payload)).toString("base64");
const res = await fetch(URL, { method: "POST", headers: { "content-type": "application/json", "X-PAYMENT": header }, body });
console.log("paid status", res.status);
console.log("body", (await res.text()).slice(0, 500));
