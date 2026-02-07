import { describe, it, expect, vi, beforeEach } from "vitest";
import { Orchestrator } from "../../src/core/orchestrator.js";
import { SkillRegistry } from "../../src/skills/registry.js";
import { ContextStore } from "../../src/core/context.js";
import { ConfirmationManager } from "../../src/core/confirmation.js";
import {
  createMockProvider,
  createMockEventBus,
  createMockLogger,
  createMockSkill,
} from "../helpers/mocks.js";
import {
  createTextResponse,
  createToolUseResponse,
  createToolCall,
  TEST_USER_ID,
  TEST_CHANNEL,
} from "../helpers/fixtures.js";
import type { ProviderManager } from "../../src/core/llm/manager.js";

function createMockProviderManager(
  provider: ReturnType<typeof createMockProvider>
) {
  return {
    getForUser: vi.fn().mockResolvedValue({
      provider,
      model: "mock-model",
    }),
    trackUsage: vi.fn().mockResolvedValue(undefined),
  } as unknown as ProviderManager;
}

describe("Morning Briefing Integration", () => {
  let orchestrator: Orchestrator;
  let registry: SkillRegistry;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
    registry = new SkillRegistry(logger);
  });

  it("system prompt includes briefing instructions", async () => {
    const provider = createMockProvider({
      responses: [createTextResponse("Good morning! Here is your briefing...")],
    });
    const providerManager = createMockProviderManager(provider);
    const eventBus = createMockEventBus();
    const context = new ContextStore(logger);
    const confirmation = new ConfirmationManager(logger);

    // Register skills that provide briefing tools
    const emailSkill = createMockSkill({
      name: "email",
      description: "Email management",
      tools: [
        {
          name: "email_check",
          description: "Check email",
          input_schema: { type: "object", properties: {} },
        },
      ],
    });
    const calendarSkill = createMockSkill({
      name: "calendar",
      description: "Calendar management",
      tools: [
        {
          name: "calendar_today",
          description: "Today's events",
          input_schema: { type: "object", properties: {} },
        },
      ],
    });
    const reminderSkill = createMockSkill({
      name: "reminders",
      description: "Reminder management",
      tools: [
        {
          name: "reminder_list",
          description: "List reminders",
          input_schema: { type: "object", properties: {} },
        },
      ],
    });

    registry.register(emailSkill);
    registry.register(calendarSkill);
    registry.register(reminderSkill);

    orchestrator = new Orchestrator(
      providerManager,
      registry,
      context,
      eventBus,
      confirmation,
      logger
    );

    await orchestrator.handleMessage(
      TEST_USER_ID,
      "good morning",
      TEST_CHANNEL
    );

    // Verify the system prompt sent to the LLM contains briefing instructions
    const chatCall = provider.chatMock.mock.calls[0]![0];
    expect(chatCall.system).toContain("Morning Briefing");
    expect(chatCall.system).toContain("email_check");
    expect(chatCall.system).toContain("calendar_today");
    expect(chatCall.system).toContain("reminder_list");
  });

  it("briefing works when some skills are missing", async () => {
    const provider = createMockProvider({
      responses: [createTextResponse("Morning! You have 3 pending reminders.")],
    });
    const providerManager = createMockProviderManager(provider);
    const eventBus = createMockEventBus();
    const context = new ContextStore(logger);
    const confirmation = new ConfirmationManager(logger);

    // Only register reminders — email and calendar are not configured
    const reminderSkill = createMockSkill({
      name: "reminders",
      description: "Reminder management",
      tools: [
        {
          name: "reminder_list",
          description: "List reminders",
          input_schema: { type: "object", properties: {} },
        },
      ],
    });
    registry.register(reminderSkill);

    orchestrator = new Orchestrator(
      providerManager,
      registry,
      context,
      eventBus,
      confirmation,
      logger
    );

    const response = await orchestrator.handleMessage(
      TEST_USER_ID,
      "morning",
      TEST_CHANNEL
    );

    // Should still succeed — the LLM can compose from available skills
    expect(response).toBeDefined();
    expect(typeof response).toBe("string");
  });

  it("briefing triggers tool calls when LLM decides to use them", async () => {
    const emailResult = JSON.stringify({
      summary: { urgent: [{ uid: 1, from: "boss@co.com", subject: "Q1 Report" }] },
      total: 5,
      urgent: 1,
    });
    const calendarResult = JSON.stringify({
      events: [{ title: "Team standup", startTime: "2025-01-15T09:00:00Z" }],
      count: 1,
    });
    const reminderResult = JSON.stringify({
      results: [{ id: "rem-1", title: "Call dentist", dueAt: "2025-01-15T14:00:00Z" }],
      count: 1,
    });

    const provider = createMockProvider({
      responses: [
        // First: LLM calls all three tools
        createToolUseResponse([
          createToolCall("email_check", {}, "call_1"),
          createToolCall("calendar_today", {}, "call_2"),
          createToolCall("reminder_list", {}, "call_3"),
        ]),
        // Second: LLM composes the briefing
        createTextResponse(
          "Good morning! You have 1 urgent email from boss@co.com about Q1 Report. " +
            "Today: Team standup at 9 AM. Reminder: Call dentist at 2 PM."
        ),
      ],
    });

    const providerManager = createMockProviderManager(provider);
    const eventBus = createMockEventBus();
    const context = new ContextStore(logger);
    const confirmation = new ConfirmationManager(logger);

    registry.register(
      createMockSkill({
        name: "email",
        tools: [
          {
            name: "email_check",
            description: "Check email",
            input_schema: { type: "object", properties: {} },
          },
        ],
        executeResult: emailResult,
      })
    );
    registry.register(
      createMockSkill({
        name: "calendar",
        tools: [
          {
            name: "calendar_today",
            description: "Today's events",
            input_schema: { type: "object", properties: {} },
          },
        ],
        executeResult: calendarResult,
      })
    );
    registry.register(
      createMockSkill({
        name: "reminders",
        tools: [
          {
            name: "reminder_list",
            description: "List reminders",
            input_schema: { type: "object", properties: {} },
          },
        ],
        executeResult: reminderResult,
      })
    );

    orchestrator = new Orchestrator(
      providerManager,
      registry,
      context,
      eventBus,
      confirmation,
      logger
    );

    const response = await orchestrator.handleMessage(
      TEST_USER_ID,
      "good morning!",
      TEST_CHANNEL
    );

    expect(response).toContain("Q1 Report");
    expect(response).toContain("Team standup");
    expect(response).toContain("Call dentist");

    // LLM was called twice: initial + after tool results
    expect(provider.chatMock).toHaveBeenCalledTimes(2);
  });
});
