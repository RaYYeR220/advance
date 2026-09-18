// Polls `http://localhost:<port>` until it answers, then exits 0. Used to chain a second
// `next start` after the first webServer's build finishes, without building twice.
const port = Number(process.argv[2]);
if (!port) {
  console.error("usage: node waitForPort.mjs <port>");
  process.exit(1);
}

const deadline = Date.now() + 280_000;

async function poll() {
  while (Date.now() < deadline) {
    try {
      await fetch(`http://localhost:${port}`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`timed out waiting for port ${port}`);
}

await poll();
