import { Hono } from "hono";
import type { Address, Hex } from "viem";
import {
  createBankrClient,
  createLiveChainOps,
  createLlmClient,
  type BankrClient,
  type ChainOps,
  type LlmClient,
} from "@advance/core";
import { rpcUrlForChain, type UnderwriterConfig } from "./config.js";
import { createFileEvidenceStore, type EvidenceStore } from "./store.js";
import { registerEvidenceRoute } from "./routes/evidence.js";
import { registerHealthRoute } from "./routes/health.js";
import { registerQuoteRoute } from "./routes/quote.js";
import { registerScoreRoute } from "./routes/score.js";
import { rateLimit } from "./rateLimit.js";

export interface CreateAppOptions {
  /** Injected for tests: fixture-backed `ChainOps`. Defaults to a live archive RPC client
   * for `rpcUrlForChain(config)`. */
  chain?: ChainOps;
  /** Injected for tests: a fixture-backed `BankrClient`. Defaults to the live Bankr API. */
  bankr?: BankrClient;
  /** Injected for tests: a scripted `LlmClient`. Defaults to the configured LLM gateway. */
  llm?: LlmClient;
  isEscrowed?: (poolId: Hex) => Promise<boolean>;
  /** Injected for tests: an evidence store double (e.g. to force a write failure).
   * Defaults to a file-backed store under `config.EVIDENCE_DIR`. */
  evidenceStore?: EvidenceStore;
  /** Unix-seconds clock used as `UnderwriteInput.now` for both routes. Defaults to the
   * real wall clock; tests inject a fixed value matching their fixture's block time. */
  now?: () => number;
  /** Ms clock for the score route's 5-minute response cache. Defaults to `Date.now`. */
  cacheNow?: () => number;
  /** Ms clock for the rate limiter's fixed window. Defaults to `Date.now`. */
  rateLimitNow?: () => number;
}

/**
 * Builds the underwriter HTTP app: `GET /health`, the free `GET /v1/score/:token`, the
 * paid `POST /v1/quote`, and `GET /v1/evidence/:hash`. Every engine dependency
 * (`chain`/`bankr`/`llm`/`evidenceStore`) can be overridden — tests do, wiring in
 * fixture-backed doubles so nothing here ever touches the network.
 */
export function createApp(config: UnderwriterConfig, options: CreateAppOptions = {}): Hono {
  const chain = options.chain ?? createLiveChainOps(rpcUrlForChain(config));
  const bankr = options.bankr ?? createBankrClient();
  const llm =
    options.llm ??
    createLlmClient({ baseUrl: config.LLM_BASE_URL, apiKey: config.LLM_API_KEY, model: config.LLM_MODEL });
  const evidenceStore = options.evidenceStore ?? createFileEvidenceStore(config.EVIDENCE_DIR);
  const hub = config.ADVANCE_HUB as Address;
  const signerKey = config.UNDERWRITER_PRIVATE_KEY as Hex;

  const app = new Hono();

  // Last-resort handler: anything that escapes a route's own try/catch (an unexpected bug,
  // a broken injected dependency, ...) becomes a generic 500. Never `err.message` here —
  // `score`/`underwrite` already fail closed internally (an RPC/LLM failure becomes a
  // `data_unavailable` deny, not a thrown error), so anything that does reach this handler
  // is unexpected by construction, and its message is not trusted not to contain a secret.
  app.onError((err, c) => {
    console.error("underwriter: unhandled request error", err instanceof Error ? err.name : typeof err);
    return c.json({ error: "internal error" }, 500);
  });

  registerHealthRoute(app, { chainId: config.CHAIN_ID, network: config.NETWORK });

  app.use("/v1/*", rateLimit({ now: options.rateLimitNow }));

  registerScoreRoute(app, {
    deps: { chain, bankr, env: { network: config.NETWORK } },
    chainId: config.CHAIN_ID,
    hub,
    evidenceStore,
    now: options.now,
    cacheNow: options.cacheNow,
  });

  registerQuoteRoute(app, {
    deps: {
      chain,
      bankr,
      llm,
      signerKey,
      env: { network: config.NETWORK },
      isEscrowed: options.isEscrowed,
    },
    hub,
    evidenceStore,
    now: options.now,
  });

  registerEvidenceRoute(app, { evidenceStore });

  return app;
}
