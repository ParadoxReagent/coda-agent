import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpClientWrapper } from "../../../../src/integrations/mcp/client.js";
import type { McpServerConfig } from "../../../../src/utils/config.js";

// Mock the MCP SDK modules
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: vi.fn(),
    close: vi.fn(),
    listTools: vi.fn(),
    callTool: vi.fn(),
  })),
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn().mockImplementation(() => ({
    close: vi.fn(),
  })),
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: vi.fn().mockImplementation(() => ({
    close: vi.fn(),
  })),
}));

describe("McpClientWrapper", () => {
  let config: McpServerConfig;

  beforeEach(() => {
    vi.clearAllMocks();
    config = {
      enabled: true,
      transport: { type: "stdio", command: "npx", args: ["-y", "test-mcp-server"] },
      timeout_ms: 30000,
      tool_timeout_ms: 60000,
      tool_blocklist: [],
      requires_confirmation: [],
      sensitive_tools: [],
      max_response_size: 100000,
      auto_refresh_tools: false,
    };
  });

  describe("connect", () => {
    it("creates stdio transport for stdio config", async () => {
      const { StdioClientTransport } = await import(
        "@modelcontextprotocol/sdk/client/stdio.js"
      );

      const client = new McpClientWrapper("test", config);
      await client.connect();

      expect(StdioClientTransport).toHaveBeenCalledWith({
        command: "npx",
        args: ["-y", "test-mcp-server"],
        env: undefined,
        stderr: "pipe",
      });
    });

    it("creates http transport for http config", async () => {
      config.transport = {
        type: "http",
        url: "https://mcp.example.com",
        headers: { Authorization: "Bearer token" },
      };

      const { StreamableHTTPClientTransport } = await import(
        "@modelcontextprotocol/sdk/client/streamableHttp.js"
      );

      const client = new McpClientWrapper("test", config);
      await client.connect();

      expect(StreamableHTTPClientTransport).toHaveBeenCalledWith(
        expect.any(URL),
        {
          requestInit: {
            headers: { Authorization: "Bearer token" },
          },
        }
      );
    });
  });

  describe("listTools", () => {
    it("returns tools from MCP server", async () => {
      const mockTools = [
        {
          name: "test_tool",
          description: "A test tool",
          inputSchema: { type: "object", properties: {} },
        },
      ];

      const client = new McpClientWrapper("test", config);
      await client.connect();

      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const mockClientInstance = vi.mocked(Client).mock.results[1].value;
      vi.mocked(mockClientInstance.listTools).mockResolvedValue({ tools: mockTools });

      const tools = await client.listTools();

      expect(tools).toEqual(mockTools);
    });
  });

  describe("callTool", () => {
    it("calls MCP tool and serializes text content", async () => {
      const client = new McpClientWrapper("test", config);
      await client.connect();

      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const mockClientInstance = vi.mocked(Client).mock.results[1].value;
      vi.mocked(mockClientInstance.callTool).mockResolvedValue({
        content: [{ type: "text", text: "Tool result" }],
        isError: false,
      });

      const result = await client.callTool("test_tool", { arg: "value" });

      expect(result.content).toBe("Tool result");
      expect(result.isError).toBe(false);
    });

    it("serializes multiple text blocks", async () => {
      const client = new McpClientWrapper("test", config);
      await client.connect();

      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const mockClientInstance = vi.mocked(Client).mock.results[1].value;
      vi.mocked(mockClientInstance.callTool).mockResolvedValue({
        content: [
          { type: "text", text: "First block" },
          { type: "text", text: "Second block" },
        ],
        isError: false,
      });

      const result = await client.callTool("test_tool", {});

      expect(result.content).toBe("First block\nSecond block");
    });

    it("handles image content", async () => {
      const client = new McpClientWrapper("test", config);
      await client.connect();

      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const mockClientInstance = vi.mocked(Client).mock.results[1].value;
      vi.mocked(mockClientInstance.callTool).mockResolvedValue({
        content: [{ type: "image", data: "base64data", mimeType: "image/png" }],
        isError: false,
      });

      const result = await client.callTool("test_tool", {});

      expect(result.content).toContain("[Image:");
    });

    it("handles resource content with text", async () => {
      const client = new McpClientWrapper("test", config);
      await client.connect();

      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const mockClientInstance = vi.mocked(Client).mock.results[1].value;
      vi.mocked(mockClientInstance.callTool).mockResolvedValue({
        content: [
          {
            type: "resource",
            resource: { uri: "file:///test.txt", text: "Resource content" },
          },
        ],
        isError: false,
      });

      const result = await client.callTool("test_tool", {});

      expect(result.content).toBe("Resource content");
    });

    it("preserves isError flag", async () => {
      const client = new McpClientWrapper("test", config);
      await client.connect();

      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const mockClientInstance = vi.mocked(Client).mock.results[1].value;
      vi.mocked(mockClientInstance.callTool).mockResolvedValue({
        content: [{ type: "text", text: "Error occurred" }],
        isError: true,
      });

      const result = await client.callTool("test_tool", {});

      expect(result.isError).toBe(true);
    });
  });

  describe("disconnect", () => {
    it("closes client and transport", async () => {
      const client = new McpClientWrapper("test", config);
      await client.connect();

      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const mockClientInstance = vi.mocked(Client).mock.results[1].value;

      await client.disconnect();

      expect(mockClientInstance.close).toHaveBeenCalled();
    });
  });
});
