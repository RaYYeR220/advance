import { toJsonSafe } from "./json.js";

/** The shape every tool in this server returns: MCP `CallToolResult`, kept loose here (rather
 * than importing the SDK's own type) since only `content`/`isError` are ever set. The index
 * signature matches `CallToolResult`'s own (`[x: string]: unknown`), which `registerTool`'s
 * handler type requires structurally. */
export interface ToolResult {
  [x: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/** A successful read or write result: `value` (bigints as decimal strings) as pretty JSON text. */
export function jsonResult(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(toJsonSafe(value), null, 2) }] };
}

/** A stable, machine-parseable failure — used for confirmation/signer/validation errors that an
 * agent should branch on programmatically rather than parse from prose. `isError: true` also
 * marks the MCP result itself as an error, so a client surfaces it as one without re-parsing. */
export function errorResult(code: string, message: string, extra?: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ ok: false, error: code, message, ...extra }, null, 2) }],
    isError: true,
  };
}

/** Never let an RPC URL (or anything that looks like one) reach a tool's error text — mirrors
 * `@advance/core`'s own `redactSecrets` convention for the same reason. */
function redactUrls(message: string): string {
  return message.replace(/(https?|wss?):\/\/\S+/gi, "[redacted]");
}

/** Wraps a tool handler so an unexpected throw (an RPC error, an API 5xx, a bad response body)
 * becomes a structured `errorResult` instead of an unhandled rejection — every tool in this
 * server is built with this, so a chain hiccup reads the same way to an agent as any other
 * refusal: JSON it can branch on, never a stack trace or a leaked RPC URL. */
export function withErrorHandling<Args extends unknown[]>(
  code: string,
  handler: (...args: Args) => Promise<ToolResult>,
): (...args: Args) => Promise<ToolResult> {
  return async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResult(code, redactUrls(message));
    }
  };
}
