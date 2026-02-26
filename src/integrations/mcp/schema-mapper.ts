import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { SkillToolDefinition } from "../../skills/base.js";
import type { McpServerConfig } from "../../utils/config.js";

/**
 * Map an MCP tool to a coda SkillToolDefinition with namespacing.
 * Tool name becomes mcp_{serverName}_{toolName}.
 * Description is prefixed with [MCP:{serverName}].
 *
 * If the server config has `tool_defaults`, those values are injected into
 * matching schema properties as `default` values and appended to the
 * description so the LLM uses them automatically.
 */
export function mapMcpToolToSkillTool(
  tool: Tool,
  serverName: string,
  config: McpServerConfig
): SkillToolDefinition {
  const namespacedName = `mcp_${serverName}_${tool.name}`;
  let prefixedDescription = `[MCP:${serverName}] ${tool.description ?? ""}`;

  // Deep-clone the schema so we don't mutate the original Tool object
  let inputSchema: Record<string, unknown> = JSON.parse(
    JSON.stringify(tool.inputSchema)
  );

  if (config.tool_defaults && Object.keys(config.tool_defaults).length > 0) {
    const properties = inputSchema.properties as
      | Record<string, Record<string, unknown>>
      | undefined;
    const required = inputSchema.required as string[] | undefined;
    const matchedDefaults: Record<string, unknown> = {};

    if (properties) {
      for (const [key, value] of Object.entries(config.tool_defaults)) {
        if (key in properties) {
          properties[key] = { ...properties[key], default: value };
          matchedDefaults[key] = value;
        }
      }

      // Remove defaulted params from required — LLM doesn't need to supply them explicitly
      if (required && Object.keys(matchedDefaults).length > 0) {
        inputSchema.required = required.filter((r) => !(r in matchedDefaults));
      }
    }

    if (Object.keys(matchedDefaults).length > 0) {
      const hint = Object.entries(matchedDefaults)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      prefixedDescription += `\nDefaults: ${hint}`;
    }
  }

  return {
    name: namespacedName,
    description: prefixedDescription,
    input_schema: inputSchema,
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
