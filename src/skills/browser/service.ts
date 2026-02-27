import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createConnection } from "node:net";
import type { Browser, BrowserContext, Page } from "playwright";
import type { BrowserConfig } from "../../utils/config.js";
import type { Logger } from "../../utils/logger.js";

const execFileAsync = promisify(execFile);

/** Lazy import playwright — avoids hard-requiring it at module load time. */
async function getChromium() {
  const { chromium } = await import("playwright");
  return chromium;
}

interface BrowserSession {
  id: string;
  containerName?: string; // docker mode only
  browser: Browser;
  context: BrowserContext;
  page: Page;
  lastActivityAt: number;
  createdAt: number;
  userId?: string;
}

export interface CreateSessionResult {
  sessionId: string;
}

/** A parsed entry from page.ariaSnapshot() output. */
interface AriaEntry {
  depth: number;
  role: string;
  name: string;
}

/**
 * BrowserService manages the lifecycle of browser sessions backed by Playwright.
 *
 * **Docker mode** (production): each session spawns an isolated container running
 * `playwright-server.js`. The host connects via WebSocket to the container IP.
 *
 * **Host mode** (development): Chromium is launched directly via `chromium.launch()`.
 * Requires `npx playwright install chromium` to be run once on the host.
 */
export class BrowserService {
  private sessions: Map<string, BrowserSession> = new Map();
  private config: BrowserConfig;
  private logger: Logger;
  private timeoutMonitor?: ReturnType<typeof setInterval>;

