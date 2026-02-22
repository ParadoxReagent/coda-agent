import { describe, it, expect, vi, beforeEach } from "vitest";
import { Orchestrator } from "../../../src/core/orchestrator.js";
import { ProviderManager } from "../../../src/core/llm/manager.js";
import { SkillRegistry } from "../../../src/skills/registry.js";
import { ContextStore } from "../../../src/core/context.js";
import { InProcessEventBus } from "../../../src/core/events.js";
import { ConfirmationManager } from "../../../src/core/confirmation.js";
import {
  createMockProvider,
  createMockSkill,
  createMockLogger,
} from "../../helpers/mocks.js";
import {
  createTextResponse,
  createToolUseResponse,
  createToolCall,
  TEST_USER_ID,
  TEST_CHANNEL,
} from "../../helpers/fixtures.js";

describe("Orchestrator", () => {
  let orchestrator: Orchestrator;
  let providerManager: ProviderManager;
  let skillRegistry: SkillRegistry;
  let contextStore: ContextStore;
  let eventBus: InProcessEventBus;
  let confirmationManager: ConfirmationManager;
  let logger: ReturnType<typeof createMockLogger>;
  let mockProvider: ReturnType<typeof createMockProvider>;

  beforeEach(() => {
    logger = createMockLogger();
    mockProvider = createMockProvider();

    // Create a minimal ProviderManager by mocking
    providerManager = {
      getForUser: vi.fn(async () => ({
        provider: mockProvider,
        model: "mock-model",
      })),
      getForUserTiered: vi.fn(async () => ({
        provider: mockProvider,
        model: "mock-model",
        failedOver: false,
      })),
      isTierEnabled: vi.fn(() => false),
      trackUsage: vi.fn(async () => {}),
      usage: { getDailyUsage: vi.fn(() => []), getTodayTotalCost: vi.fn(() => null) },
      listProviders: vi.fn(() => []),
      setUserPreference: vi.fn(),
    } as unknown as ProviderManager;

    skillRegistry = new SkillRegistry(logger);
    contextStore = new ContextStore(logger);
    eventBus = new InProcessEventBus(logger);
    confirmationManager = new ConfirmationManager(logger);

    orchestrator = new Orchestrator(
      providerManager,
      skillRegistry,
      contextStore,
      eventBus,
      confirmationManager,
      logger
    );
  });

  it("calls provider with correct system prompt, history, and tools", async () => {
    mockProvider.chatMock.mockResolvedValueOnce(
      createTextResponse("Hello!")
    );

    await orchestrator.handleMessage(TEST_USER_ID, "Hi", TEST_CHANNEL);

    expect(mockProvider.chatMock).toHaveBeenCalledOnce();
    const call = mockProvider.chatMock.mock.calls[0]![0]!;
    expect(call.system).toContain("Milo");
    expect(call.messages).toHaveLength(1);
    expect(call.messages[0]!.content).toBe("Hi");
  });

  it("returns text response when stopReason is end_turn", async () => {
    mockProvider.chatMock.mockResolvedValueOnce(
      createTextResponse("Hello there!")
    );

    const result = await orchestrator.handleMessage(
      TEST_USER_ID, "Hi", TEST_CHANNEL
    );

    expect(result.text).toBe("Hello there!");
  });

  it("executes tool calls when stopReason is tool_use and loops correctly", async () => {
    const skill = createMockSkill({
      name: "test",
      tools: [
        {
          name: "test_action",
          description: "Test action",
          input_schema: { type: "object", properties: {} },
        },
      ],
      executeResult: "Tool executed!",
    });
    skillRegistry.register(skill);

    // First call returns tool use, second returns text
    mockProvider.chatMock
      .mockResolvedValueOnce(
        createToolUseResponse([
          createToolCall("test_action", { query: "test" }),
        ])
      )
      .mockResolvedValueOnce(createTextResponse("Done!"));

    const result = await orchestrator.handleMessage(
      TEST_USER_ID, "Do something", TEST_CHANNEL
    );

    expect(result.text).toBe("Done!");
    expect(mockProvider.chatMock).toHaveBeenCalledTimes(2);
  });

  it("respects max tool calls per turn", async () => {
    const skill = createMockSkill({
      name: "test",
      executeResult: "result",
    });
    skillRegistry.register(skill);

    // Return tool use 12 times (exceeds limit of 10)
    for (let i = 0; i < 12; i++) {
      mockProvider.chatMock.mockResolvedValueOnce(
        createToolUseResponse([createToolCall("test_action")])
      );
    }

    const result = await orchestrator.handleMessage(
      TEST_USER_ID, "loop", TEST_CHANNEL
    );

    expect(result.text).toContain("maximum number of actions");
  });

  it("handles LLM API errors", async () => {
    mockProvider.chatMock.mockRejectedValueOnce(new Error("API rate limit"));

    await expect(
      orchestrator.handleMessage(TEST_USER_ID, "Hi", TEST_CHANNEL)
    ).rejects.toThrow("API rate limit");
  });

  it("saves conversation to context store after successful response", async () => {
    mockProvider.chatMock.mockResolvedValueOnce(
      createTextResponse("Saved response")
    );

    await orchestrator.handleMessage(TEST_USER_ID, "Save this", TEST_CHANNEL);

    const history = await contextStore.getHistory(TEST_USER_ID, TEST_CHANNEL);
    expect(history).toHaveLength(2);
    expect(history[0]!.content).toBe("Save this");
    expect(history[1]!.content).toBe("Saved response");
  });

  it("does not save to context store on error", async () => {
    mockProvider.chatMock.mockRejectedValueOnce(new Error("Boom"));

    try {
      await orchestrator.handleMessage(TEST_USER_ID, "Fail", TEST_CHANNEL);
    } catch {
      // expected
    }

    const history = await contextStore.getHistory(TEST_USER_ID, TEST_CHANNEL);
    expect(history).toHaveLength(0);
  });

  it("tracks token usage after each LLM call", async () => {
    mockProvider.chatMock.mockResolvedValueOnce(
      createTextResponse("Hi")
    );

    await orchestrator.handleMessage(TEST_USER_ID, "Hello", TEST_CHANNEL);

    expect(providerManager.trackUsage).toHaveBeenCalledOnce();
  });

  it("handles confirmation messages", async () => {
    const skill = createMockSkill({
      name: "test",
      tools: [
        {
          name: "test_action",
          description: "Action",
          input_schema: { type: "object", properties: {} },
          requiresConfirmation: true,
        },
      ],
      executeResult: "Action completed",
    });
    skillRegistry.register(skill);

    // Create a confirmation token directly
    const token = confirmationManager.createConfirmation(
      TEST_USER_ID, "test", "test_action", { key: "val" }, "desc"
    );

    const result = await orchestrator.handleMessage(
      TEST_USER_ID, `confirm ${token}`, TEST_CHANNEL
    );

    expect(result.text).toContain("Confirmed");
  });

  it("returns error for invalid confirmation token", async () => {
    const result = await orchestrator.handleMessage(
      TEST_USER_ID, "confirm ABCDEFGHIJKLMNOP", TEST_CHANNEL
    );

    expect(result.text).toContain("Invalid or expired");
  });
});
