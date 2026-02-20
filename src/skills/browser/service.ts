import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpClientWrapper } from "../../integrations/mcp/client.js";
import type { BrowserConfig } from "../../utils/config.js";
import type { Logger } from "../../utils/logger.js";

const execFileAsync = promisify(execFile);

interface BrowserSession {
  id: string;
  containerName: string;
  client: McpClientWrapper;
  lastActivityAt: number;
  createdAt: number;
  userId?: string;
  screenshotDir: string;
}

export interface CreateSessionResult {
  sessionId: string;
  availableTools: string[];
}

export interface CallToolResult {
  content: string;
  isError: boolean;
}

export interface CallToolRawResult {
  content: Array<{ type: string; [key: string]: unknown }>;
  isError: boolean;
}

/**
 * BrowserService manages the lifecycle of ephemeral Playwright MCP containers.
 *
 * Each session maps to one Docker container running the Playwright MCP server.
 * Communication is via stdio (docker run -i → McpClientWrapper → StdioClientTransport).
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

  /**
   * Create a new browser session: spawn container, connect MCP client, discover tools.
   */
  async createSession(userId?: string): Promise<CreateSessionResult> {
    if (this.sessions.size >= this.config.max_sessions) {
      throw new Error(
        `Maximum concurrent browser sessions (${this.config.max_sessions}) reached. ` +
          `Call browser_close on an existing session first.`
      );
    }

    const sessionId = randomBytes(8).toString("hex");
    const containerName = `coda-browser-${sessionId}`;

    // Create a temp dir for screenshots belonging to this session
    const screenshotDir = await mkdtemp(join(tmpdir(), `coda-browser-${sessionId}-`));

    this.logger.info({ sessionId, containerName, userId }, "Creating browser session");

    const mcpConfig = {
      enabled: true,
      transport: {
        type: "stdio" as const,
        command: "docker",
        args: this.buildDockerArgs(containerName),
        env: this.buildDockerEnv(),
      },
      timeout_ms: this.config.tool_timeout_ms,
      tool_timeout_ms: this.config.tool_timeout_ms,
      tool_allowlist: undefined,
      tool_blocklist: [] as string[],
      requires_confirmation: [] as string[],
      sensitive_tools: [] as string[],
      description: `Browser session ${sessionId}`,
      max_response_size: 100_000,
      auto_refresh_tools: false,
      startup_mode: "eager" as const,
      idle_timeout_minutes: undefined,
    };

    const client = new McpClientWrapper(`browser-${sessionId}`, mcpConfig);

    try {
      await client.connect();
      this.logger.debug({ sessionId }, "MCP client connected to browser container");

      const tools = await client.listTools();
      const availableTools = tools.map((t) => t.name);

      this.logger.info(
        { sessionId, toolCount: availableTools.length },
        "Browser session ready"
      );

      const session: BrowserSession = {
        id: sessionId,
        containerName,
        client,
        lastActivityAt: Date.now(),
        createdAt: Date.now(),
        userId,
        screenshotDir,
      };
      this.sessions.set(sessionId, session);

      return { sessionId, availableTools };
    } catch (err) {
      this.logger.error({ error: err, containerName }, "Failed to start browser container");
      try {
        await client.disconnect();
        await this.forceRemoveContainer(containerName);
        await rm(screenshotDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
      throw new Error(
        `Failed to start browser session: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Call an MCP tool on an active session and return serialized text content.
   */
  async callTool(
    sessionId: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<CallToolResult> {
    const session = this.getActiveSession(sessionId);
    session.lastActivityAt = Date.now();

    try {
      const result = await session.client.callTool(toolName, args);
      session.lastActivityAt = Date.now();
      if (result.isError) {
        this.logger.warn({ sessionId, toolName }, "Playwright MCP tool returned error");
      }
      return result;
    } catch (err) {
      this.logger.error({ error: err, sessionId, toolName }, "MCP tool call failed");
      if (!session.client.isConnected()) {
        await this.destroySession(sessionId);
      }
      throw err;
    }
  }

  /**
   * Call an MCP tool and return raw content blocks.
   * Used for screenshot handling to preserve image data.
   */
  async callToolRaw(
    sessionId: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<CallToolRawResult> {
    const session = this.getActiveSession(sessionId);
    session.lastActivityAt = Date.now();

    try {
      const result = await session.client.callToolRaw(toolName, args);
      session.lastActivityAt = Date.now();
      return result;
    } catch (err) {
      this.logger.error({ error: err, sessionId, toolName }, "MCP raw tool call failed");
      if (!session.client.isConnected()) {
        await this.destroySession(sessionId);
      }
      throw err;
    }
  }

  /**
   * Save base64 image data to the session's screenshot directory.
   * Returns the file path.
   */
  async saveScreenshot(sessionId: string, base64Data: string, mimeType?: string): Promise<string> {
    const session = this.getActiveSession(sessionId);
    const ext = mimeType === "image/jpeg" ? "jpg" : "png";
    const filename = `screenshot-${Date.now()}.${ext}`;
    const filePath = join(session.screenshotDir, filename);
    await writeFile(filePath, Buffer.from(base64Data, "base64"));
    return filePath;
  }

  /**
   * Destroy a session: disconnect MCP client, force-remove container, cleanup temp files.
   */
  async destroySession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this.logger.info(
      { sessionId, containerName: session.containerName },
      "Destroying browser session"
    );
    this.sessions.delete(sessionId);

    // Disconnect MCP client (closes stdin → container exits → --rm removes it)
    try {
      await session.client.disconnect();
    } catch (err) {
      this.logger.warn({ error: err, sessionId }, "Error disconnecting MCP client");
    }

    // Force-remove container as safety net (--rm may have already cleaned up)
    await this.forceRemoveContainer(session.containerName);

    // Clean up screenshot temp directory
    try {
      await rm(session.screenshotDir, { recursive: true, force: true });
    } catch {
      // non-critical
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
    if (!session.client.isConnected()) {
      // Async cleanup — don't await to avoid deadlock in error path
      this.destroySession(sessionId).catch(() => {});
      throw new Error(
        `Browser session "${sessionId}" has disconnected. Use browser_open to start a new session.`
      );
    }
    return session;
  }

  private buildDockerArgs(containerName: string): string[] {
    return [
      "run",
      "-i", // Keep stdin open for MCP stdio transport
      "--rm", // Auto-remove container on exit
      "--name", containerName,
      // Network: internet-only sandbox — no access to coda-internal
      "--network", this.config.sandbox_network,
      // Resource limits
      "--memory", "1g",
      "--cpus", "1",
      "--pids-limit", "512",
      // Security hardening
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--read-only",
      // Writable tmpfs for browser temp files and profile
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=256m",
      "--tmpfs", "/home/browser:rw,noexec,nosuid,size=128m",
      // Shared memory required by Chromium
      "--shm-size", "256m",
      this.config.image,
    ];
  }

  private buildDockerEnv(): Record<string, string> | undefined {
    if (this.config.docker_socket !== "/var/run/docker.sock") {
      // Custom socket — include parent env so Docker CLI finds dependencies
      return {
        ...(process.env as Record<string, string>),
        DOCKER_HOST: `unix://${this.config.docker_socket}`,
      };
    }
    // Default socket — inherit parent environment (undefined = inherit)
    return undefined;
  }

  private async forceRemoveContainer(containerName: string): Promise<void> {
    try {
      const env = { ...(process.env as Record<string, string>) };
      if (this.config.docker_socket !== "/var/run/docker.sock") {
        env.DOCKER_HOST = `unix://${this.config.docker_socket}`;
      }
      await execFileAsync("docker", ["rm", "-f", containerName], { env });
      this.logger.debug({ containerName }, "Container force-removed");
    } catch {
      // Expected if --rm already cleaned up
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
}
