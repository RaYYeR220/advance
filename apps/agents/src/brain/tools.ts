import { z } from "zod";

/**
 * The fixed tool menu exposed to an agent's model. Nothing here takes a payee or an amount - the
 * model can ask for paid data, ask what its runway looks like, or flag that it wants credit, and
 * that's the entire surface. Every actual money decision (whether to borrow, how much to draw) is
 * made by `brain/policy.ts`, never by an argument the model supplies - see `executeTool` in
 * `brain/loop.ts`.
 */
export const TOOL_NAMES = ["fetch_paid_data", "check_runway", "request_credit"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

const fetchPaidDataCall = z
  .object({
    type: z.literal("tool"),
    name: z.literal("fetch_paid_data"),
    // `.strict()`: any extra field (a payee, an amount, anything else injected content might try
    // to talk the model into adding) fails parsing outright rather than being silently dropped or
    // passed through - see the injection test in brain/loop.test.ts.
    args: z.object({ topic: z.string().min(1).max(64) }).strict(),
  })
  .strict();

const checkRunwayCall = z
  .object({
    type: z.literal("tool"),
    name: z.literal("check_runway"),
    args: z.object({}).strict(),
  })
  .strict();

const requestCreditCall = z
  .object({
    type: z.literal("tool"),
    name: z.literal("request_credit"),
    args: z.object({}).strict(),
  })
  .strict();

const finalAnswer = z
  .object({
    type: z.literal("final"),
    content: z.string().min(1),
  })
  .strict();

const modelResponseSchema = z.union([fetchPaidDataCall, checkRunwayCall, requestCreditCall, finalAnswer]);

export type ToolCall = z.infer<typeof fetchPaidDataCall> | z.infer<typeof checkRunwayCall> | z.infer<typeof requestCreditCall>;
export type FinalAnswer = z.infer<typeof finalAnswer>;
export type ModelResponse = ToolCall | FinalAnswer;

export type ParseModelResponseResult = { ok: true; value: ModelResponse } | { ok: false; reason: string };

/**
 * Parses one raw model completion (expected to be a JSON object - the LLM client forces
 * `response_format: json_object`) against the fixed tool/final-answer contract above. Never
 * throws: malformed JSON, an unknown tool name, or any extra argument field all come back as
 * `{ok:false}` instead of an exception, so a hostile or broken completion can only ever fail
 * closed - the loop logs the refusal and stops that work attempt, it never executes a
 * best-effort guess at what the model "probably meant".
 */
export function parseModelResponse(raw: string): ParseModelResponseResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "invalid_json" };
  }

  const result = modelResponseSchema.safeParse(json);
  if (!result.success) {
    return { ok: false, reason: "schema_mismatch" };
  }
  return { ok: true, value: result.data };
}

/** Tool menu description injected into the system prompt - documentation only; the actual
 * enforcement is {@link parseModelResponse}'s schema, not anything the model reads here. */
export const TOOL_MENU_DESCRIPTION = `Respond with exactly one JSON object, one of:
{"type":"tool","name":"fetch_paid_data","args":{"topic":"<short topic string>"}} - fetch a paid data snippet on that topic
{"type":"tool","name":"check_runway","args":{}} - see your current card balance and credit runway
{"type":"tool","name":"request_credit","args":{}} - flag that you may need more credit; the actual decision is made deterministically, not by you
{"type":"final","content":"<your finished output>"} - end the task with this output
No other fields are ever accepted, in particular no payee address and no amount - any tool that could move money takes none as an argument.`;
