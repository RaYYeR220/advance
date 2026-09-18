import type { Address, Hex } from "viem";
import type { AgentEvent } from "./events";
import { isAddress } from "./format";

/**
 * Grouping and plain-language copy for the loan page's refusal exhibits — every off-chain
 * `refusal` event, bucketed by the layer that refused it. Pure: takes already-fetched
 * `AgentEvent`s, no I/O, so it's exercised directly with fixtures in tests.
 */

export const REFUSAL_LAYERS = ["gateway", "card-1271", "credit-line", "dynamic"] as const;
export type RefusalLayer = (typeof REFUSAL_LAYERS)[number];

function isRefusalLayer(value: unknown): value is RefusalLayer {
  return typeof value === "string" && (REFUSAL_LAYERS as readonly string[]).includes(value);
}

export interface RefusalLayerCopy {
  /** Short, plain-language name for the layer, as a reader with no protocol background would
   * recognize it. */
  title: string;
  /** What this layer is and how it enforces, in one or two sentences. */
  mechanism: string;
}

export const REFUSAL_LAYER_COPY: Record<RefusalLayer, RefusalLayerCopy> = {
  gateway: {
    title: "Gateway precheck",
    mechanism: "The spend gateway checks every outbound request against the card's policy before it ever reaches a signature.",
  },
  "card-1271": {
    title: "Card signature (ERC-1271)",
    mechanism: "The agent card is a smart-contract wallet; its own on-chain signature check refuses to sign a payment to a payee off its allowlist.",
  },
  "credit-line": {
    title: "Credit line",
    mechanism: "The CreditLine contract reverts any draw over the period's limit or against a loan that isn't active, no matter who calls it.",
  },
  dynamic: {
    title: "Wallet policy",
    mechanism: "The card's signing service enforces its own policy at the wallet layer, independent of what the agent's contract would otherwise allow.",
  },
};

export interface LoanRefusal {
  id: string;
  timestamp: number;
  layer: RefusalLayer;
  reason: string;
  payTo?: Address;
  amount?: string;
  txHash?: Hex;
}

/** Reads one `refusal` agent event into a `LoanRefusal`, or `undefined` when it can't be
 * attributed to a recognized layer or carries no plain-language reason — never a fabricated
 * "unknown" bucket standing in for a refusal this page can't actually explain. */
export function toLoanRefusal(event: AgentEvent): LoanRefusal | undefined {
  if (event.type !== "refusal") return undefined;
  const layer = event.data.layer;
  if (!isRefusalLayer(layer)) return undefined;
  const reason = event.data.reason;
  if (typeof reason !== "string" || reason.length === 0) return undefined;

  const payToRaw = event.data.payTo;
  const payTo = typeof payToRaw === "string" && isAddress(payToRaw) ? payToRaw : undefined;

  const amountRaw = event.data.amount;
  const amount = typeof amountRaw === "string" ? amountRaw : typeof amountRaw === "number" ? String(amountRaw) : undefined;

  return { id: event.id, timestamp: event.timestamp, layer, reason, payTo, amount, txHash: event.txHash };
}

export type RefusalsByLayer = Record<RefusalLayer, LoanRefusal[]>;

/** Every recognizable refusal, bucketed by layer and sorted newest first within each bucket.
 * Every layer key is always present (possibly empty) so a page can render an honest "none
 * recorded" line for a layer that has never refused anything. */
export function groupRefusalsByLayer(events: readonly AgentEvent[]): RefusalsByLayer {
  const grouped: RefusalsByLayer = { gateway: [], "card-1271": [], "credit-line": [], dynamic: [] };
  for (const event of events) {
    const refusal = toLoanRefusal(event);
    if (refusal) grouped[refusal.layer].push(refusal);
  }
  for (const layer of REFUSAL_LAYERS) {
    grouped[layer].sort((a, b) => b.timestamp - a.timestamp);
  }
  return grouped;
}

/** Total refusals recorded across every layer. */
export function totalRefusals(grouped: RefusalsByLayer): number {
  return REFUSAL_LAYERS.reduce((sum, layer) => sum + grouped[layer].length, 0);
}
