import { describe, it, expect } from "vitest";
import {
  mapMcpToolToSkillTool,
  extractMcpToolName,
  filterMcpTools,
} from "../../../../src/integrations/mcp/schema-mapper.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerConfig } from "../../../../src/utils/config.js";

describe("schema-mapper", () => {
  describe("mapMcpToolToSkillTool", () => {
    it("namespaces tool name correctly", () => {
      const mcpTool: Tool = {
        name: "read_file",
        description: "Read a file from filesystem",
        inputSchema: { type: "object", properties: {} },
      };

      const config: McpServerConfig = {
        enabled: true,
        transport: { type: "stdio", command: "test", args: [] },
        timeout_ms: 30000,
        tool_timeout_ms: 60000,
        tool_blocklist: [],
        requires_confirmation: [],
        sensitive_tools: [],
        max_response_size: 100000,
        auto_refresh_tools: false,
      };

      const result = mapMcpToolToSkillTool(mcpTool, "filesystem", config);

      expect(result.name).toBe("mcp_filesystem_read_file");
    });

    it("prefixes description with server name", () => {
      const mcpTool: Tool = {
        name: "read_file",
        description: "Read a file from filesystem",
        inputSchema: { type: "object", properties: {} },
      };

      const config: McpServerConfig = {
        enabled: true,
        transport: { type: "stdio", command: "test", args: [] },
        timeout_ms: 30000,
        tool_timeout_ms: 60000,
        tool_blocklist: [],
        requires_confirmation: [],
        sensitive_tools: [],
        max_response_size: 100000,
        auto_refresh_tools: false,
      };

      const result = mapMcpToolToSkillTool(mcpTool, "filesystem", config);

      expect(result.description).toContain("[MCP:filesystem]");
      expect(result.description).toContain("Read a file from filesystem");
    });

    it("maps requiresConfirmation from config", () => {
      const mcpTool: Tool = {
        name: "write_file",
        description: "Write a file",
        inputSchema: { type: "object", properties: {} },
      };

      const config: McpServerConfig = {
        enabled: true,
        transport: { type: "stdio", command: "test", args: [] },
        timeout_ms: 30000,
        tool_timeout_ms: 60000,
        tool_blocklist: [],
        requires_confirmation: ["write_file"],
        sensitive_tools: [],
        max_response_size: 100000,
        auto_refresh_tools: false,
      };

      const result = mapMcpToolToSkillTool(mcpTool, "filesystem", config);

      expect(result.requiresConfirmation).toBe(true);
    });

    it("maps sensitive from config", () => {
      const mcpTool: Tool = {
        name: "read_secret",
        description: "Read a secret",
        inputSchema: { type: "object", properties: {} },
      };

      const config: McpServerConfig = {
        enabled: true,
        transport: { type: "stdio", command: "test", args: [] },
        timeout_ms: 30000,
        tool_timeout_ms: 60000,
        tool_blocklist: [],
        requires_confirmation: [],
        sensitive_tools: ["read_secret"],
        max_response_size: 100000,
        auto_refresh_tools: false,
      };

      const result = mapMcpToolToSkillTool(mcpTool, "secrets", config);

      expect(result.sensitive).toBe(true);
    });
  });

  describe("extractMcpToolName", () => {
    it("extracts original tool name from namespaced name", () => {
      const result = extractMcpToolName("mcp_filesystem_read_file");
      expect(result).toBe("read_file");
    });

    it("handles tool names with underscores", () => {
      const result = extractMcpToolName("mcp_github_create_pull_request");
      expect(result).toBe("create_pull_request");
    });

    it("returns original name if not namespaced", () => {
      const result = extractMcpToolName("some_tool");
      expect(result).toBe("some_tool");
    });
  });

  describe("filterMcpTools", () => {
    const sampleTools: Tool[] = [
      {
        name: "read_file",
        description: "Read a file",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "write_file",
        description: "Write a file",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "delete_file",
        description: "Delete a file",
        inputSchema: { type: "object", properties: {} },
      },
    ];

    it("blocks tools in blocklist", () => {
      const config: McpServerConfig = {
        enabled: true,
        transport: { type: "stdio", command: "test", args: [] },
        timeout_ms: 30000,
        tool_timeout_ms: 60000,
        tool_blocklist: ["write_file", "delete_file"],
        requires_confirmation: [],
        sensitive_tools: [],
        max_response_size: 100000,
        auto_refresh_tools: false,
      };

      const result = filterMcpTools(sampleTools, config);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("read_file");
    });

    it("allows only tools in allowlist", () => {
      const config: McpServerConfig = {
        enabled: true,
        transport: { type: "stdio", command: "test", args: [] },
        timeout_ms: 30000,
        tool_timeout_ms: 60000,
        tool_blocklist: [],
        tool_allowlist: ["read_file"],
        requires_confirmation: [],
        sensitive_tools: [],
        max_response_size: 100000,
        auto_refresh_tools: false,
      };

      const result = filterMcpTools(sampleTools, config);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("read_file");
    });

    it("blocklist takes precedence over allowlist", () => {
      const config: McpServerConfig = {
        enabled: true,
        transport: { type: "stdio", command: "test", args: [] },
        timeout_ms: 30000,
        tool_timeout_ms: 60000,
        tool_blocklist: ["read_file"],
        tool_allowlist: ["read_file", "write_file"],
        requires_confirmation: [],
        sensitive_tools: [],
        max_response_size: 100000,
        auto_refresh_tools: false,
      };

      const result = filterMcpTools(sampleTools, config);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("write_file");
    });

    it("allows all tools when no filters configured", () => {
      const config: McpServerConfig = {
        enabled: true,
        transport: { type: "stdio", command: "test", args: [] },
        timeout_ms: 30000,
        tool_timeout_ms: 60000,
        tool_blocklist: [],
        requires_confirmation: [],
        sensitive_tools: [],
        max_response_size: 100000,
        auto_refresh_tools: false,
      };

      const result = filterMcpTools(sampleTools, config);

      expect(result).toHaveLength(3);
    });
  });
});
