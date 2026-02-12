import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SubagentManager } from "../../src/core/subagent-manager.js";
import { SkillRegistry } from "../../src/skills/registry.js";
import { ContentSanitizer } from "../../src/core/sanitizer.js";
import {
  createMockLogger,
  createMockProvider,
  createMockSkill,
  createMockEventBus,
  createMockRateLimiter,
} from "../helpers/mocks.js";
import type { SubagentConfig } from "../../src/utils/config.js";

// Mock correlation
const mockGetCurrentContext = vi.fn(() => undefined as any);
vi.mock("../../src/core/correlation.js", () => ({
  getCurrentContext: () => mockGetCurrentContext(),
  withContext: vi.fn((_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  createCorrelationId: vi.fn(() => "corr-id"),
}));

function createTestConfig(overrides?: Partial<SubagentConfig>): SubagentConfig {
  return {
    enabled: true,
    default_timeout_minutes: 1,
    max_timeout_minutes: 2,
    sync_timeout_seconds: 10,
    max_concurrent_per_user: 3,
    max_concurrent_global: 10,
    archive_ttl_minutes: 1,
    max_tool_calls_per_run: 10,
    default_token_budget: 50000,
    max_token_budget: 200000,
    spawn_rate_limit: { max_requests: 10, window_seconds: 3600 },
    cleanup_interval_seconds: 300,
    ...overrides,
  };
}

function createTestProviderManager() {
  const provider = createMockProvider();
  return {
    getForUser: vi.fn(async () => ({
      provider,
      model: "mock-model",
      failedOver: false,
    })),
    trackUsage: vi.fn(async () => {}),
  };
}

describe("Subagent Security", () => {
  let registry: SkillRegistry;
  let logger: ReturnType<typeof createMockLogger>;
  let eventBus: ReturnType<typeof createMockEventBus>;

  beforeEach(() => {
    logger = createMockLogger();
    registry = new SkillRegistry(logger);
    eventBus = createMockEventBus();
    mockGetCurrentContext.mockReturnValue(undefined);

    const skill = createMockSkill({
      name: "notes",
      tools: [
        { name: "note_search", description: "Search", input_schema: { type: "object", properties: {} } },
      ],
    });
    registry.register(skill);
  });

  describe("recursive spawn prevention", () => {
    it("blocks spawn when subagentRunId is present in context", async () => {
      mockGetCurrentContext.mockReturnValue({
        correlationId: "test",
        userId: "user-1",
        subagentRunId: "parent-run-123",
      });

      const manager = new SubagentManager(
        createTestConfig(),
        registry,
        createTestProviderManager() as any,
        eventBus,
        null,
        logger
      );

      await expect(
        manager.spawn("user-1", "discord", "Nested spawn attempt")
      ).rejects.toThrow("recursion blocked");

      await manager.shutdown();
    });

    it("blocks delegateSync when subagentRunId is present in context", async () => {
      mockGetCurrentContext.mockReturnValue({
        correlationId: "test",
        userId: "user-1",
        subagentRunId: "parent-run-123",
      });

      const manager = new SubagentManager(
        createTestConfig(),
        registry,
        createTestProviderManager() as any,
        eventBus,
        null,
        logger
      );

      await expect(
        manager.delegateSync("user-1", "discord", "Nested delegate", {
          toolsNeeded: ["note_search"],
        })
      ).rejects.toThrow("recursion blocked");

      await manager.shutdown();
    });
  });

  describe("user isolation", () => {
    it("user A cannot stop user B's run", async () => {
      const manager = new SubagentManager(
        createTestConfig(),
        registry,
        createTestProviderManager() as any,
        eventBus,
        null,
        logger
      );

      const { runId } = await manager.spawn("user-A", "discord", "Task");

      await expect(
        manager.stopRun("user-B", runId)
      ).rejects.toThrow("only stop your own");

      await manager.shutdown();
    });

    it("user A cannot view user B's run info", async () => {
      const manager = new SubagentManager(
        createTestConfig(),
        registry,
        createTestProviderManager() as any,
        eventBus,
        null,
        logger
      );

      const { runId } = await manager.spawn("user-A", "discord", "Task");
      const info = manager.getRunInfo("user-B", runId);
      expect(info).toBeNull();

      await manager.shutdown();
    });

    it("user A cannot view user B's run log", async () => {
      const manager = new SubagentManager(
        createTestConfig(),
        registry,
        createTestProviderManager() as any,
        eventBus,
        null,
        logger
      );

      const { runId } = await manager.spawn("user-A", "discord", "Task");
      const log = manager.getRunLog("user-B", runId);
      expect(log).toBeNull();

      await manager.shutdown();
    });
  });

  describe("injection sanitization", () => {
    it("sanitizeSubagentOutput escapes HTML tags", () => {
      const malicious = '<script>document.cookie</script>';
      const sanitized = ContentSanitizer.sanitizeSubagentOutput(malicious);
      expect(sanitized).not.toContain("<script>");
      expect(sanitized).toContain("&lt;script&gt;");
    });

    it("sanitizeSubagentOutput wraps in subagent_result tags", () => {
      const result = ContentSanitizer.sanitizeSubagentOutput("Safe output");
      expect(result).toContain("<subagent_result>");
      expect(result).toContain("</subagent_result>");
      expect(result).toContain("untrusted data");
    });
  });

  describe("rate limiting", () => {
    it("enforces spawn rate limit", async () => {
      const rateLimiter = createMockRateLimiter(false);
      const manager = new SubagentManager(
        createTestConfig(),
        registry,
        createTestProviderManager() as any,
        eventBus,
        rateLimiter as any,
        logger
      );

      await expect(
        manager.spawn("user-1", "discord", "Rate limited task")
      ).rejects.toThrow("rate limit");

      await manager.shutdown();
    });
  });

  describe("mainAgentOnly enforcement", () => {
    it("subagent tools with mainAgentOnly are filtered from subagent tool list", () => {
      const subagentToolSkill = createMockSkill({
        name: "control",
        tools: [
          { name: "dangerous_action", description: "Dangerous", input_schema: { type: "object", properties: {} }, mainAgentOnly: true },
          { name: "safe_action", description: "Safe", input_schema: { type: "object", properties: {} } },
        ],
      });
      registry.register(subagentToolSkill);

      // Main agent sees all tools
      const allTools = registry.getToolDefinitions();
      expect(allTools.map((t) => t.name)).toContain("dangerous_action");

      // Subagent filtering excludes mainAgentOnly
      const subagentTools = registry.getToolDefinitions({ excludeMainAgentOnly: true });
      expect(subagentTools.map((t) => t.name)).not.toContain("dangerous_action");
      expect(subagentTools.map((t) => t.name)).toContain("safe_action");
    });
  });

  describe("concurrency limits", () => {
    it("rejects 4th spawn when max_concurrent_per_user is 3", async () => {
      const manager = new SubagentManager(
        createTestConfig({ max_concurrent_per_user: 3 }),
        registry,
        createTestProviderManager() as any,
        eventBus,
        null,
        logger
      );

      await manager.spawn("user-1", "discord", "Task 1");
      await manager.spawn("user-1", "discord", "Task 2");
      await manager.spawn("user-1", "discord", "Task 3");

      await expect(
        manager.spawn("user-1", "discord", "Task 4")
      ).rejects.toThrow("Maximum concurrent subagents per user");

      await manager.shutdown();
    });
  });
});
