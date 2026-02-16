import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServerSkill } from "../../../../src/integrations/mcp/skill.js";
import type { McpServerConfig } from "../../../../src/utils/config.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpClientWrapper } from "../../../../src/integrations/mcp/client.js";

describe("McpServerSkill", () => {
  let mockClient: McpClientWrapper;
  let config: McpServerConfig;
  let sampleTools: Tool[];

  beforeEach(() => {
    config = {
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

    sampleTools = [
      {
        name: "read_file",
        description: "Read a file",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
          },
          required: ["path"],
        },
      },
    ];

    mockClient = {
      callTool: vi.fn(),
      disconnect: vi.fn(),
    } as unknown as McpClientWrapper;
  });

  describe("constructor", () => {
    it("creates skill with namespaced name", () => {
      const skill = new McpServerSkill("filesystem", config, sampleTools, mockClient);

      expect(skill.name).toBe("mcp_filesystem");
    });

    it("uses config description if provided", () => {
      config.description = "Custom filesystem integration";
      const skill = new McpServerSkill("filesystem", config, sampleTools, mockClient);

      expect(skill.description).toBe("Custom filesystem integration");
    });

    it("generates default description if not provided", () => {
      const skill = new McpServerSkill("filesystem", config, sampleTools, mockClient);

      expect(skill.description).toContain("filesystem");
    });

    it("marks skill as integration kind", () => {
      const skill = new McpServerSkill("filesystem", config, sampleTools, mockClient);

      expect(skill.kind).toBe("integration");
    });
  });

  describe("getTools", () => {
    it("returns namespaced tools", () => {
      const skill = new McpServerSkill("filesystem", config, sampleTools, mockClient);
      const tools = skill.getTools();

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe("mcp_filesystem_read_file");
      expect(tools[0].description).toContain("[MCP:filesystem]");
    });
  });

  describe("execute", () => {
    it("calls MCP tool with correct arguments", async () => {
      vi.mocked(mockClient.callTool).mockResolvedValue({
        content: "File content",
        isError: false,
      });

      const skill = new McpServerSkill("filesystem", config, sampleTools, mockClient);
      await skill.execute("mcp_filesystem_read_file", { path: "/test.txt" });

      expect(mockClient.callTool).toHaveBeenCalledWith("read_file", {
        path: "/test.txt",
      });
    });

    it("returns sanitized success response", async () => {
      vi.mocked(mockClient.callTool).mockResolvedValue({
        content: "File content here",
        isError: false,
      });

      const skill = new McpServerSkill("filesystem", config, sampleTools, mockClient);
      const result = await skill.execute("mcp_filesystem_read_file", { path: "/test.txt" });

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.content).toContain("<external_data>");
      expect(parsed.content).toContain("File content here");
      expect(parsed.truncated).toBe(false);
    });

    it("truncates oversized responses", async () => {
      const largeContent = "A".repeat(150000);
      vi.mocked(mockClient.callTool).mockResolvedValue({
        content: largeContent,
        isError: false,
      });

      const skill = new McpServerSkill("filesystem", config, sampleTools, mockClient);
      const result = await skill.execute("mcp_filesystem_read_file", { path: "/test.txt" });

      const parsed = JSON.parse(result);
      expect(parsed.truncated).toBe(true);
      expect(parsed.content.length).toBeLessThan(largeContent.length);
    });

    it("handles error responses from MCP tool", async () => {
      vi.mocked(mockClient.callTool).mockResolvedValue({
        content: "Error: File not found",
        isError: true,
      });

      const skill = new McpServerSkill("filesystem", config, sampleTools, mockClient);
      const result = await skill.execute("mcp_filesystem_read_file", { path: "/missing.txt" });

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.isError).toBe(true);
    });

    it("handles exceptions during tool call", async () => {
      vi.mocked(mockClient.callTool).mockRejectedValue(new Error("Connection timeout"));

      const skill = new McpServerSkill("filesystem", config, sampleTools, mockClient);
      const result = await skill.execute("mcp_filesystem_read_file", { path: "/test.txt" });

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("Connection timeout");
    });

    it("forwards output_files from MCP response to top level", async () => {
      const mcpResponse = JSON.stringify({
        success: true,
        message: "PDFs merged successfully",
        output_files: [
          { name: "merged.pdf", path: "/tmp/output/merged.pdf" }
        ]
      });

      vi.mocked(mockClient.callTool).mockResolvedValue({
        content: mcpResponse,
        isError: false,
      });

      const skill = new McpServerSkill("pdf", config, sampleTools, mockClient);
      const result = await skill.execute("mcp_pdf_merge_pdfs", {
        files: ["/tmp/file1.pdf", "/tmp/file2.pdf"],
        output_path: "/tmp/output/merged.pdf"
      });

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.output_files).toBeDefined();
      expect(parsed.output_files).toHaveLength(1);
      expect(parsed.output_files[0].name).toBe("merged.pdf");
      expect(parsed.output_files[0].path).toBe("/tmp/output/merged.pdf");
    });

    it("handles multiple output_files from MCP response", async () => {
      const mcpResponse = JSON.stringify({
        success: true,
        message: "PDF split successfully",
        output_files: [
          { name: "part1.pdf", path: "/tmp/output/part1.pdf" },
          { name: "part2.pdf", path: "/tmp/output/part2.pdf" },
          { name: "part3.pdf", path: "/tmp/output/part3.pdf" }
        ]
      });

      vi.mocked(mockClient.callTool).mockResolvedValue({
        content: mcpResponse,
        isError: false,
      });

      const skill = new McpServerSkill("pdf", config, sampleTools, mockClient);
      const result = await skill.execute("mcp_pdf_split_pdf", {
        file: "/tmp/document.pdf",
        pages: "1-3",
        output_dir: "/tmp/output"
      });

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.output_files).toBeDefined();
      expect(parsed.output_files).toHaveLength(3);
    });

    it("handles MCP response without output_files", async () => {
      const mcpResponse = JSON.stringify({
        success: true,
        text: { "1": "Page 1 content", "2": "Page 2 content" }
      });

      vi.mocked(mockClient.callTool).mockResolvedValue({
        content: mcpResponse,
        isError: false,
      });

      const skill = new McpServerSkill("pdf", config, sampleTools, mockClient);
      const result = await skill.execute("mcp_pdf_extract_text", {
        file: "/tmp/document.pdf"
      });

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.output_files).toBeUndefined();
    });

    it("handles non-JSON MCP response gracefully", async () => {
      vi.mocked(mockClient.callTool).mockResolvedValue({
        content: "Plain text response without JSON",
        isError: false,
      });

      const skill = new McpServerSkill("filesystem", config, sampleTools, mockClient);
      const result = await skill.execute("mcp_filesystem_read_file", { path: "/test.txt" });

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.output_files).toBeUndefined();
      // Should still sanitize the content
      expect(parsed.content).toContain("<external_data>");
    });

    it("ignores invalid output_files format", async () => {
      const mcpResponse = JSON.stringify({
        success: true,
        output_files: "not-an-array"  // Invalid format
      });

      vi.mocked(mockClient.callTool).mockResolvedValue({
        content: mcpResponse,
        isError: false,
      });

      const skill = new McpServerSkill("pdf", config, sampleTools, mockClient);
      const result = await skill.execute("mcp_pdf_merge_pdfs", {
        files: ["/tmp/file1.pdf"],
        output_path: "/tmp/merged.pdf"
      });

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.output_files).toBeUndefined();
    });
  });

  describe("shutdown", () => {
    it("disconnects client on shutdown", async () => {
      const skill = new McpServerSkill("filesystem", config, sampleTools, mockClient);
      await skill.shutdown();

      expect(mockClient.disconnect).toHaveBeenCalled();
    });
  });

  describe("getRequiredConfig", () => {
    it("returns empty array", () => {
      const skill = new McpServerSkill("filesystem", config, sampleTools, mockClient);
      expect(skill.getRequiredConfig()).toEqual([]);
    });
  });
});
