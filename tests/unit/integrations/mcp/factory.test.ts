import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMcpSkills } from "../../../../src/integrations/mcp/factory.js";
import type { McpConfig } from "../../../../src/utils/config.js";
import type { Logger } from "../../../../src/utils/logger.js";

// Mock the McpClientWrapper
vi.mock("../../../../src/integrations/mcp/client.js", () => ({
  McpClientWrapper: vi.fn().mockImplementation(() => ({
    connect: vi.fn(),
    listTools: vi.fn().mockResolvedValue([
      {
        name: "test_tool",
        description: "A test tool",
        inputSchema: { type: "object", properties: {} },
      },
    ]),
    disconnect: vi.fn(),
    isConnected: vi.fn().mockReturnValue(false),
    getIdleTimeMinutes: vi.fn().mockReturnValue(0),
  })),
}));

describe("factory", () => {
  let mockLogger: Logger;
  let config: McpConfig;

  beforeEach(() => {
    vi.clearAllMocks();

    mockLogger = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger;

    config = {
      servers: {
        filesystem: {
          enabled: true,
          transport: {
            type: "stdio",
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
          },
          timeout_ms: 30000,
          tool_timeout_ms: 60000,
          tool_blocklist: [],
          requires_confirmation: [],
          sensitive_tools: [],
          max_response_size: 100000,
          auto_refresh_tools: false,
        },
      },
    };
  });

  describe("createMcpSkills", () => {
    it("creates skills for enabled servers", async () => {
      const { skills } = await createMcpSkills(config, mockLogger);

      expect(skills).toHaveLength(1);
      expect(skills[0].skill.name).toBe("mcp_filesystem");
    });

    it("skips disabled servers", async () => {
      config.servers.filesystem.enabled = false;

      const { skills } = await createMcpSkills(config, mockLogger);

      expect(skills).toHaveLength(0);
      expect(mockLogger.info).toHaveBeenCalledWith(
        { server: "filesystem" },
        "MCP server disabled, skipping"
      );
    });

    it("handles multiple servers", async () => {
      config.servers.github = {
        enabled: true,
        transport: {
          type: "http",
          url: "https://mcp.example.com/github",
        },
        timeout_ms: 30000,
        tool_timeout_ms: 60000,
        tool_blocklist: [],
        requires_confirmation: [],
        sensitive_tools: [],
        max_response_size: 100000,
        auto_refresh_tools: false,
      };

      const { skills } = await createMcpSkills(config, mockLogger);

      expect(skills).toHaveLength(2);
      expect(skills.map((s) => s.skill.name)).toContain("mcp_filesystem");
      expect(skills.map((s) => s.skill.name)).toContain("mcp_github");
    });

    it("logs connection success with tool count", async () => {
      // Use eager mode so connection happens immediately during factory init
      config.servers.filesystem.startup_mode = "eager";

      await createMcpSkills(config, mockLogger);

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          server: "filesystem",
          totalTools: 1,
          filteredTools: 1,
        }),
        "MCP server connected and tools discovered"
      );
    });

    it("continues on connection failure and logs error", async () => {
      const { McpClientWrapper } = await import("../../../../src/integrations/mcp/client.js");

      // First call (filesystem, eager mode) fails to connect
      vi.mocked(McpClientWrapper).mockImplementationOnce(() => ({
        connect: vi.fn().mockRejectedValue(new Error("Connection refused")),
        listTools: vi.fn(),
        disconnect: vi.fn(),
        isConnected: vi.fn().mockReturnValue(false),
        getIdleTimeMinutes: vi.fn().mockReturnValue(0),
      })) as any;

      config.servers.filesystem.startup_mode = "eager";
      config.servers.github = {
        enabled: true,
        transport: { type: "http", url: "https://mcp.example.com" },
        timeout_ms: 30000,
        tool_timeout_ms: 60000,
        tool_blocklist: [],
        requires_confirmation: [],
        sensitive_tools: [],
        max_response_size: 100000,
        auto_refresh_tools: false,
      };

      const { skills } = await createMcpSkills(config, mockLogger);

      // First server (eager) failed, second (lazy) should still be created
      expect(skills).toHaveLength(1);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          server: "filesystem",
          error: "Connection refused",
        }),
        "Failed to initialize MCP server, skipping"
      );
    });

    it("applies tool blocklist during discovery", async () => {
      const { McpClientWrapper } = await import("../../../../src/integrations/mcp/client.js");

      vi.mocked(McpClientWrapper).mockImplementationOnce(() => ({
        connect: vi.fn(),
        listTools: vi.fn().mockResolvedValue([
          { name: "read", description: "Read", inputSchema: {} },
          { name: "write", description: "Write", inputSchema: {} },
          { name: "delete", description: "Delete", inputSchema: {} },
        ]),
        disconnect: vi.fn(),
        isConnected: vi.fn().mockReturnValue(false),
        getIdleTimeMinutes: vi.fn().mockReturnValue(0),
      })) as any;

      config.servers.filesystem.tool_blocklist = ["write", "delete"];
      config.servers.filesystem.startup_mode = "eager";

      await createMcpSkills(config, mockLogger);

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          totalTools: 3,
          filteredTools: 1,
          blocked: ["write", "delete"],
        }),
        "MCP server connected and tools discovered"
      );
    });
  });
});
