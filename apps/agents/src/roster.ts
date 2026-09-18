import type { Address, Hex } from "viem";

/**
 * One autonomous borrower agent's fixed configuration: which persona it plays, which chain/pool
 * it earns from, which Dynamic-backed keys and on-chain card it acts through, and where its paid
 * LLM lives. Nothing here is secret - the keys themselves are resolved by label through
 * `DynamicKeys`, never held inline.
 */
export interface AgentRosterEntry {
  /** Unique name; also the `EventStore`/`EventSink` agent label for everything this agent does. */
  name: string;
  /** Short description of the agent's job, used to build its system prompt. */
  persona: string;
  chainId: number;
  /** The agent's own token (the Doppler pool's non-WETH leg) - what the underwriter scores. */
  token: Address;
  poolId: Hex;
  /** Doppler fees manager for `poolId`. */
  feesManager: Address;
  /** ERC-8004 agent id this roster entry registered as (see `registerAgent`). */
  agentId: bigint;
  /** `DynamicKeys` label for the agent treasury (borrower of record; signs `openLoan`). */
  treasuryLabel: string;
  /** `DynamicKeys` label for the card owner (signs x402 payments and `drawCredit`). */
  ownerLabel: string;
  /** The on-chain `AgentCard` this agent spends and draws credit through. */
  card: Address;
  /** Where this agent's paid LLM and paid data live. */
  llm: {
    /** OpenAI-compatible base URL for chat completions, paid via the card gateway. */
    url: string;
    model: string;
    /** Base URL for the paid data endpoint (`GET <dataUrl>/v1/data/:topic`). */
    dataUrl: string;
  };
  /** Base URL of the underwriter service this agent requests quotes from. */
  underwriterUrl: string;
}
