import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SubagentManager } from "../../src/core/subagent-manager.js";
import { SubagentSkill } from "../../src/skills/subagents/skill.js";
import { SkillRegistry } from "../../src/skills/registry.js";
import {
  createMockLogger,
  createMockProvider,
  createMockSkill,
  createMockEventBus,
  createMockRateLimiter,
} from "../helpers/mocks.js";
import type { SubagentConfig } from "../../src/utils/config.js";

// Mock correlation
vi.mock("../../src/core/correlation.js", () => ({
  getCurrentContext: vi.fn(() => ({
    correlationId: "test",
    userId: "user-1",
    channel: "discord",
  })),
  withContext: vi.fn((_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  createCorrelationId: vi.fn(() => "corr-id"),
}));

function createTestConfig(): SubagentConfig {
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
  };
}

function createTestProviderManager(provider?: ReturnType<typeof createMockProvider>) {
  const p = provider ?? createMockProvider();
  return {
    getForUser: vi.fn(async () => ({
      provider: p,
      model: "mock-model",
      failedOver: false,
    })),
    trackUsage: vi.fn(async () => {}),
  };
}

describe("Subagent Lifecycle Integration", () => {
  let manager: SubagentManager;
  let skill: SubagentSkill;
  let registry: SkillRegistry;
  let logger: ReturnType<typeof createMockLogger>;
  let eventBus: ReturnType<typeof createMockEventBus>;

  beforeEach(() => {
    logger = createMockLogger();
    registry = new SkillRegistry(logger);
    eventBus = createMockEventBus();

    // Register test skills
    const notesSkill = createMockSkill({
      name: "notes",
      tools: [
        { name: "note_search", description: "Search notes", input_schema: { type: "object", properties: {} } },
        { name: "note_save", description: "Save note", input_schema: { type: "object", properties: {} } },
      ],
      executeResult: JSON.stringify({ results: [] }),
    });
    registry.register(notesSkill);

    const provider = createMockProvider({
      responses: [
        {
          text: "Completed the task",
          toolCalls: [],
          stopReason: "end_turn",
          usage: { inputTokens: 100, outputTokens: 50 },
          model: "mock-model",
          provider: "mock",
        },
      ],
    });

    const providerManager = createTestProviderManager(provider);

    manager = new SubagentManager(
      createTestConfig(),
      registry,
      providerManager as any,
      eventBus,
      createMockRateLimiter(true) as any,
      logger
    );

    skill = new SubagentSkill(manager);
    registry.register(skill);
  });

  afterEach(async () => {
    await manager.shutdown();
  });

  it("spawn + list + info lifecycle", async () => {
    const { runId } = await manager.spawn("user-1", "discord", "Test lifecycle task");

    // Should appear in list
    const runs = manager.listRuns("user-1");
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs.some((r) => r.id === runId)).toBe(true);

    // Should have info
    const info = manager.getRunInfo("user-1", runId);
    expect(info).not.toBeNull();
    expect(info!.task).toBe("Test lifecycle task");
    expect(info!.mode).toBe("async");
  });

  it("spawn + stop cancels the run", async () => {
    const { runId } = await manager.spawn("user-1", "discord", "Task to cancel");

    const stopped = await manager.stopRun("user-1", runId);
    expect(stopped).toBe(true);

    // Cancelled events published
    const cancelEvent = eventBus.publishedEvents.find(
      (e) => e.eventType === "subagent.cancelled"
    );
    expect(cancelEvent).toBeDefined();
  });

  it("sync delegation returns a result", async () => {
    const result = await manager.delegateSync("user-1", "discord", "Search notes about AI", {
      toolsNeeded: ["note_search"],
    });

    // Result should be sanitized subagent output
    expect(result).toContain("subagent_result");
  });

  it("multiple concurrent spawns within limits succeed", async () => {
    const results = await Promise.all([
      manager.spawn("user-1", "discord", "Task 1"),
      manager.spawn("user-1", "discord", "Task 2"),
      manager.spawn("user-1", "discord", "Task 3"),
    ]);

    expect(results).toHaveLength(3);
    results.forEach((r) => {
      expect(r.status).toBe("accepted");
    });
  });

  it("tool registration via SubagentSkill exposes correct tools", () => {
    const tools = registry.getToolDefinitions();
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain("delegate_to_subagent");
    expect(toolNames).toContain("sessions_spawn");
    expect(toolNames).toContain("sessions_list");
  });

  it("subagent tools are excluded from subagent-scoped tool list", () => {
    const tools = registry.getToolDefinitions({ excludeMainAgentOnly: true });
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).not.toContain("sessions_spawn");
    expect(toolNames).not.toContain("delegate_to_subagent");
    expect(toolNames).toContain("sessions_list");
    expect(toolNames).toContain("note_search");
  });

  it("announce callback is called on async completion", async () => {
    const announceFn = vi.fn(async () => {});
    manager.setAnnounceCallback(announceFn);

    const provider = createMockProvider({
      responses: [
        {
          text: "Research complete",
          toolCalls: [],
          stopReason: "end_turn",
          usage: { inputTokens: 100, outputTokens: 50 },
          model: "mock-model",
          provider: "mock",
        },
      ],
    });

    const providerManager = createTestProviderManager(provider);
    const mgr = new SubagentManager(
      createTestConfig(),
      registry,
      providerManager as any,
      eventBus,
      createMockRateLimiter(true) as any,
      logger
    );
    mgr.setAnnounceCallback(announceFn);

    await mgr.spawn("user-1", "discord", "Research task");

    // Wait for setImmediate + async execution
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(announceFn).toHaveBeenCalled();
    await mgr.shutdown();
  });

  it("events are published throughout lifecycle", async () => {
    await manager.spawn("user-1", "discord", "Event test");

    // Wait for background execution
    await new Promise((resolve) => setTimeout(resolve, 200));

    const eventTypes = eventBus.publishedEvents.map((e) => e.eventType);
    expect(eventTypes).toContain("subagent.spawned");
    expect(eventTypes).toContain("subagent.running");
  });
});
