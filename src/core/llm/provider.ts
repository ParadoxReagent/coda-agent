/** Provider-agnostic LLM types and interface. */

export interface LLMMessage {
  role: "user" | "assistant";
  content: string | LLMContentBlock[];
}

export type LLMContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

export interface LLMToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface LLMToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface LLMUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface LLMResponse {
  text: string | null;
  toolCalls: LLMToolCall[];
  stopReason: "end_turn" | "tool_use" | "max_tokens";
  usage: LLMUsage;
  model: string;
  provider: string;
}

export interface LLMChatParams {
  model: string;
  system: string;
  messages: LLMMessage[];
  tools?: LLMToolDefinition[];
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface LLMProvider {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  chat(params: LLMChatParams): Promise<LLMResponse>;
}

export interface ProviderCapabilities {
  tools: boolean | "model_dependent";
  parallelToolCalls: boolean;
  usageMetrics: boolean;
  jsonMode: boolean;
  streaming: boolean;
}
