import type { McpServerConfig } from "../../utils/config.js";
import type { Logger } from "../../utils/logger.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { McpClientWrapper } from "./client.js";
import { filterMcpTools } from "./schema-mapper.js";

interface ServerState {
  client: McpClientWrapper;
  config: McpServerConfig;
  tools?: Tool[]; // Discovered tools (cached after first connection)
}

export interface McpServerStatus {
  name: string;
  enabled: boolean;
  connected: boolean;
  transportType: string;       // "stdio", "http"
  transportDetail: string;     // "docker" (if command is docker), "python3", "node", URL for http
  toolCount: number;
  idleMinutes: number | null;  // null if not connected
  description: string;
  startupMode: string;         // "eager" | "lazy"
}

/**
 * Manages MCP server lifecycle: lazy initialization, idle timeouts, graceful shutdown.
 */
export class McpServerManager {
  private servers = new Map<string, ServerState>();
  private logger: Logger;
  private idleCheckIntervalId?: NodeJS.Timeout;
  // In-flight connection promises — prevents double-connect races when two callers
  // hit an uninitialized server simultaneously.
  private connectPromises = new Map<string, Promise<Tool[]>>();

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * Register a server (creates client but doesn't connect for lazy mode).
   */
  registerServer(serverName: string, config: McpServerConfig): void {
    const client = new McpClientWrapper(serverName, config);
    this.servers.set(serverName, { client, config });

    this.logger.debug(
      { server: serverName, mode: config.startup_mode },
      "MCP server registered"
    );
  }

  /**
   * Get all registered server names.
   */
  getServerNames(): string[] {
    return Array.from(this.servers.keys());
  }

  /**
   * Get server config.
   */
  getServerConfig(serverName: string): McpServerConfig | undefined {
    return this.servers.get(serverName)?.config;
  }

  /**
   * Check if a server is connected.
   */
  isConnected(serverName: string): boolean {
    const state = this.servers.get(serverName);
    return state?.client.isConnected() ?? false;
  }

  /**
   * Get status for all registered MCP servers.
   */
  getStatus(): McpServerStatus[] {
    const statuses: McpServerStatus[] = [];

    for (const [serverName, state] of this.servers.entries()) {
      const connected = state.client.isConnected();
      const config = state.config;

      // Determine transport detail
      let transportDetail = "";
      if (config.transport.type === "stdio") {
        if (config.transport.command === "docker") {
          transportDetail = "docker";
        } else {
          transportDetail = config.transport.command;
        }
      } else if (config.transport.type === "http") {
        transportDetail = config.transport.url;
      }

      statuses.push({
        name: serverName,
        enabled: config.enabled ?? true,
        connected,
        transportType: config.transport.type,
        transportDetail,
        toolCount: connected && state.tools ? state.tools.length : 0,
        idleMinutes: connected ? state.client.getIdleTimeMinutes() : null,
        description: config.description ?? "",
        startupMode: config.startup_mode ?? "lazy",
      });
    }

    return statuses;
  }

  /**
   * Ensure a server is connected (lazy initialization).
   * Returns the filtered tools for the server.
   *
   * Uses a connection promise singleton to prevent double-connect races when
   * two callers hit an uninitialized server at the same time.
   */
  async ensureConnected(serverName: string): Promise<Tool[]> {
    const state = this.servers.get(serverName);
    if (!state) {
      throw new Error(`MCP server not registered: ${serverName}`);
    }

    // Fast path: already connected with cached tools
    if (state.client.isConnected() && state.tools) {
      return state.tools;
    }

    // Return the in-flight promise if a connection is already in progress
    const inflight = this.connectPromises.get(serverName);
    if (inflight) return inflight;

    const promise = this.doConnect(serverName, state).finally(() => {
      this.connectPromises.delete(serverName);
    });
    this.connectPromises.set(serverName, promise);
    return promise;
  }

  private async doConnect(serverName: string, state: ServerState): Promise<Tool[]> {
    this.logger.info({ server: serverName }, "Connecting to MCP server (lazy init)");

    try {
      await state.client.connect();

      const allTools = await state.client.listTools();
      const filteredTools = filterMcpTools(allTools, state.config);

      state.tools = filteredTools;

      this.logger.info(
        {
          server: serverName,
          totalTools: allTools.length,
          filteredTools: filteredTools.length,
          blocked: state.config.tool_blocklist,
        },
        "MCP server connected and tools discovered"
      );

      return filteredTools;
    } catch (err) {
      this.logger.error(
        {
          server: serverName,
          error: err instanceof Error ? err.message : String(err),
        },
        "Failed to connect to MCP server"
      );
      throw err;
    }
  }

  /**
   * Get the client for a server.
   */
  getClient(serverName: string): McpClientWrapper | undefined {
    return this.servers.get(serverName)?.client;
  }

  /**
   * Start monitoring for idle timeouts.
   * Runs every minute to check all servers and disconnect idle ones.
   */
  startIdleTimeoutMonitor(): void {
    if (this.idleCheckIntervalId) {
      return; // Already running
    }

    // Check every minute
    this.idleCheckIntervalId = setInterval(() => {
      this.checkIdleTimeouts();
    }, 60000);

    this.logger.info("MCP idle timeout monitor started");
  }

  /**
   * Stop the idle timeout monitor.
   */
  stopIdleTimeoutMonitor(): void {
    if (this.idleCheckIntervalId) {
      clearInterval(this.idleCheckIntervalId);
      this.idleCheckIntervalId = undefined;
      this.logger.info("MCP idle timeout monitor stopped");
    }
  }

  /**
   * Check all servers for idle timeout and disconnect if needed.
   */
  private async checkIdleTimeouts(): Promise<void> {
    for (const [serverName, state] of this.servers.entries()) {
      // Skip if not connected or no timeout configured
      if (!state.client.isConnected() || !state.config.idle_timeout_minutes) {
        continue;
      }

      const idleMinutes = state.client.getIdleTimeMinutes();

      if (idleMinutes >= state.config.idle_timeout_minutes) {
        this.logger.info(
          {
            server: serverName,
            idleMinutes,
            timeout: state.config.idle_timeout_minutes,
          },
          "MCP server idle timeout reached, disconnecting"
        );

        try {
          await state.client.disconnect();
        } catch (err) {
          this.logger.error(
            {
              server: serverName,
              error: err instanceof Error ? err.message : String(err),
            },
            "Failed to disconnect idle MCP server"
          );
        }
      }
    }
  }

  /**
   * Disconnect all connected servers and stop monitoring.
   */
  async shutdown(): Promise<void> {
    this.stopIdleTimeoutMonitor();

    this.logger.info("Shutting down MCP server manager");

    for (const [serverName, state] of this.servers.entries()) {
      if (state.client.isConnected()) {
        this.logger.debug({ server: serverName }, "Disconnecting MCP server");
        try {
          await state.client.disconnect();
        } catch (err) {
          this.logger.error(
            {
              server: serverName,
              error: err instanceof Error ? err.message : String(err),
            },
            "Failed to disconnect MCP server during shutdown"
          );
        }
      }
    }

    this.servers.clear();
  }
}
