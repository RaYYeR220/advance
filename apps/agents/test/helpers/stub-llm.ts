import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export const STUB_COMPLETION_BODY = {
  id: "chatcmpl-stub-000",
  object: "chat.completion",
  created: 1_700_000_000,
  model: "stub-model",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "stub upstream response" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 },
};

/** A local HTTP server standing in for an OpenAI-compatible upstream. */
export function startStubLlm(): { url: string; close(): Promise<void> } {
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(STUB_COMPLETION_BODY));
    });
  });
  server.listen(0);
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
