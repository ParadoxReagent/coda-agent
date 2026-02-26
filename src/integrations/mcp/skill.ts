import type { Skill, SkillToolDefinition } from "../../skills/base.js";
import type { SkillContext } from "../../skills/context.js";
import type { McpServerConfig } from "../../utils/config.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerManager } from "./manager.js";
import { mapMcpToolToSkillTool, extractMcpToolName } from "./schema-mapper.js";
import { sanitizeMcpResponse, truncateMcpResponse } from "./sanitizer.js";

export class McpServerSkill implements Skill {
  readonly name: string;
  readonly description: string;
  readonly kind = "integration" as const;

  private serverName: string;
  private config: McpServerConfig;
  private tools: SkillToolDefinition[];
  private manager: McpServerManager;

  constructor(
    serverName: string,
    config: McpServerConfig,
    tools: Tool[],
    manager: McpServerManager
  ) {
    this.serverName = serverName;
    this.config = config;
    this.name = `mcp_${serverName}`;
    this.description =
      config.description ?? `MCP server integration: ${serverName}`;
    this.manager = manager;

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
      // Ensure connected (lazy initialization)
      const tools = await this.manager.ensureConnected(this.serverName);

      // Update tools if this is the first connection (lazy mode)
      if (this.tools.length === 0 && tools.length > 0) {
        this.tools = tools.map((tool) =>
          mapMcpToolToSkillTool(tool, this.serverName, this.config)
        );
      }

      // Get client and call MCP tool
      const client = this.manager.getClient(this.serverName);
      if (!client) {
        throw new Error(`MCP client not found for server: ${this.serverName}`);
      }

      // Inject tool_defaults for any parameters the LLM omitted
      const mergedInput = this.config.tool_defaults
        ? { ...this.config.tool_defaults, ...toolInput }
        : toolInput;

      const result = await client.callTool(mcpToolName, mergedInput);

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
    // Connection handled by manager (eager or lazy)
  }

  async shutdown(): Promise<void> {
    // Disconnection handled by manager
  }
}
