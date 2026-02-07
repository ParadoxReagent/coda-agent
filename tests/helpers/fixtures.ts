import type { LLMResponse, LLMToolCall } from "../../src/core/llm/provider.js";

export const TEST_USER_ID = "test-user-123";
export const TEST_CHANNEL = "discord";

export function createTextResponse(
  text: string,
  provider: string = "mock"
): LLMResponse {
  return {
    text,
    toolCalls: [],
    stopReason: "end_turn",
    usage: { inputTokens: 100, outputTokens: 50 },
    model: "mock-model",
    provider,
  };
}

export function createToolUseResponse(
  toolCalls: LLMToolCall[],
  provider: string = "mock",
  text: string | null = null
): LLMResponse {
  return {
    text,
    toolCalls,
    stopReason: "tool_use",
    usage: { inputTokens: 150, outputTokens: 75 },
    model: "mock-model",
    provider,
  };
}

export function createToolCall(
  name: string,
  input: Record<string, unknown> = {},
  id?: string
): LLMToolCall {
  return {
    id: id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
    name,
    input,
  };
}

export function createNullUsageResponse(
  text: string,
  provider: string = "ollama"
): LLMResponse {
  return {
    text,
    toolCalls: [],
    stopReason: "end_turn",
    usage: { inputTokens: null, outputTokens: null },
    model: "llama3.1:8b",
    provider,
  };
}
