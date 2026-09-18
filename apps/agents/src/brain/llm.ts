import { createLlmClient, type LlmClient } from "@advance/core";

/**
 * Builds the agent's `LlmClient`, wired so every chat-completion call is paid through the card
 * gateway: `fetchImpl` is a `createCardFetch(...)` result (see `@advance/agent-kit`), never the
 * global `fetch`. Production wiring only - unit tests inject a fake `LlmClient` directly into
 * `brain/loop.ts` instead of going through this, so a completion's content is never real network
 * traffic in a test.
 */
export function createCardGatedLlmClient(params: { baseUrl: string; model: string; cardFetch: typeof fetch }): LlmClient {
  return createLlmClient({ baseUrl: params.baseUrl, model: params.model, fetchImpl: params.cardFetch });
}
