/**
 * Manual, one-off mainnet probe (not part of the automated test suite): does Bankr's LLM-gateway
 * x402 facilitator accept a contract (ERC-1271) payer? Pays the gateway's own quoted price
 * (0.001 USDC) from the mainnet AgentCard documented in `docs/PROOF.md` -> Mainnet AgentCard.
 * Result recorded there: HTTP 500, no settlement, question left open (not answered either way).
 *
 * Usage (from `packages/agent-kit`):
 *   BASE_RPC_URL=... CARD_OWNER_PRIVATE_KEY=0x... node scripts/gateway-card-payer.mjs
 *
 * CARD_OWNER_PRIVATE_KEY must be the card's own owner key (see the mainnet AgentCard's `owner()`)
 * — never a real key with meaningful funds beyond what this test is willing to spend.
 */
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { createCardFetch, isGatewayRefusalResponse } from "@advance/agent-kit";

const RPC = process.env.BASE_RPC_URL;
const CARD = "0x4958a4ADbf75AF01dBeE5c2AED5aAcD391c4bdd9";
const OWNER_KEY = process.env.CARD_OWNER_PRIVATE_KEY;
const URL = "https://x402.bankr.bot/0xcea8f39419541e6ac9efbdd37b60657b4093ef08/compute/v1/chat/completions";

const owner = privateKeyToAccount(OWNER_KEY);
const chain = createPublicClient({ chain: base, transport: http(RPC) });

const keys = {
  async signTypedData(_label, typedData) {
    return owner.signTypedData(typedData);
  },
};

const events = { append: async (e) => console.log("EVENT", e.kind, JSON.stringify(e.data ?? {}).slice(0, 300)) };

const cardFetch = createCardFetch({ agent: "gate-test", card: CARD, keys, events, chain });

const res = await cardFetch(URL, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model: "auto",
    messages: [{ role: "user", content: "Reply with exactly: advance gate test ok" }],
    max_tokens: 20,
  }),
});

console.log("status", res.status, "gatewayRefusal", isGatewayRefusalResponse(res));
const text = await res.text();
console.log("body", text.slice(0, 800));
for (const [k, v] of res.headers.entries()) {
  if (/payment|x-payment/i.test(k)) console.log("header", k, v.slice(0, 300));
}
