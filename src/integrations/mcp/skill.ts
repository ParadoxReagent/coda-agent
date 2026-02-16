import type { Skill, SkillToolDefinition } from "../../skills/base.js";
import type { SkillContext } from "../../skills/context.js";
import type { McpServerConfig } from "../../utils/config.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { McpClientWrapper } from "./client.js";
import { mapMcpToolToSkillTool, extractMcpToolName } from "./schema-mapper.js";
import { sanitizeMcpResponse, truncateMcpResponse } from "./sanitizer.js";

export class McpServerSkill implements Skill {
  readonly name: string;
  readonly description: string;
  readonly kind = "integration" as const;

  private config: McpServerConfig;
  private tools: SkillToolDefinition[];
  private client: McpClientWrapper;

  constructor(
    serverName: string,
    config: McpServerConfig,
    tools: Tool[],
    client: McpClientWrapper
  ) {
    this.config = config;
    this.name = `mcp_${serverName}`;
    this.description =
      config.description ?? `MCP server integration: ${serverName}`;
    this.client = client;

    // Pre-map tools to SkillToolDefinitions
    this.tools = tools.map((tool) =>
      mapMcpToolToSkillTool(tool, serverName, config)
    );
  }

  getTools(): SkillToolDefinition[] {
    return this.tools;
  }

  async execute(
    toolName: string,
    toolInput: Record<string, unknown>
  ): Promise<string> {
    // Strip namespace to get original MCP tool name
    const mcpToolName = extractMcpToolName(toolName);

    try {
      // Call MCP tool
      const result = await this.client.callTool(mcpToolName, toolInput);

      // Truncate response if needed
      const { content, truncated } = truncateMcpResponse(
        result.content,
        this.config.max_response_size
      );

      // Extract output_files from raw content before sanitization
      // The orchestrator's extractOutputFiles looks for output_files at the top level
      let outputFiles: Array<{ name: string; path: string }> | undefined;
      try {
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed.output_files)) {
          outputFiles = parsed.output_files;
        }
      } catch {
        // Not JSON or no output_files, continue without
      }

      // Sanitize the response
      const sanitized = sanitizeMcpResponse(content);

      // Return as JSON with metadata, hoisting output_files to top level
      const response: Record<string, unknown> = {
        success: !result.isError,
        content: sanitized,
        truncated,
        isError: result.isError,
      };

      if (outputFiles) {
        response.output_files = outputFiles;
      }

      return JSON.stringify(response);
    } catch (err) {
      return JSON.stringify({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  getRequiredConfig(): string[] {
    return [];
  }

  async startup(_ctx: SkillContext): Promise<void> {
    // Client is already connected by factory
  }

  async shutdown(): Promise<void> {
    await this.client.disconnect();
  }
}
