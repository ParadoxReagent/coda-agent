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

/**
 * Manages MCP server lifecycle: lazy initialization, idle timeouts, graceful shutdown.
 */
export class McpServerManager {
  private servers = new Map<string, ServerState>();
  private logger: Logger;
  private idleCheckIntervalId?: NodeJS.Timeout;

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
   * Ensure a server is connected (lazy initialization).
   * Returns the filtered tools for the server.
   */
  async ensureConnected(serverName: string): Promise<Tool[]> {
    const state = this.servers.get(serverName);
    if (!state) {
      throw new Error(`MCP server not registered: ${serverName}`);
    }

    // Already connected - return cached tools
    if (state.client.isConnected() && state.tools) {
      return state.tools;
    }

    // Connect and discover tools
    this.logger.info({ server: serverName }, "Connecting to MCP server (lazy init)");

    try {
      await state.client.connect();

      // Discover and filter tools
      const allTools = await state.client.listTools();
      const filteredTools = filterMcpTools(allTools, state.config);

      // Cache tools
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
