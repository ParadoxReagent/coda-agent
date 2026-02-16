import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { SkillToolDefinition } from "../../skills/base.js";
import type { McpServerConfig } from "../../utils/config.js";

/**
 * Map an MCP tool to a coda SkillToolDefinition with namespacing.
 * Tool name becomes mcp_{serverName}_{toolName}.
 * Description is prefixed with [MCP:{serverName}].
 */
export function mapMcpToolToSkillTool(
  tool: Tool,
  serverName: string,
  config: McpServerConfig
): SkillToolDefinition {
  const namespacedName = `mcp_${serverName}_${tool.name}`;
  const prefixedDescription = `[MCP:${serverName}] ${tool.description ?? ""}`;

  return {
    name: namespacedName,
    description: prefixedDescription,
    input_schema: tool.inputSchema as Record<string, unknown>,
    requiresConfirmation: config.requires_confirmation.includes(tool.name),
    sensitive: config.sensitive_tools.includes(tool.name),
  };
}

/**
 * Extract the original MCP tool name from a namespaced tool name.
 * mcp_{serverName}_{toolName} → toolName
 */
export function extractMcpToolName(namespacedName: string): string {
  const parts = namespacedName.split("_");
  // Remove "mcp" and serverName prefix
  if (parts.length >= 3 && parts[0] === "mcp") {
    return parts.slice(2).join("_");
  }
  return namespacedName;
}

/**
 * Filter MCP tools based on allowlist/blocklist configuration.
 */
export function filterMcpTools(
  tools: Tool[],
  config: McpServerConfig
): Tool[] {
  return tools.filter((tool) => {
    // Check blocklist first
    if (config.tool_blocklist.includes(tool.name)) {
      return false;
    }

    // Check allowlist if configured
    if (config.tool_allowlist && config.tool_allowlist.length > 0) {
      return config.tool_allowlist.includes(tool.name);
    }

    return true;
  });
}