  constructor(config: BrowserConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  /** Start the idle-session timeout monitor. Call once during skill startup. */
  start(): void {
    this.timeoutMonitor = setInterval(() => {
      this.cleanupIdleSessions().catch((err) => {
        this.logger.error({ error: err }, "Browser session idle cleanup error");
      });
    }, 30_000);
    this.logger.debug("Browser service started (timeout monitor active)");
  }

  /** Stop monitor and destroy all active sessions. Call during skill shutdown. */
  async stop(): Promise<void> {
    if (this.timeoutMonitor) {
      clearInterval(this.timeoutMonitor);
      this.timeoutMonitor = undefined;
    }
    const ids = Array.from(this.sessions.keys());
    await Promise.allSettled(ids.map((id) => this.destroySession(id)));
    this.logger.debug({ count: ids.length }, "Browser service stopped");
  }

  /** Create a new browser session. */
  async createSession(userId?: string): Promise<CreateSessionResult> {
    if (this.sessions.size >= this.config.max_sessions) {
      throw new Error(
        `Maximum concurrent browser sessions (${this.config.max_sessions}) reached. ` +
          `Call browser_close on an existing session first.`
      );
    }

    const sessionId = randomBytes(8).toString("hex");

    this.logger.info({ sessionId, userId, mode: this.config.mode }, "Creating browser session");

    let browser: Browser;
    let containerName: string | undefined;

    try {
      const chromium = await getChromium();

      if (this.config.mode === "host") {
        browser = await chromium.launch({
          headless: this.config.headless,
          args: ["--no-sandbox", "--disable-setuid-sandbox"],
          timeout: this.config.connect_timeout_ms,
        });
      } else {
        // Docker mode: spin up an isolated container and connect via WebSocket
        containerName = `coda-browser-${sessionId}`;
        await this.preflight();
        await this.startContainer(containerName);
        const containerIp = await this.waitForContainerIp(containerName);
        await this.waitForPort(containerIp, 3000, containerName);
        browser = await this.connectWithRetry(chromium, containerIp, containerName);
      }

      const context = await browser.newContext();
      const page = await context.newPage();

      const session: BrowserSession = {
        id: sessionId,
        containerName,
        browser,
        context,
        page,
        lastActivityAt: Date.now(),
        createdAt: Date.now(),
        userId,
      };
      this.sessions.set(sessionId, session);

      this.logger.info({ sessionId }, "Browser session ready");
      return { sessionId };
    } catch (err) {
      this.logger.error({ error: err, containerName }, "Failed to start browser session");
      if (containerName) {
        await this.forceRemoveContainer(containerName).catch(() => {});
      }
      throw new Error(
        `Failed to start browser session: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /** Navigate the session's page to a URL. */
  async navigate(sessionId: string, url: string): Promise<void> {
    const session = this.getActiveSession(sessionId);
    session.lastActivityAt = Date.now();
    await session.page.goto(url, {
      timeout: this.config.tool_timeout_ms,
      waitUntil: "domcontentloaded",
    });
    session.lastActivityAt = Date.now();
  }

  /**
   * Get a human-readable accessibility snapshot of the current page.
   * Returns locator strings the LLM can use directly in browser_interact.
   */
  async getContent(sessionId: string): Promise<string> {
    const session = this.getActiveSession(sessionId);
    session.lastActivityAt = Date.now();

    const [title, url, ariaYaml] = await Promise.all([
      session.page.title(),
      Promise.resolve(session.page.url()),
      session.page.locator("body").ariaSnapshot(),
    ]);

    const lines: string[] = [];
    lines.push(`Page: ${title}`);
    lines.push(`URL: ${url}`);
    lines.push("");

    const entries = this.parseAriaSnapshot(ariaYaml);
    for (const entry of entries) {
      const indent = "  ".repeat(Math.min(entry.depth, 4));
      const locator = this.buildLocator(entry.role, entry.name);
      lines.push(`${indent}[${entry.role}] "${entry.name}" → ${locator}`);
    }

    if (lines.length <= 3) {
      lines.push("(No interactive elements found — page may still be loading)");
    }

    session.lastActivityAt = Date.now();
    return lines.join("\n");
  }

  /**
   * Take a screenshot. Each call creates its own independent temp dir so the file
   * outlives the browser session — browser_close (which used to delete a shared
   * screenshotDir) will not remove it before the platform bot can upload it.
   */
  async screenshot(sessionId: string, fullPage: boolean): Promise<string> {
    const session = this.getActiveSession(sessionId);
    session.lastActivityAt = Date.now();
    const dir = await mkdtemp(join(tmpdir(), "coda-screenshot-"));
    const filePath = join(dir, `screenshot-${Date.now()}.jpg`);
    await session.page.screenshot({ path: filePath, fullPage, type: "jpeg", quality: 80, timeout: this.config.tool_timeout_ms });
    session.lastActivityAt = Date.now();
    return filePath;
  }

  /** Click an element identified by a Playwright selector. */
  async click(sessionId: string, selector: string): Promise<void> {
    const session = this.getActiveSession(sessionId);
    session.lastActivityAt = Date.now();
    await session.page.locator(selector).first().click({ timeout: this.config.tool_timeout_ms });
    session.lastActivityAt = Date.now();
  }

  /** Fill a text input identified by a Playwright selector. */
  async fill(sessionId: string, selector: string, text: string): Promise<void> {
    const session = this.getActiveSession(sessionId);
    session.lastActivityAt = Date.now();
    await session.page.locator(selector).first().fill(text, { timeout: this.config.tool_timeout_ms });
    session.lastActivityAt = Date.now();
  }

  /** Select an option in a <select> element identified by a Playwright selector. */
  async select(sessionId: string, selector: string, value: string): Promise<void> {
    const session = this.getActiveSession(sessionId);
    session.lastActivityAt = Date.now();
    await session.page.locator(selector).first().selectOption(value, { timeout: this.config.tool_timeout_ms });
    session.lastActivityAt = Date.now();
  }

  /** Destroy a session: close browser, remove container (docker mode), clean temp files. */
  async destroySession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this.logger.info(
      { sessionId, containerName: session.containerName },
      "Destroying browser session"
    );
    this.sessions.delete(sessionId);

    try {
      await session.context.close();
    } catch (err) {
      this.logger.warn({ error: err, sessionId }, "Error closing browser context");
    }
    try {
      await session.browser.close();
    } catch (err) {
      this.logger.warn({ error: err, sessionId }, "Error closing browser");
    }

    if (session.containerName) {
      await this.forceRemoveContainer(session.containerName);
    }
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  getSessionCount(): number {
    return this.sessions.size;
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  private getActiveSession(sessionId: string): BrowserSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(
        `Browser session "${sessionId}" not found. Use browser_open to start a new session.`
      );
    }
    if (!session.browser.isConnected()) {
      // Async cleanup — don't await to avoid deadlock in error path
      this.destroySession(sessionId).catch(() => {});
      throw new Error(
        `Browser session "${sessionId}" has disconnected. Use browser_open to start a new session.`
      );
    }
    return session;
  }

  /**
   * Parse the YAML-like output of page.ariaSnapshot() into structured entries.
   * Only interactive/meaningful roles are included to keep output concise.
   * ARIA snapshot format:
   *   - document "Page title"
   *     - heading "Welcome" [level=1]
   *     - link "About Us"
   *     - button "Sign In"
   *     - textbox "Email"
   */
  private parseAriaSnapshot(yaml: string): AriaEntry[] {
    const INTERACTIVE_ROLES = new Set([
      "button", "link", "textbox", "searchbox", "checkbox", "radio",
      "combobox", "listbox", "menuitem", "menuitemcheckbox", "menuitemradio",
      "option", "tab", "heading", "img",
    ]);

    const entries: AriaEntry[] = [];
    for (const rawLine of yaml.split("\n")) {
      // Lines look like: "  - heading \"Welcome\" [level=1]"
      const lineMatch = rawLine.match(/^(\s*)- (\w[\w-]*)\s+"([^"]*)"/);
      if (!lineMatch) continue;
      const indentStr = lineMatch[1] ?? "";
      const role = lineMatch[2] ?? "";
      const name = lineMatch[3] ?? "";
      if (!INTERACTIVE_ROLES.has(role) || !name.trim()) continue;
      const depth = Math.floor(indentStr.length / 2);
      entries.push({ depth, role, name: name.trim() });
    }
    return entries;
  }

  /**
   * Build a Playwright locator string for an accessibility role + name pair.
   * Prefer role-based selectors which are more robust than CSS.
   */
  private buildLocator(role: string, name: string): string {
    const escaped = name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    switch (role) {
      case "button":
        return `button:has-text("${escaped}")`;
      case "link":
        return `a:has-text("${escaped}")`;
      case "textbox":
      case "searchbox":
        // Try label-based first, then placeholder
        return `input[aria-label="${escaped}"], input[placeholder="${escaped}"], textarea[aria-label="${escaped}"]`;
      case "checkbox":
        return `input[type="checkbox"][aria-label="${escaped}"]`;
      case "radio":
        return `input[type="radio"][aria-label="${escaped}"]`;
      case "combobox":
      case "listbox":
        return `select[aria-label="${escaped}"]`;
      case "heading":
        return `h1:has-text("${escaped}"), h2:has-text("${escaped}"), h3:has-text("${escaped}")`;
      case "tab":
        return `[role="tab"]:has-text("${escaped}")`;
      case "menuitem":
      case "menuitemcheckbox":
      case "menuitemradio":
        return `[role="menuitem"]:has-text("${escaped}")`;
      default:
        return `[role="${role}"]:has-text("${escaped}")`;
    }
  }

  /**
   * Pre-flight: verify image and network exist before starting a container.
   * Provides actionable errors instead of opaque connection failures.
   */
  private async preflight(): Promise<void> {
    const env = this.buildDockerEnv();

    try {
      await execFileAsync("docker", ["image", "inspect", "--format", "{{.Id}}", this.config.image], { env });
    } catch (err: unknown) {
      const detail = (err as { stderr?: string }).stderr?.trim() || (err as Error).message;
      throw new Error(
        `Browser image "${this.config.image}" not found (docker said: ${detail}). ` +
          `Build it with: docker compose --profile mcp-build build`
      );
    }

    try {
      await execFileAsync("docker", ["network", "inspect", "--format", "{{.Id}}", this.config.sandbox_network], { env });
    } catch {
      // Network not found — attempt to create it
      this.logger.warn({ network: this.config.sandbox_network }, "Sandbox network not found; attempting to create it");
      try {
        await execFileAsync("docker", ["network", "create", this.config.sandbox_network], { env });
        this.logger.info({ network: this.config.sandbox_network }, "Sandbox network created");
      } catch (createErr: unknown) {
        const detail = (createErr as { stderr?: string }).stderr?.trim() || (createErr as Error).message;
        throw new Error(
          `Browser sandbox network "${this.config.sandbox_network}" not found and could not be created: ${detail}`
        );
      }
    }
  }

  /** Start the browser container in detached mode (-d). */
  private async startContainer(containerName: string): Promise<void> {
    const env = this.buildDockerEnv();
    await execFileAsync("docker", this.buildDockerArgs(containerName), { env });
    this.logger.debug({ containerName }, "Browser container started (detached)");
  }

  /**
   * Poll docker inspect until the container has an IP on the sandbox network.
   * The IP becomes available within ~100ms of `docker run -d` returning.
   */
  private async waitForContainerIp(containerName: string): Promise<string> {
    const env = this.buildDockerEnv();
    const format = `{{(index .NetworkSettings.Networks "${this.config.sandbox_network}").IPAddress}}`;
    const deadline = Date.now() + this.config.connect_timeout_ms;

    while (Date.now() < deadline) {
      try {
        const { stdout } = await execFileAsync(
          "docker", ["inspect", "--format", format, containerName], { env }
        );
        const ip = stdout.trim();
        if (ip && ip !== "<no value>") {
          this.logger.debug({ containerName, ip }, "Got container IP");
          return ip;
        }
      } catch {
        // Container not ready yet
      }
      await this.sleep(300);
    }

    throw new Error(
      `Timed out waiting for container "${containerName}" to get an IP on network "${this.config.sandbox_network}"`
    );
  }

  /**
   * Poll TCP until the container is accepting connections on the given port.
   * This bridges the gap between the container getting an IP and the
   * playwright-server.js process actually binding to port 3000 (Node startup
   * + Chromium launch can take several seconds).
   */
  private async waitForPort(ip: string, port: number, containerName: string): Promise<void> {
    const deadline = Date.now() + this.config.connect_timeout_ms;

    while (Date.now() < deadline) {
      const ready = await new Promise<boolean>((resolve) => {
        const socket = createConnection({ host: ip, port }, () => {
          socket.destroy();
          resolve(true);
        });
        socket.on("error", () => {
          socket.destroy();
          resolve(false);
        });
      });

      if (ready) {
        this.logger.debug({ containerName, ip, port }, "Container port ready");
        return;
      }

      await this.sleep(300);
    }

    throw new Error(
      `Timed out waiting for port ${port} to open on container "${containerName}" (${ip}:${port})`
    );
  }

  /**
   * Attempt to connect to the Playwright WebSocket server in the container,
   * retrying up to config.connect_retries times with exponential back-off.
   * The container's playwright-server.js listens at ws://<ip>:3000/playwright.
   */
  private async connectWithRetry(
    chromium: Awaited<ReturnType<typeof getChromium>>,
    containerIp: string,
    containerName: string
  ): Promise<Browser> {
    const wsEndpoint = `ws://${containerIp}:3000/playwright`;
    const retries = this.config.connect_retries;

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const browser = await chromium.connect(wsEndpoint, {
          timeout: this.config.connect_timeout_ms,
        });
        this.logger.debug({ containerName, attempt }, "Connected to Playwright server");
        return browser;
      } catch (err) {
        this.logger.warn(
          { error: (err as Error).message, containerName, attempt, retries },
          "Playwright connection attempt failed"
        );
        if (attempt < retries) {
          await this.sleep(500 * attempt); // 500ms, 1s, 1.5s …
        }
      }
    }

    throw new Error(
      `Failed to connect to Playwright server in container "${containerName}" after ${retries} attempts. ` +
        `Endpoint: ws://${containerIp}:3000/playwright`
    );
  }

  private buildDockerArgs(containerName: string): string[] {
    return [
      "run",
      "-d",     // Detached — no stdin pipe needed (unlike MCP stdio transport)
      "--rm",
      "--init",
      "--name", containerName,
      // Internet-only sandbox network
      "--network", this.config.sandbox_network,
      // Resource limits
      "--memory", "1g",
      "--cpus", "1",
      "--pids-limit", "512",
      // Security hardening
      "--cap-drop=ALL",
      "--cap-add=SYS_PTRACE",    // Required by Chromium crashpad handler
      "--security-opt=no-new-privileges",
      "--security-opt=seccomp=unconfined", // Chromium needs syscalls blocked by default seccomp
      "--read-only",
      // Writable tmpfs for browser temp files
      "--tmpfs", "/tmp:rw,nosuid,size=256m",
      "--tmpfs", "/var/tmp:rw,nosuid,size=64m",
      "--tmpfs", "/home/pwuser:rw,nosuid,size=128m",
      "--tmpfs", "/app/node_modules/.cache:rw,nosuid,size=32m",
      // Shared memory required by Chromium
      "--shm-size", "256m",
      this.config.image,
    ];
  }

  private buildDockerEnv(): Record<string, string> {
    const env = { ...(process.env as Record<string, string>) };
    if (this.config.docker_socket !== "/var/run/docker.sock") {
      env.DOCKER_HOST = `unix://${this.config.docker_socket}`;
    } else {
      // Strip DOCKER_HOST so the CLI uses the default socket
      delete env.DOCKER_HOST;
    }
    return env;
  }

  private async forceRemoveContainer(containerName: string): Promise<void> {
    try {
      await execFileAsync("docker", ["rm", "-f", containerName], { env: this.buildDockerEnv() });
      this.logger.debug({ containerName }, "Container force-removed");
    } catch {
      this.logger.debug({ containerName }, "Container already removed (expected with --rm)");
    }
  }

  private async cleanupIdleSessions(): Promise<void> {
    const timeoutMs = this.config.session_timeout_seconds * 1000;
    const now = Date.now();
    const toDestroy: string[] = [];

    for (const [id, session] of this.sessions) {
      if (now - session.lastActivityAt > timeoutMs) {
        toDestroy.push(id);
      }
    }

    for (const id of toDestroy) {
      this.logger.info(
        { sessionId: id, idleSeconds: Math.round((now - (this.sessions.get(id)?.lastActivityAt ?? now)) / 1000) },
        "Auto-destroying idle browser session"
      );
      await this.destroySession(id);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
