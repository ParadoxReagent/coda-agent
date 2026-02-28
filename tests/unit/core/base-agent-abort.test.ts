/**
 * Tests that AbortSignal is correctly propagated to provider.chat() in BaseAgent.
 *
 * Bug context: previously abortSignal was not passed through to the provider,
 * meaning long-running LLM calls could not be cancelled externally.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { BaseAgent, type BaseAgentConfig } from "../../../src/core/base-agent.js";
import { SkillRegistry } from "../../../src/skills/registry.js";
import {
  createMockLogger,
  createMockProvider,
  createMockSkill,
} from "../../helpers/mocks.js";
import type { LLMResponse } from "../../../src/core/llm/provider.js";

describe("BaseAgent — abort signal propagation", () => {
  let registry: SkillRegistry;
  let logger: ReturnType<typeof createMockLogger>;

  function makeConfig(overrides?: Partial<BaseAgentConfig>): BaseAgentConfig {
    return {
      name: "test-agent",
      systemPrompt: "You are a test agent.",
      provider: createMockProvider(),
      model: "mock-model",
      isSubagent: false,
      maxToolCalls: 10,
      toolExecutionTimeoutMs: 5000,
      ...overrides,
    };
  }

  beforeEach(() => {
    logger = createMockLogger();
    registry = new SkillRegistry(logger);
  });

  it("passes abortSignal to provider.chat() on the initial LLM call", async () => {
    const controller = new AbortController();
    const provider = createMockProvider({
      responses: [
        {
          text: "Done",
          toolCalls: [],
          stopReason: "end_turn",
          usage: { inputTokens: 10, outputTokens: 5 },
          model: "mock-model",
          provider: "mock",
        },
      ],
    });

    const agent = new BaseAgent(
      makeConfig({ provider, abortSignal: controller.signal }),
      registry,
      logger
    );
    await agent.run("test input");

    expect(provider.chatMock).toHaveBeenCalledOnce();
    const callArgs = provider.chatMock.mock.calls[0]![0];
    expect(callArgs.signal).toBe(controller.signal);
  });

  it("passes abortSignal to provider.chat() on every continuation call in the tool-use loop", async () => {
    const controller = new AbortController();

    const skill = createMockSkill({
      name: "notes",
      tools: [
        {
          name: "note_search",
          description: "Search notes",
          input_schema: { type: "object", properties: {} },
        },
      ],
      executeResult: "[]",
    });
    registry.register(skill);

    const toolResponse: LLMResponse = {
      text: null,
      toolCalls: [{ id: "tc-1", name: "note_search", input: {} }],
      stopReason: "tool_use",
      usage: { inputTokens: 100, outputTokens: 30 },
      model: "mock-model",
      provider: "mock",
    };
    const finalResponse: LLMResponse = {
      text: "Done after tool call",
      toolCalls: [],
      stopReason: "end_turn",
      usage: { inputTokens: 200, outputTokens: 40 },
      model: "mock-model",
      provider: "mock",
    };

    const provider = createMockProvider({ responses: [toolResponse, finalResponse] });

    const agent = new BaseAgent(
      makeConfig({ provider, abortSignal: controller.signal }),
      registry,
      logger
    );
    await agent.run("search for notes");

    expect(provider.chatMock).toHaveBeenCalledTimes(2);

    // Both the initial call and the tool-loop continuation must carry the signal
    const firstArgs = provider.chatMock.mock.calls[0]![0];
    const secondArgs = provider.chatMock.mock.calls[1]![0];
    expect(firstArgs.signal).toBe(controller.signal);
    expect(secondArgs.signal).toBe(controller.signal);
  });

  it("pre-aborted signal throws before the first LLM call is made", async () => {
    const controller = new AbortController();
    controller.abort(); // Already aborted

    const provider = createMockProvider();

    const agent = new BaseAgent(
      makeConfig({ provider, abortSignal: controller.signal }),
      registry,
      logger
    );

    await expect(agent.run("test")).rejects.toThrow("cancelled");
    // provider.chat() must NOT have been invoked — checkAbort fires first
    expect(provider.chatMock).not.toHaveBeenCalled();
  });

  it("abort during tool execution propagates before the next LLM continuation call", async () => {
    const controller = new AbortController();

    // Tool execution aborts the signal as a side effect
    const skill = createMockSkill({
      name: "notes",
      tools: [
        {
          name: "note_search",
          description: "Search notes",
          input_schema: { type: "object", properties: {} },
        },
      ],
      executeFn: async () => {
        controller.abort(); // abort during tool run
        return "results";
      },
    });
    registry.register(skill);

    const provider = createMockProvider({
      responses: [
        {
          text: null,
          toolCalls: [{ id: "tc-1", name: "note_search", input: {} }],
          stopReason: "tool_use",
          usage: { inputTokens: 100, outputTokens: 30 },
          model: "mock-model",
          provider: "mock",
        },
        // This response should never be reached
        {
          text: "Should not appear",
          toolCalls: [],
          stopReason: "end_turn",
          usage: { inputTokens: 200, outputTokens: 40 },
          model: "mock-model",
          provider: "mock",
        },
      ],
    });

    const agent = new BaseAgent(
      makeConfig({ provider, abortSignal: controller.signal }),
      registry,
      logger
    );

    // checkAbort is called after executeTools() and before the next provider.chat()
    await expect(agent.run("test")).rejects.toThrow("cancelled");

    // Initial call happened, but the continuation call must NOT have happened
    expect(provider.chatMock).toHaveBeenCalledTimes(1);
    const callArgs = provider.chatMock.mock.calls[0]![0];
    expect(callArgs.signal).toBe(controller.signal);
  });

  it("signal is undefined in chat args when no abortSignal is provided", async () => {
    const provider = createMockProvider({
      responses: [
        {
          text: "Done",
          toolCalls: [],
          stopReason: "end_turn",
          usage: { inputTokens: 10, outputTokens: 5 },
          model: "mock-model",
          provider: "mock",
        },
      ],
    });

    // No abortSignal in config
    const agent = new BaseAgent(makeConfig({ provider }), registry, logger);
    await agent.run("test input");

    const callArgs = provider.chatMock.mock.calls[0]![0];
    expect(callArgs.signal).toBeUndefined();
  });
});
