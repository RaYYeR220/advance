import type { Address, Hex } from "viem";
import type { LlmClient, LlmMessage, TermSheet } from "@advance/core";
import type { AgentEvent, EventSink } from "@advance/agent-kit";
import type { AgentRosterEntry } from "../roster.js";
import { PRICE_ATOMIC_USDC } from "../services/x402-llm.js";
import { computeBurnRate, decideRunwayAction, DEFAULT_RUNWAY_MIN_TICKS, type RunwayDecision } from "./policy.js";
import { parseModelResponse, TOOL_MENU_DESCRIPTION, type ToolCall } from "./tools.js";

const DEFAULT_MAX_TOOL_ITERATIONS = 6;
const DEFAULT_TASK_COST_USDC = BigInt(PRICE_ATOMIC_USDC);

/** Read-only chain facts the runway policy needs about one agent's card. Production reads these
 * off-chain (`AgentCard`/`AdvanceHub`/`CreditLine`); tests supply fixed fixtures. */
export interface LoopChainReader {
  cardUsdcBalance(card: Address): Promise<bigint>;
  /** The card's currently active loan, if any - `undefined` once repaid/defaulted-and-closed or
   * before any loan has ever opened. */
  activeLoan(card: Address): Promise<{ loanId: bigint; creditLine: Address } | undefined>;
  /** `CreditLine.availableThisPeriod()`. */
  creditLineAvailable(creditLine: Address): Promise<bigint>;
}

/** The only state-changing calls the loop's code policy can make, already bound to one agent's
 * labels/card/pool - deliberately thin (no payee, no free amount beyond what the deterministic
 * policy itself computed) so `tick` never touches viem. See `createLiveLoopActions` for the real
 * wiring over `@advance/agent-kit`. */
export interface LoopActions {
  predictEscrow(termSheet: TermSheet): Promise<Address>;
  moveBeneficiary(params: { to: Address }): Promise<void>;
  openLoan(params: { termSheet: TermSheet; signature: Hex }): Promise<{ loanId: bigint }>;
  drawCredit(params: { creditLine: Address; amount: bigint }): Promise<void>;
}

export interface LoopDeps {
  chain: LoopChainReader;
  actions: LoopActions;
  /** Refusals/denials/work output are logged here. The underlying `moveBeneficiary`/`openLoan`/
   * `drawCredit` calls already log their own success events in production (see
   * `@advance/agent-kit`'s `chain/actions.ts`) - this never duplicates those. */
  events: EventSink;
  /** This agent's own past events, for {@link computeBurnRate} - normally `await
   * eventStore.list()` filtered ahead of time, or the whole list (burn rate filters by agent
   * itself). */
  pastEvents: readonly AgentEvent[];
  /** Plain (never card-gated) fetch to the underwriter's `/v1/quote` - that endpoint isn't paid. */
  underwriterFetch: typeof fetch;
  /** Already wired through the card gateway (see `brain/llm.ts`) - every completion is itself a
   * paid call. */
  llm: LlmClient;
  /** Also card-gated - used only by the `fetch_paid_data` tool. */
  dataFetch: typeof fetch;
  now?: () => number;
  taskCostUsdc?: bigint;
  runwayMinTicks?: number;
  maxToolIterations?: number;
}

export type WorkResult = { status: "done"; content: string } | { status: "incomplete"; reason: string };

