import { describe, it, expect, beforeEach, vi } from "vitest";
import { Orchestrator } from "../../src/core/orchestrator.js";
import { SkillRegistry } from "../../src/skills/registry.js";
import { ContextStore } from "../../src/core/context.js";
import { InProcessEventBus } from "../../src/core/events.js";
import { ConfirmationManager } from "../../src/core/confirmation.js";
import {
  createMockProvider,
  createMockSkill,
  createMockLogger,
} from "../helpers/mocks.js";
import {
  createTextResponse,
  createToolUseResponse,
  createToolCall,
  TEST_USER_ID,
  TEST_CHANNEL,
} from "../helpers/fixtures.js";

describe("Orchestrator + LLM Integration", () => {
  let orchestrator: Orchestrator;
  let skillRegistry: SkillRegistry;
  let contextStore: ContextStore;
  let mockAnthropicProvider: ReturnType<typeof createMockProvider>;
  let mockOpenAIProvider: ReturnType<typeof createMockProvider>;
  let providerManager: {
    getForUser: ReturnType<typeof vi.fn>;
    trackUsage: ReturnType<typeof vi.fn>;
    usage: { getDailyUsage: ReturnType<typeof vi.fn>; getTodayTotalCost: ReturnType<typeof vi.fn> };
    listProviders: ReturnType<typeof vi.fn>;
    setUserPreference: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    const logger = createMockLogger();
    mockAnthropicProvider = createMockProvider({ name: "anthropic" });
    mockOpenAIProvider = createMockProvider({ name: "openai" });

    providerManager = {
      getForUser: vi.fn(async () => ({
        provider: mockAnthropicProvider,
        model: "claude-sonnet-4-5",
      })),
      trackUsage: vi.fn(async () => {}),
      usage: { getDailyUsage: vi.fn(() => []), getTodayTotalCost: vi.fn(() => null) },
      listProviders: vi.fn(() => []),
      setUserPreference: vi.fn(),
    };

    skillRegistry = new SkillRegistry(logger);
    contextStore = new ContextStore(logger);
    const eventBus = new InProcessEventBus(logger);
    const confirmationManager = new ConfirmationManager(logger);

    orchestrator = new Orchestrator(
      providerManager as any,
      skillRegistry,
      contextStore,
      eventBus,
      confirmationManager,
      logger
    );
  });

  it("end-to-end: simple message → text response (mocked Anthropic)", async () => {
    mockAnthropicProvider.chatMock.mockResolvedValueOnce(
      createTextResponse("Hello from Claude!", "anthropic")
    );

    const result = await orchestrator.handleMessage(
      TEST_USER_ID, "Hello", TEST_CHANNEL
    );

    expect(result).toBe("Hello from Claude!");
    expect(mockAnthropicProvider.chatMock).toHaveBeenCalledOnce();
  });

  it("end-to-end: simple message → text response (mocked OpenAI)", async () => {
    providerManager.getForUser.mockResolvedValueOnce({
      provider: mockOpenAIProvider,
      model: "gpt-4o",
    });
    mockOpenAIProvider.chatMock.mockResolvedValueOnce(
      createTextResponse("Hello from GPT!", "openai")
    );

    const result = await orchestrator.handleMessage(
      TEST_USER_ID, "Hello", TEST_CHANNEL
    );

    expect(result).toBe("Hello from GPT!");
  });

  it("end-to-end: message triggers tool use → tool executes → final response", async () => {
    const skill = createMockSkill({
      name: "test",
      tools: [
        {
          name: "test_action",
          description: "Test",
          input_schema: { type: "object", properties: {} },
        },
      ],
      executeResult: "Tool result data",
    });
    skillRegistry.register(skill);

    mockAnthropicProvider.chatMock
      .mockResolvedValueOnce(
        createToolUseResponse([createToolCall("test_action", { q: "test" })])
      )
      .mockResolvedValueOnce(
        createTextResponse("Here's what I found: Tool result data")
      );

    const result = await orchestrator.handleMessage(
      TEST_USER_ID, "Do the thing", TEST_CHANNEL
    );

    expect(result).toBe("Here's what I found: Tool result data");
    expect(skill.execute).toHaveBeenCalledWith("test_action", { q: "test" });
  });

  it("conversation history accumulates across multiple handleMessage calls", async () => {
    mockAnthropicProvider.chatMock
      .mockResolvedValueOnce(createTextResponse("Response 1"))
      .mockResolvedValueOnce(createTextResponse("Response 2"));

    await orchestrator.handleMessage(TEST_USER_ID, "Message 1", TEST_CHANNEL);
    await orchestrator.handleMessage(TEST_USER_ID, "Message 2", TEST_CHANNEL);

    const history = await contextStore.getHistory(TEST_USER_ID, TEST_CHANNEL);
    expect(history).toHaveLength(4); // 2 user + 2 assistant messages
  });

  it("switching provider mid-conversation works", async () => {
    mockAnthropicProvider.chatMock.mockResolvedValueOnce(
      createTextResponse("Anthropic reply")
    );

    await orchestrator.handleMessage(TEST_USER_ID, "First", TEST_CHANNEL);

    // Switch to OpenAI
    providerManager.getForUser.mockResolvedValueOnce({
      provider: mockOpenAIProvider,
      model: "gpt-4o",
    });
    mockOpenAIProvider.chatMock.mockResolvedValueOnce(
      createTextResponse("OpenAI reply")
    );

    const result = await orchestrator.handleMessage(
      TEST_USER_ID, "Second", TEST_CHANNEL
    );

    expect(result).toBe("OpenAI reply");
  });

  it("token usage is tracked across multiple turns", async () => {
    mockAnthropicProvider.chatMock
      .mockResolvedValueOnce(createTextResponse("Reply 1"))
      .mockResolvedValueOnce(createTextResponse("Reply 2"));

    await orchestrator.handleMessage(TEST_USER_ID, "Msg 1", TEST_CHANNEL);
    await orchestrator.handleMessage(TEST_USER_ID, "Msg 2", TEST_CHANNEL);

    expect(providerManager.trackUsage).toHaveBeenCalledTimes(2);
  });
});
