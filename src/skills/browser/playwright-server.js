#!/usr/bin/env node
/**
 * Playwright WebSocket server — Docker container entrypoint.
 *
 * Starts a Playwright BrowserServer on port 3000 with a fixed WebSocket path.
 * The host connects via: ws://<container-ip>:3000/playwright
 *
 * Using a fixed wsPath makes the connection URL predictable without needing
 * to parse logs — the host just needs the container IP from docker inspect.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { chromium } = require('playwright');

const PORT = 3000;
const WS_PATH = '/playwright';

async function main() {
  const server = await chromium.launchServer({
    host: '0.0.0.0',
    port: PORT,
    wsPath: WS_PATH,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });

  const endpoint = server.wsEndpoint();
  // Single-line signal for debugging / healthcheck
  process.stdout.write(`PLAYWRIGHT_READY ws=${endpoint}\n`);

  async function shutdown() {
    await server.close().catch(() => {});
    process.exit(0);
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  process.stderr.write(`Playwright server failed: ${err.message}\n`);
  process.exit(1);
});
