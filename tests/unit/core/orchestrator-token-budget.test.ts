import { describe, it, expect, vi, beforeEach } from "vitest";
import { Orchestrator } from "../../../src/core/orchestrator.js";
import { ProviderManager } from "../../../src/core/llm/manager.js";
import { SkillRegistry } from "../../../src/skills/registry.js";
import { ContextStore } from "../../../src/core/context.js";
import { InProcessEventBus } from "../../../src/core/events.js";
import { ConfirmationManager } from "../../../src/core/confirmation.js";
import { createMockProvider, createMockLogger } from "../../helpers/mocks.js";
import { createTextResponse, TEST_CHANNEL, TEST_USER_ID } from "../../helpers/fixtures.js";
import type { Skill } from "../../../src/skills/base.js";

describe("Orchestrator token budget handling", () => {
  let orchestrator: Orchestrator;
  let providerManager: ProviderManager;
  let skillRegistry: SkillRegistry;
  let contextStore: ContextStore;
  let eventBus: InProcessEventBus;
  let confirmationManager: ConfirmationManager;
  let mockProvider: ReturnType<typeof createMockProvider>;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
    mockProvider = createMockProvider({ name: "openrouter" });
    skillRegistry = new SkillRegistry(logger);
    contextStore = new ContextStore(logger);
    eventBus = new InProcessEventBus(logger);
    confirmationManager = new ConfirmationManager(logger);

    providerManager = {
      getForUser: vi.fn(async () => ({
        provider: mockProvider,
        model: "anthropic/claude-sonnet-4-5",
      })),
      getForUserTiered: vi.fn(async () => ({
        provider: mockProvider,
        model: "anthropic/claude-sonnet-4-5",
        tier: "light",
      })),
      isTierEnabled: vi.fn(() => false),
      trackUsage: vi.fn(async () => {}),
      usage: { getDailyUsage: vi.fn(() => []), getTodayTotalCost: vi.fn(() => null) },
      listProviders: vi.fn(() => []),
      setUserPreference: vi.fn(),
    } as unknown as ProviderManager;

    orchestrator = new Orchestrator(
      providerManager,
      skillRegistry,
      contextStore,
      eventBus,
      confirmationManager,
      logger
    );
  });

  it("retries with reduced maxTokens when provider returns affordability 402", async () => {
    const affordabilityError = Object.assign(
      new Error(
        "This request requires more credits, or fewer max_tokens. You requested up to 4096 tokens, but can only afford 1778."
      ),
      { status: 402 }
    );

    mockProvider.chatMock
      .mockRejectedValueOnce(affordabilityError)
      .mockResolvedValueOnce(createTextResponse("Recovered response", "openrouter"));

    const result = await orchestrator.handleMessage(TEST_USER_ID, "hello", TEST_CHANNEL);

    expect(result.text).toBe("Recovered response");
    expect(mockProvider.chatMock).toHaveBeenCalledTimes(2);
    expect(mockProvider.chatMock.mock.calls[0]?.[0]?.maxTokens).toBe(4096);
    expect(mockProvider.chatMock.mock.calls[1]?.[0]?.maxTokens).toBeLessThan(4096);
    expect(mockProvider.chatMock.mock.calls[1]?.[0]?.maxTokens).toBeGreaterThanOrEqual(256);
  });

  it("persists a compaction summary via memory_save when history is compacted", async () => {
    const memoryExecute = vi.fn(async () => JSON.stringify({ success: true, id: "mem-1" }));
    const memorySkill: Skill = {
      name: "memory",
      description: "test memory skill",
      getTools: () => [
        {
          name: "memory_save",
          description: "Save memory",
          input_schema: {
            type: "object",
            properties: {
              content: { type: "string" },
              content_type: { type: "string" },
            },
            required: ["content", "content_type"],
          },
        },
      ],
      execute: memoryExecute,
      getRequiredConfig: () => [],
      startup: vi.fn(async () => {}),
      shutdown: vi.fn(async () => {}),
    };
    skillRegistry.register(memorySkill);

    for (let i = 0; i < 15; i++) {
      await contextStore.save(TEST_USER_ID, TEST_CHANNEL, `user-${i}`, { text: `assistant-${i}` });
    }

    mockProvider.chatMock
      .mockResolvedValueOnce(createTextResponse("Compaction summary text", "openrouter"))
      .mockResolvedValueOnce(createTextResponse("Main response", "openrouter"));

    const result = await orchestrator.handleMessage(TEST_USER_ID, "new message", TEST_CHANNEL);

    expect(result.text).toBe("Main response");
    expect(memoryExecute).toHaveBeenCalled();
    expect(memoryExecute.mock.calls[0]?.[0]).toBe("memory_save");
    expect(memoryExecute.mock.calls[0]?.[1]).toMatchObject({
      content_type: "summary",
      user_id: TEST_USER_ID,
      importance: 0.7,
    });
  });
});
