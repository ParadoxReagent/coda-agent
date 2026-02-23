import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMcpSkills } from "../../../../src/integrations/mcp/factory.js";
import type { McpConfig } from "../../../../src/utils/config.js";
import type { Logger } from "../../../../src/utils/logger.js";

// Mock the McpServerManager
const mockRegisterServer = vi.fn();
const mockEnsureConnected = vi.fn().mockResolvedValue([
  {
    name: "test_tool",
    description: "A test tool",
    inputSchema: { type: "object", properties: {} },
  },
]);
const mockGetClient = vi.fn();
const mockStartIdleTimeoutMonitor = vi.fn();

vi.mock("../../../../src/integrations/mcp/manager.js", () => ({
  McpServerManager: vi.fn().mockImplementation(() => ({
    registerServer: mockRegisterServer,
    ensureConnected: mockEnsureConnected,
    getClient: mockGetClient,
    startIdleTimeoutMonitor: mockStartIdleTimeoutMonitor,
  })),
}));

describe("factory", () => {
  let mockLogger: Logger;
  let config: McpConfig;

  beforeEach(() => {
    vi.clearAllMocks();

    // Reset ensureConnected to default behavior after clearAllMocks
    mockEnsureConnected.mockResolvedValue([
      {
        name: "test_tool",
        description: "A test tool",
        inputSchema: { type: "object", properties: {} },
      },
    ]);

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

    it("logs lazy registration for default startup mode", async () => {
      await createMcpSkills(config, mockLogger);

      expect(mockLogger.info).toHaveBeenCalledWith(
        { server: "filesystem" },
        "MCP server registered (lazy mode, will connect on first use)"
      );
    });

    it("continues on connection failure and logs error", async () => {
      mockEnsureConnected.mockRejectedValueOnce(new Error("Connection refused"));

      config.servers.filesystem.startup_mode = "eager";
      config.servers.github = {
        enabled: true,
        startup_mode: "eager",
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

    it("applies tool blocklist via registerServer config", async () => {
      config.servers.filesystem.tool_blocklist = ["write", "delete"];
      config.servers.filesystem.startup_mode = "eager";

      await createMcpSkills(config, mockLogger);

      expect(mockRegisterServer).toHaveBeenCalledWith(
        "filesystem",
        expect.objectContaining({
          tool_blocklist: ["write", "delete"],
        })
      );
    });
  });
});
