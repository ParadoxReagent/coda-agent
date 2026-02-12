import { describe, it, expect, vi, beforeEach } from "vitest";
import { BaseAgent, type BaseAgentConfig } from "../../../src/core/base-agent.js";
import { SkillRegistry } from "../../../src/skills/registry.js";
import {
  createMockLogger,
  createMockProvider,
  createMockSkill,
} from "../../helpers/mocks.js";
import type { LLMResponse } from "../../../src/core/llm/provider.js";

describe("BaseAgent", () => {
  let registry: SkillRegistry;
  let logger: ReturnType<typeof createMockLogger>;

  function makeConfig(overrides?: Partial<BaseAgentConfig>): BaseAgentConfig {
    const provider = createMockProvider();
    return {
      name: "test-agent",
      systemPrompt: "You are a test agent.",
      provider,
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

  it("returns LLM text response for a simple query (no tools)", async () => {
    const provider = createMockProvider({
      responses: [
        {
          text: "Hello!",
          toolCalls: [],
          stopReason: "end_turn",
          usage: { inputTokens: 50, outputTokens: 20 },
          model: "mock-model",
          provider: "mock",
        },
      ],
    });

    const agent = new BaseAgent(
      makeConfig({ provider }),
      registry,
      logger
    );
    const result = await agent.run("Hi");

    expect(result.text).toBe("Hello!");
    expect(result.totalTokens.input).toBe(50);
    expect(result.totalTokens.output).toBe(20);
    expect(result.toolCallCount).toBe(0);
  });

  it("executes tool calls and returns final response", async () => {
    const skill = createMockSkill({
      name: "notes",
      tools: [
        {
          name: "note_search",
          description: "Search notes",
          input_schema: { type: "object", properties: { query: { type: "string" } } },
        },
      ],
      executeResult: JSON.stringify({ results: [] }),
    });
    registry.register(skill);

    const provider = createMockProvider({
      responses: [
        {
          text: null,
          toolCalls: [{ id: "tc-1", name: "note_search", input: { query: "test" } }],
          stopReason: "tool_use",
          usage: { inputTokens: 100, outputTokens: 30 },
          model: "mock-model",
          provider: "mock",
        },
        {
          text: "I found no notes.",
          toolCalls: [],
          stopReason: "end_turn",
          usage: { inputTokens: 200, outputTokens: 40 },
          model: "mock-model",
          provider: "mock",
        },
      ],
    });

    const agent = new BaseAgent(
      makeConfig({ provider }),
      registry,
      logger
    );
    const result = await agent.run("Search for notes about test");

    expect(result.text).toBe("I found no notes.");
    expect(result.toolCallCount).toBe(1);
    expect(result.totalTokens.input).toBe(300);
    expect(result.totalTokens.output).toBe(70);
  });

  it("records transcript entries", async () => {
    const provider = createMockProvider({
      responses: [
        {
          text: "Done!",
          toolCalls: [],
          stopReason: "end_turn",
          usage: { inputTokens: 10, outputTokens: 5 },
          model: "mock-model",
          provider: "mock",
        },
      ],
    });

    const agent = new BaseAgent(
      makeConfig({ provider }),
      registry,
      logger
    );
    const result = await agent.run("Test input");

    expect(result.transcript).toHaveLength(2);
    expect(result.transcript[0]!.role).toBe("user");
    expect(result.transcript[0]!.content).toBe("Test input");
    expect(result.transcript[1]!.role).toBe("assistant");
    expect(result.transcript[1]!.content).toBe("Done!");
  });

  it("stops when max tool calls exceeded", async () => {
    const skill = createMockSkill({
      name: "notes",
      tools: [
        {
          name: "note_search",
          description: "Search",
          input_schema: { type: "object", properties: {} },
        },
      ],
    });
    registry.register(skill);

    // LLM keeps requesting tool calls
    const toolResponse: LLMResponse = {
      text: null,
      toolCalls: [{ id: "tc-1", name: "note_search", input: {} }],
      stopReason: "tool_use",
      usage: { inputTokens: 50, outputTokens: 10 },
      model: "mock-model",
      provider: "mock",
    };

    const provider = createMockProvider({
      responses: Array(15).fill(toolResponse),
    });

    const agent = new BaseAgent(
      makeConfig({ provider, maxToolCalls: 3 }),
      registry,
      logger
    );
    const result = await agent.run("Infinite tool loop");

    expect(result.toolCallCount).toBeLessThanOrEqual(4); // Stops after exceeding 3
  });

  it("filters mainAgentOnly tools when isSubagent is true", () => {
    const skill = createMockSkill({
      name: "subagents",
      tools: [
        {
          name: "sessions_spawn",
          description: "Spawn",
          input_schema: { type: "object", properties: {} },
          mainAgentOnly: true,
        },
        {
          name: "sessions_list",
          description: "List",
          input_schema: { type: "object", properties: {} },
        },
      ],
    });
    registry.register(skill);

    const agentMain = new BaseAgent(
      makeConfig({ isSubagent: false }),
      registry,
      logger
    );
    expect(agentMain.getToolDefinitions().map((t) => t.name)).toContain("sessions_spawn");
    expect(agentMain.getToolDefinitions().map((t) => t.name)).toContain("sessions_list");

    const agentSub = new BaseAgent(
      makeConfig({ isSubagent: true }),
      registry,
      logger
    );
    expect(agentSub.getToolDefinitions().map((t) => t.name)).not.toContain("sessions_spawn");
    expect(agentSub.getToolDefinitions().map((t) => t.name)).toContain("sessions_list");
  });

  it("filters tools by allowedSkills", () => {
    const emailSkill = createMockSkill({
      name: "email",
      tools: [
        {
          name: "email_check",
          description: "Check",
          input_schema: { type: "object", properties: {} },
        },
      ],
    });
    const notesSkill = createMockSkill({
      name: "notes",
      tools: [
        {
          name: "note_search",
          description: "Search",
          input_schema: { type: "object", properties: {} },
        },
      ],
    });
    registry.register(emailSkill);
    registry.register(notesSkill);

    const agent = new BaseAgent(
      makeConfig({ allowedSkills: ["notes"] }),
      registry,
      logger
    );
    const toolNames = agent.getToolDefinitions().map((t) => t.name);
    expect(toolNames).toContain("note_search");
    expect(toolNames).not.toContain("email_check");
  });

  it("filters tools by blockedTools", () => {
    const skill = createMockSkill({
      name: "notes",
      tools: [
        {
          name: "note_search",
          description: "Search",
          input_schema: { type: "object", properties: {} },
        },
        {
          name: "note_save",
          description: "Save",
          input_schema: { type: "object", properties: {} },
        },
      ],
    });
    registry.register(skill);

    const agent = new BaseAgent(
      makeConfig({ blockedTools: ["note_save"] }),
      registry,
      logger
    );
    const toolNames = agent.getToolDefinitions().map((t) => t.name);
    expect(toolNames).toContain("note_search");
    expect(toolNames).not.toContain("note_save");
  });

  it("respects token budget limit", async () => {
    const provider = createMockProvider({
      responses: [
        {
          text: null,
          toolCalls: [{ id: "tc-1", name: "note_search", input: {} }],
          stopReason: "tool_use",
          usage: { inputTokens: 40000, outputTokens: 20000 },
          model: "mock-model",
          provider: "mock",
        },
      ],
    });

    const skill = createMockSkill({
      name: "notes",
      tools: [
        {
          name: "note_search",
          description: "Search",
          input_schema: { type: "object", properties: {} },
        },
      ],
    });
    registry.register(skill);

    const agent = new BaseAgent(
      makeConfig({ provider, maxTokenBudget: 50000 }),
      registry,
      logger
    );

    await expect(agent.run("test")).rejects.toThrow("Token budget exceeded");
  });

  it("responds to abort signal", async () => {
    const controller = new AbortController();
    controller.abort(); // Pre-aborted

    const provider = createMockProvider();
    const agent = new BaseAgent(
      makeConfig({ provider, abortSignal: controller.signal }),
      registry,
      logger
    );

    await expect(agent.run("test")).rejects.toThrow("cancelled");
  });

  it("each instance has isolated context (independent transcripts)", async () => {
    const provider1 = createMockProvider({
      responses: [
        {
          text: "Agent 1 response",
          toolCalls: [],
          stopReason: "end_turn",
          usage: { inputTokens: 10, outputTokens: 5 },
          model: "mock-model",
          provider: "mock",
        },
      ],
    });
    const provider2 = createMockProvider({
      responses: [
        {
          text: "Agent 2 response",
          toolCalls: [],
          stopReason: "end_turn",
          usage: { inputTokens: 10, outputTokens: 5 },
          model: "mock-model",
          provider: "mock",
        },
      ],
    });

    const agent1 = new BaseAgent(
      makeConfig({ name: "agent-1", provider: provider1 }),
      registry,
      logger
    );
    const agent2 = new BaseAgent(
      makeConfig({ name: "agent-2", provider: provider2 }),
      registry,
      logger
    );

    await agent1.run("Input 1");
    await agent2.run("Input 2");

    expect(agent1.getTranscript()).toHaveLength(2);
    expect(agent2.getTranscript()).toHaveLength(2);
    expect(agent1.getTranscript()[1]!.content).toBe("Agent 1 response");
    expect(agent2.getTranscript()[1]!.content).toBe("Agent 2 response");
  });

  it("handles tool execution errors gracefully", async () => {
    const skill = createMockSkill({
      name: "buggy",
      tools: [
        {
          name: "buggy_tool",
          description: "A buggy tool",
          input_schema: { type: "object", properties: {} },
        },
      ],
      executeFn: async () => { throw new Error("Tool crash"); },
    });
    registry.register(skill);

    const provider = createMockProvider({
      responses: [
        {
          text: null,
          toolCalls: [{ id: "tc-1", name: "buggy_tool", input: {} }],
          stopReason: "tool_use",
          usage: { inputTokens: 50, outputTokens: 10 },
          model: "mock-model",
          provider: "mock",
        },
        {
          text: "Tool had an error",
          toolCalls: [],
          stopReason: "end_turn",
          usage: { inputTokens: 100, outputTokens: 20 },
          model: "mock-model",
          provider: "mock",
        },
      ],
    });

    const agent = new BaseAgent(
      makeConfig({ provider }),
      registry,
      logger
    );
    const result = await agent.run("Try the buggy tool");

    expect(result.text).toBe("Tool had an error");
    // The tool error should be in the transcript
    const toolResults = result.transcript.filter((t) => t.role === "tool_result");
    expect(toolResults.length).toBeGreaterThan(0);
    expect(toolResults[0]!.content).toContain("Error executing buggy_tool");
  });

  it("records tool_result entries with toolName in transcript", async () => {
    const skill = createMockSkill({
      name: "notes",
      tools: [
        {
          name: "note_search",
          description: "Search",
          input_schema: { type: "object", properties: {} },
        },
      ],
      executeResult: "found results",
    });
    registry.register(skill);

    const provider = createMockProvider({
      responses: [
        {
          text: null,
          toolCalls: [{ id: "tc-1", name: "note_search", input: {} }],
          stopReason: "tool_use",
          usage: { inputTokens: 50, outputTokens: 10 },
          model: "mock-model",
          provider: "mock",
        },
        {
          text: "Done",
          toolCalls: [],
          stopReason: "end_turn",
          usage: { inputTokens: 100, outputTokens: 20 },
          model: "mock-model",
          provider: "mock",
        },
      ],
    });

    const agent = new BaseAgent(
      makeConfig({ provider }),
      registry,
      logger
    );
    const result = await agent.run("Search notes");

    const toolEntry = result.transcript.find((t) => t.role === "tool_result");
    expect(toolEntry).toBeDefined();
    expect(toolEntry!.toolName).toBe("note_search");
    expect(toolEntry!.content).toBe("found results");
  });

  it("produces a default message when LLM returns null text at end", async () => {
    const provider = createMockProvider({
      responses: [
        {
          text: null,
          toolCalls: [],
          stopReason: "end_turn",
          usage: { inputTokens: 10, outputTokens: 0 },
          model: "mock-model",
          provider: "mock",
        },
      ],
    });

    const agent = new BaseAgent(makeConfig({ provider }), registry, logger);
    const result = await agent.run("Hi");

    expect(result.text).toBe("No response generated.");
  });
});