export interface TickResult {
  runwayDecision: RunwayDecision;
  borrowed?: { loanId: bigint };
  drew?: { amount: bigint };
  work: WorkResult;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

interface Snapshot {
  balance: bigint;
  active: { loanId: bigint; creditLine: Address } | undefined;
  available: bigint;
  burnRate: bigint;
}

async function observe(agent: AgentRosterEntry, deps: LoopDeps): Promise<Snapshot> {
  const [balance, active] = await Promise.all([deps.chain.cardUsdcBalance(agent.card), deps.chain.activeLoan(agent.card)]);
  const available = active ? await deps.chain.creditLineAvailable(active.creditLine) : 0n;
  const burnRate = computeBurnRate(deps.pastEvents, agent.name);
  return { balance, active, available, burnRate };
}

function termSheetFromJson(json: Record<string, unknown>): TermSheet {
  const str = (key: string): string => {
    const value = json[key];
    if (typeof value !== "string") throw new Error(`termSheetFromJson: field "${key}" is not a string`);
    return value;
  };
  return {
    agentTreasury: str("agentTreasury") as Address,
    agentCard: str("agentCard") as Address,
    agentId: BigInt(str("agentId")),
    feesManager: str("feesManager") as Address,
    poolId: str("poolId") as Hex,
    expectedShares: BigInt(str("expectedShares")),
    noteSupply: BigInt(str("noteSupply")),
    floorCents: Number(json["floorCents"]),
    minPrincipal: BigInt(str("minPrincipal")),
    auctionBlocks: BigInt(str("auctionBlocks")),
    drawLimit: BigInt(str("drawLimit")),
    drawPeriod: BigInt(str("drawPeriod")),
    gracePeriod: BigInt(str("gracePeriod")),
    deadline: BigInt(str("deadline")),
    nonce: BigInt(str("nonce")),
    memoHash: str("memoHash") as Hex,
  };
}

/**
 * Requests a signed term sheet from the underwriter and, only on approval, opens the loan.
 * Nothing here ever invents a payee or an amount: the term sheet is the underwriter's own signed
 * output, re-checked here only for internal consistency (it must actually be for this agent's
 * card) before `openLoan` is asked to spend gas on it - the hub itself would reject a mismatched
 * treasury anyway, this just fails faster and logs why.
 */
async function attemptBorrow(agent: AgentRosterEntry, deps: LoopDeps): Promise<{ loanId: bigint } | undefined> {
  let response: Response;
  try {
    response = await deps.underwriterFetch(`${agent.underwriterUrl}/v1/quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: agent.token, agentCard: agent.card, agentId: agent.agentId.toString(), chainId: agent.chainId }),
    });
  } catch (err) {
    await deps.events.append({
      agent: agent.name,
      kind: "borrow_failed",
      data: { reason: "quote_request_failed", message: errorMessage(err) },
    });
    return undefined;
  }

  let body: Record<string, unknown>;
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    await deps.events.append({ agent: agent.name, kind: "borrow_failed", data: { reason: "quote_response_invalid" } });
    return undefined;
  }

  if (body["kind"] !== "approve") {
    await deps.events.append({ agent: agent.name, kind: "borrow_denied", data: { reasons: body["reasons"] ?? [] } });
    return undefined;
  }

  let termSheet: TermSheet;
  try {
    termSheet = termSheetFromJson(body["termSheet"] as Record<string, unknown>);
  } catch (err) {
    await deps.events.append({
      agent: agent.name,
      kind: "borrow_failed",
      data: { reason: "quote_term_sheet_invalid", message: errorMessage(err) },
    });
    return undefined;
  }

  if (!sameAddress(termSheet.agentCard, agent.card)) {
    await deps.events.append({ agent: agent.name, kind: "borrow_refused", data: { reason: "term_sheet_card_mismatch" } });
    return undefined;
  }

  const signature = body["signature"] as Hex;
  const predicted = await deps.actions.predictEscrow(termSheet);
  await deps.actions.moveBeneficiary({ to: predicted });
  const { loanId } = await deps.actions.openLoan({ termSheet, signature });
  return { loanId };
}

interface RunwayOutcome {
  decision: RunwayDecision;
  borrowed?: { loanId: bigint };
  drew?: { amount: bigint };
}

/**
 * The deterministic credit policy itself: observe, decide, act. Run unconditionally once per
 * tick, and again (idempotently - `decideRunwayAction` re-reads fresh state every time) whenever
 * the model's `request_credit` tool fires. Money only ever moves through this function, never
 * through anything the model's output supplies directly.
 */
async function runRunwayPolicy(agent: AgentRosterEntry, deps: LoopDeps, snapshot: Snapshot): Promise<RunwayOutcome> {
  const taskCostUsdc = deps.taskCostUsdc ?? DEFAULT_TASK_COST_USDC;
  const runwayMinTicks = deps.runwayMinTicks ?? DEFAULT_RUNWAY_MIN_TICKS;

  const decision = decideRunwayAction(
    {
      cardUsdcBalance: snapshot.balance,
      burnRatePerTick: snapshot.burnRate,
      hasActiveLoan: snapshot.active !== undefined,
      creditLineAvailable: snapshot.available,
    },
    { taskCostUsdc, runwayMinTicks },
  );

  if (decision.action === "borrow") {
    const borrowed = await attemptBorrow(agent, deps);
    return { decision, borrowed };
  }

  if (decision.action === "draw" && snapshot.active) {
    await deps.actions.drawCredit({ creditLine: snapshot.active.creditLine, amount: decision.amount });
    return { decision, drew: { amount: decision.amount } };
  }

  return { decision };
}

async function executeTool(call: ToolCall, agent: AgentRosterEntry, deps: LoopDeps): Promise<unknown> {
  if (call.name === "fetch_paid_data") {
    try {
      const url = `${agent.llm.dataUrl}/v1/data/${encodeURIComponent(call.args.topic)}`;
      const response = await deps.dataFetch(url);
      const body = await response.json().catch(() => undefined);
      // The response body - including any adversarial content a red-team probe embedded in it -
      // is handed back to the model completely unchanged. Enforcement lives in `parseModelResponse`
      // on the *next* completion, not in filtering what the model gets to read here.
      return { ok: response.ok, status: response.status, body };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  }

  if (call.name === "check_runway") {
    const snapshot = await observe(agent, deps);
    return {
      cardUsdcBalance: snapshot.balance.toString(),
      hasActiveLoan: snapshot.active !== undefined,
      creditLineAvailable: snapshot.available.toString(),
      burnRatePerTick: snapshot.burnRate.toString(),
    };
  }

  // request_credit
  const snapshot = await observe(agent, deps);
  const outcome = await runRunwayPolicy(agent, deps, snapshot);
  return {
    action: outcome.decision.action,
    // Stringified explicitly: these carry raw bigints, and a bare `JSON.stringify` on a bigint
    // throws - this result is about to go straight into one.
    borrowed: outcome.borrowed ? { loanId: outcome.borrowed.loanId.toString() } : undefined,
    drew: outcome.drew ? { amount: outcome.drew.amount.toString() } : undefined,
  };
}

/**
 * Drives the model through a bounded tool-call loop to do the agent's actual work. The model
 * chooses among exactly three tools (see `brain/tools.ts`) plus a final answer; every response is
 * parsed against a strict schema that rejects any extra field (in particular a payee or an
 * amount) before it is ever acted on. A malformed/off-menu response, a failed completion, or
 * exhausting `maxToolIterations` without a final answer all end the attempt as `"incomplete"`
 * rather than guessing - this never throws.
 */
async function doWork(agent: AgentRosterEntry, deps: LoopDeps): Promise<WorkResult> {
  const maxIterations = deps.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS;
  const messages: LlmMessage[] = [
    { role: "system", content: `You are ${agent.name}: ${agent.persona}\n\n${TOOL_MENU_DESCRIPTION}` },
    { role: "user", content: "Do your task now." },
  ];

  for (let i = 0; i < maxIterations; i++) {
    let raw: string;
    try {
      raw = await deps.llm.complete(messages);
    } catch (err) {
      await deps.events.append({
        agent: agent.name,
        kind: "work_failed",
        data: { reason: "llm_request_failed", message: errorMessage(err) },
      });
      return { status: "incomplete", reason: "llm_request_failed" };
    }

    const parsed = parseModelResponse(raw);
    if (!parsed.ok) {
      await deps.events.append({ agent: agent.name, kind: "refusal", data: { layer: "brain", reason: parsed.reason } });
      return { status: "incomplete", reason: parsed.reason };
    }

    if (parsed.value.type === "final") {
      await deps.events.append({ agent: agent.name, kind: "work_output", data: { content: parsed.value.content } });
      return { status: "done", content: parsed.value.content };
    }

    messages.push({ role: "assistant", content: raw });
    const toolResult = await executeTool(parsed.value, agent, deps);
    messages.push({ role: "user", content: JSON.stringify(toolResult) });
  }

  await deps.events.append({ agent: agent.name, kind: "work_incomplete", data: { reason: "max_tool_iterations" } });
  return { status: "incomplete", reason: "max_tool_iterations" };
}

/**
 * One agent tick: observe (card balance, credit availability, burn rate), let the deterministic
 * runway policy borrow or draw if needed (never the model), then do the agent's actual work
 * through the card gateway. Never throws - every failure mode inside `attemptBorrow`/`doWork` is
 * caught and logged as an event instead.
 */
export async function tick(agent: AgentRosterEntry, deps: LoopDeps): Promise<TickResult> {
  const snapshot = await observe(agent, deps);
  const policyOutcome = await runRunwayPolicy(agent, deps, snapshot);
  const work = await doWork(agent, deps);

  const result: TickResult = { runwayDecision: policyOutcome.decision, work };
  if (policyOutcome.borrowed) result.borrowed = policyOutcome.borrowed;
  if (policyOutcome.drew) result.drew = policyOutcome.drew;
  return result;
}
