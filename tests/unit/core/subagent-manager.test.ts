import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SubagentManager, type SubagentRunRecord } from "../../../src/core/subagent-manager.js";
import { SkillRegistry } from "../../../src/skills/registry.js";
import {
  createMockLogger,
  createMockProvider,
  createMockSkill,
  createMockEventBus,
  createMockRateLimiter,
} from "../../helpers/mocks.js";
import type { SubagentConfig } from "../../../src/utils/config.js";

// Mock the correlation module
vi.mock("../../../src/core/correlation.js", () => ({
  getCurrentContext: vi.fn(() => undefined),
  withContext: vi.fn((_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  createCorrelationId: vi.fn(() => "mock-correlation-id"),
}));

function createDefaultConfig(): SubagentConfig {
  return {
    enabled: true,
    default_timeout_minutes: 5,
    max_timeout_minutes: 10,
    sync_timeout_seconds: 120,
    max_concurrent_per_user: 3,
    max_concurrent_global: 10,
    archive_ttl_minutes: 60,
    max_tool_calls_per_run: 25,
    default_token_budget: 50000,
    max_token_budget: 200000,
    spawn_rate_limit: { max_requests: 10, window_seconds: 3600 },
    cleanup_interval_seconds: 60,
  };
}

function createMockProviderManager() {
  const provider = createMockProvider();
  return {
    getForUser: vi.fn(async () => ({
      provider,
      model: "mock-model",
      failedOver: false,
    })),
    getForUserTiered: vi.fn(async () => ({
      provider,
      model: "mock-model",
      failedOver: false,
    })),
    isTierEnabled: vi.fn(() => false),
    trackUsage: vi.fn(async () => {}),
    listProviders: vi.fn(() => []),
    setUserPreference: vi.fn(),
    usage: { getDailyUsage: vi.fn(() => []), getTodayTotalCost: vi.fn(() => 0) },
  };
}

describe("SubagentManager", () => {
  let config: SubagentConfig;
  let registry: SkillRegistry;
  let logger: ReturnType<typeof createMockLogger>;
  let eventBus: ReturnType<typeof createMockEventBus>;
  let providerManager: ReturnType<typeof createMockProviderManager>;
  let rateLimiter: ReturnType<typeof createMockRateLimiter>;
  let manager: SubagentManager;

  beforeEach(() => {
    config = createDefaultConfig();
    logger = createMockLogger();
    registry = new SkillRegistry(logger);
    eventBus = createMockEventBus();
    providerManager = createMockProviderManager();
    rateLimiter = createMockRateLimiter(true);

    // Register a basic skill so tool validation works
    const skill = createMockSkill({
      name: "notes",
      tools: [
        {
          name: "note_search",
          description: "Search notes",
          input_schema: { type: "object", properties: {} },
        },
        {
          name: "note_save",
          description: "Save note",
          input_schema: { type: "object", properties: {} },
        },
      ],
    });
    registry.register(skill);

    manager = new SubagentManager(
      config,
      registry,
      providerManager as any,
      eventBus,
      rateLimiter as any,
      logger
    );
  });

  afterEach(async () => {
    await manager.shutdown();
  });

  describe("spawn()", () => {
    it("returns accepted status with a runId", async () => {
      const result = await manager.spawn("user-1", "discord", "Research something");
      expect(result.status).toBe("accepted");
      expect(result.runId).toBeDefined();
      expect(typeof result.runId).toBe("string");
    });

    it("publishes a subagent.spawned event", async () => {
      await manager.spawn("user-1", "discord", "Test task");
      const event = eventBus.publishedEvents.find(
        (e) => e.eventType === "subagent.spawned"
      );
      expect(event).toBeDefined();
      expect(event!.payload.userId).toBe("user-1");
    });

    it("tracks the run in active runs", async () => {
      const { runId } = await manager.spawn("user-1", "discord", "Task");
      expect(manager.getActiveRunCount("user-1")).toBe(1);
      expect(manager.getTotalActiveRunCount()).toBe(1);
    });

    it("rejects when subagents are disabled", async () => {
      config.enabled = false;
      manager = new SubagentManager(config, registry, providerManager as any, eventBus, rateLimiter as any, logger);

      await expect(manager.spawn("user-1", "discord", "Task")).rejects.toThrow(
        "not enabled"
      );
    });

    it("rejects when rate limit is exceeded", async () => {
      rateLimiter = createMockRateLimiter(false);
      manager = new SubagentManager(config, registry, providerManager as any, eventBus, rateLimiter as any, logger);

      await expect(
        manager.spawn("user-1", "discord", "Task")
      ).rejects.toThrow("rate limit");
    });

    it("rejects when per-user concurrency limit is reached", async () => {
      config.max_concurrent_per_user = 1;
      manager = new SubagentManager(config, registry, providerManager as any, eventBus, rateLimiter as any, logger);

      await manager.spawn("user-1", "discord", "Task 1");
      await expect(
        manager.spawn("user-1", "discord", "Task 2")
      ).rejects.toThrow("Maximum concurrent subagents per user");
    });

    it("rejects when global concurrency limit is reached", async () => {
      config.max_concurrent_global = 1;
      manager = new SubagentManager(config, registry, providerManager as any, eventBus, rateLimiter as any, logger);

      await manager.spawn("user-1", "discord", "Task 1");
      await expect(
        manager.spawn("user-2", "discord", "Task 2")
      ).rejects.toThrow("Maximum global concurrent subagents");
    });

    it("clamps timeout to max_timeout_minutes", async () => {
      const { runId } = await manager.spawn("user-1", "discord", "Task", {
        timeoutMinutes: 999,
      });
      const info = manager.getRunInfo("user-1", runId);
      expect(info).not.toBeNull();
      expect(info!.timeoutMs).toBe(config.max_timeout_minutes * 60 * 1000);
    });

    it("validates requested tool names", async () => {
      await expect(
        manager.spawn("user-1", "discord", "Task", {
          allowedTools: ["nonexistent_tool"],
        })
      ).rejects.toThrow("Unknown tools");
    });
  });

  describe("delegateSync()", () => {
    it("validates tool names", async () => {
      await expect(
        manager.delegateSync("user-1", "discord", "Task", {
          toolsNeeded: ["invalid_tool"],
        })
      ).rejects.toThrow("Unknown tools");
    });

    it("validates tools exist in registry", async () => {
      await expect(
        manager.delegateSync("user-1", "discord", "Task", {
          toolsNeeded: ["note_search"],
        })
      ).resolves.toBeDefined();
    });

    it("rejects when subagents are disabled", async () => {
      config.enabled = false;
      manager = new SubagentManager(config, registry, providerManager as any, eventBus, rateLimiter as any, logger);

      await expect(
        manager.delegateSync("user-1", "discord", "Task", {
          toolsNeeded: ["note_search"],
        })
      ).rejects.toThrow("not enabled");
    });
  });

  describe("stopRun()", () => {
    it("stops an active run", async () => {
      const { runId } = await manager.spawn("user-1", "discord", "Task");
      const result = await manager.stopRun("user-1", runId);
      expect(result).toBe(true);
    });

    it("returns false for unknown run IDs", async () => {
      const result = await manager.stopRun("user-1", "nonexistent-id");
      expect(result).toBe(false);
    });

    it("rejects when userId does not match", async () => {
      const { runId } = await manager.spawn("user-1", "discord", "Task");
      await expect(
        manager.stopRun("user-2", runId)
      ).rejects.toThrow("only stop your own");
    });

    it("publishes cancellation event", async () => {
      const { runId } = await manager.spawn("user-1", "discord", "Task");
      await manager.stopRun("user-1", runId);
      const event = eventBus.publishedEvents.find(
        (e) => e.eventType === "subagent.cancelled"
      );
      expect(event).toBeDefined();
    });
  });

  describe("listRuns()", () => {
    it("returns empty array when no runs exist", () => {
      expect(manager.listRuns("user-1")).toEqual([]);
    });

    it("returns only runs for the specified user", async () => {
      await manager.spawn("user-1", "discord", "Task 1");
      await manager.spawn("user-2", "discord", "Task 2");

      expect(manager.listRuns("user-1")).toHaveLength(1);
      expect(manager.listRuns("user-2")).toHaveLength(1);
    });
  });

  describe("getRunLog()", () => {
    it("returns null for unknown runs", () => {
      expect(manager.getRunLog("user-1", "fake-id")).toBeNull();
    });

    it("returns null for wrong user", async () => {
      const { runId } = await manager.spawn("user-1", "discord", "Task");
      expect(manager.getRunLog("user-2", runId)).toBeNull();
    });

    it("returns transcript for valid run", async () => {
      const { runId } = await manager.spawn("user-1", "discord", "Task");
      const log = manager.getRunLog("user-1", runId);
      expect(log).toBeDefined();
      expect(Array.isArray(log)).toBe(true);
    });
  });

  describe("getRunInfo()", () => {
    it("returns null for unknown runs", () => {
      expect(manager.getRunInfo("user-1", "fake-id")).toBeNull();
    });

    it("returns run info with correct fields", async () => {
      const { runId } = await manager.spawn("user-1", "discord", "My task");
      const info = manager.getRunInfo("user-1", runId);
      expect(info).toBeDefined();
      expect(info!.task).toBe("My task");
      expect(info!.userId).toBe("user-1");
      expect(info!.mode).toBe("async");
    });
  });

  describe("sendToRun()", () => {
    it("returns false for unknown runs", () => {
      expect(manager.sendToRun("user-1", "fake-id", "hi")).toBe(false);
    });

    it("returns false for wrong user", async () => {
      const { runId } = await manager.spawn("user-1", "discord", "Task");
      expect(manager.sendToRun("user-2", runId, "hi")).toBe(false);
    });
  });

  describe("shutdown()", () => {
    it("cancels all active runs", async () => {
      await manager.spawn("user-1", "discord", "Task 1");
      await manager.spawn("user-1", "discord", "Task 2");
      expect(manager.getTotalActiveRunCount()).toBe(2);

      await manager.shutdown();
      expect(manager.getTotalActiveRunCount()).toBe(0);
    });
  });

  describe("recursion guard", () => {
    it("blocks spawn when already inside a subagent run", async () => {
      const { getCurrentContext } = await import("../../../src/core/correlation.js");
      (getCurrentContext as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        correlationId: "test",
        userId: "user-1",
        subagentRunId: "existing-run",
      });

      await expect(
        manager.spawn("user-1", "discord", "Nested spawn")
      ).rejects.toThrow("recursion blocked");
    });
  });

  describe("getActiveRunCount()", () => {
    it("counts only runs for the specified user", async () => {
      await manager.spawn("user-1", "discord", "Task 1");
      await manager.spawn("user-1", "discord", "Task 2");
      await manager.spawn("user-2", "discord", "Task 3");

      expect(manager.getActiveRunCount("user-1")).toBe(2);
      expect(manager.getActiveRunCount("user-2")).toBe(1);
    });
  });
});
