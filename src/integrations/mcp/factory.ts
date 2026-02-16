import type { McpConfig } from "../../utils/config.js";
import type { Logger } from "../../utils/logger.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { McpServerManager } from "./manager.js";
import { McpServerSkill } from "./skill.js";

export interface McpSkillResult {
  skill: McpServerSkill;
}

export interface McpFactoryResult {
  skills: McpSkillResult[];
  manager: McpServerManager;
}

/**
 * Create MCP skills for all enabled servers in config.
 * Supports lazy initialization - eager servers connect immediately,
 * lazy servers connect on first use.
 * Returns skills and manager for lifecycle management.
 */
export async function createMcpSkills(
  config: McpConfig,
  logger: Logger
): Promise<McpFactoryResult> {
  const manager = new McpServerManager(logger);
  const skills: McpSkillResult[] = [];

  for (const [serverName, serverConfig] of Object.entries(config.servers)) {
    // Skip disabled servers
    if (!serverConfig.enabled) {
      logger.info({ server: serverName }, "MCP server disabled, skipping");
      continue;
    }

    // Register server (creates client but doesn't connect yet)
    manager.registerServer(serverName, serverConfig);

    try {
      let tools: Tool[];

      // For eager mode, connect immediately
      if (serverConfig.startup_mode === "eager") {
        logger.info({ server: serverName }, "Connecting to MCP server (eager mode)");
        tools = await manager.ensureConnected(serverName);
      } else {
        // Lazy mode - connect on first use
        logger.info({ server: serverName }, "MCP server registered (lazy mode, will connect on first use)");
        tools = []; // No tools yet, will be discovered on first connection
      }

      // Create skill
      const skill = new McpServerSkill(
        serverName,
        serverConfig,
        tools,
        manager
      );

      skills.push({ skill });
    } catch (err) {
      logger.error(
        {
          server: serverName,
          error: err instanceof Error ? err.message : String(err),
        },
        "Failed to initialize MCP server, skipping"
      );
    }
  }

  // Start idle timeout monitor if any server has timeout configured
  const hasTimeouts = Object.values(config.servers).some(
    (s) => s.enabled && s.idle_timeout_minutes !== undefined
  );

  if (hasTimeouts) {
    manager.startIdleTimeoutMonitor();
  }

  return { skills, manager };
}
