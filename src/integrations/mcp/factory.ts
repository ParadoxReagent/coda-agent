import type { McpConfig } from "../../utils/config.js";
import type { Logger } from "../../utils/logger.js";
import { McpClientWrapper } from "./client.js";
import { McpServerSkill } from "./skill.js";
import { filterMcpTools } from "./schema-mapper.js";

export interface McpSkillResult {
  skill: McpServerSkill;
}

/**
 * Create MCP skills for all enabled servers in config.
 * Connects to each server, discovers tools, and returns ready-to-register skills.
 * Failed connections are logged and skipped.
 */
export async function createMcpSkills(
  config: McpConfig,
  logger: Logger
): Promise<McpSkillResult[]> {
  const results: McpSkillResult[] = [];

  for (const [serverName, serverConfig] of Object.entries(config.servers)) {
    // Skip disabled servers
    if (!serverConfig.enabled) {
      logger.info({ server: serverName }, "MCP server disabled, skipping");
      continue;
    }

    try {
      logger.info({ server: serverName }, "Connecting to MCP server");

      // Create and connect client
      const client = new McpClientWrapper(serverName, serverConfig);
      await client.connect();

      // Discover and filter tools
      const allTools = await client.listTools();
      const filteredTools = filterMcpTools(allTools, serverConfig);

      logger.info(
        {
          server: serverName,
          totalTools: allTools.length,
          filteredTools: filteredTools.length,
          blocked: serverConfig.tool_blocklist,
        },
        "MCP server connected and tools discovered"
      );

      // Create skill with pre-connected client
      const skill = new McpServerSkill(
        serverName,
        serverConfig,
        filteredTools,
        client
      );

      results.push({ skill });
    } catch (err) {
      logger.error(
        {
          server: serverName,
          error: err instanceof Error ? err.message : String(err),
        },
        "Failed to connect to MCP server, skipping"
      );
    }
  }

  return results;
}
