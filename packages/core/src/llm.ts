/**
 * OpenAI-compatible chat-completions client, `fetch` injected so unit tests never touch
 * the network. Every failure mode the caller needs to distinguish (timeout, HTTP error,
 * malformed response body) is its own error class rather than a generic throw, so
 * `requestMemo` can map each one to `memo_unavailable` without string-matching messages.
 */
export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmClient {
  /** Sends `messages` as a chat-completion request; resolves the raw (unparsed) content
   * string of the first choice. Rejects with `LlmTimeoutError`/`LlmHttpError`/a plain
   * `Error` for a malformed response — never resolves with a placeholder on failure. */
  complete(messages: LlmMessage[]): Promise<string>;
}

export interface LlmClientConfig {
  /** OpenAI-compatible base URL, no trailing slash (e.g. `https://api.venice.ai/api/v1`). */
  baseUrl: string;
  /** Bearer token; omitted for providers that don't require one (or gate by IP/route). */
  apiKey?: string;
  model: string;
  /** Defaults to the global `fetch`; tests inject a fake. */
  fetchImpl?: typeof fetch;
  /** Defaults to 15000. */
  timeoutMs?: number;
}

export class LlmTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`LLM request timed out after ${timeoutMs}ms`);
    this.name = "LlmTimeoutError";
  }
}

export class LlmHttpError extends Error {
  readonly status: number;

  constructor(status: number, body: string) {
    super(`LLM request failed with HTTP ${status}: ${body.slice(0, 500)}`);
    this.name = "LlmHttpError";
    this.status = status;
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;

export function createLlmClient(config: LlmClientConfig): LlmClient {
  const fetchImpl = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const baseUrl = config.baseUrl.replace(/\/+$/, "");

  return {
    async complete(messages: LlmMessage[]): Promise<string> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: config.model,
            messages,
            // Some providers reject an unsupported response_format with an HTTP 400 instead of ignoring it; that surfaces as an LlmHttpError, which requestMemo already treats as memo_unavailable (fail closed).
            response_format: { type: "json_object" },
          }),
          signal: controller.signal,
        });
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          throw new LlmTimeoutError(timeoutMs);
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new LlmHttpError(response.status, body);
      }

      const data: unknown = await response.json();
      const content = (
        data as { choices?: Array<{ message?: { content?: unknown } }> }
      )?.choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        throw new Error("LLM response missing choices[0].message.content");
      }
      return content;
    },
  };
}
