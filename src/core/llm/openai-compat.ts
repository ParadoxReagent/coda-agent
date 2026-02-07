import OpenAI from "openai";
import type {
  LLMProvider,
  LLMChatParams,
  LLMResponse,
  LLMToolCall,
  LLMToolDefinition,
  ProviderCapabilities,
} from "./provider.js";
import {
  DEFAULT_OPENAI_COMPAT_CAPABILITIES,
  mergeCapabilities,
} from "./capabilities.js";
import type { ProviderCapabilitiesConfig } from "../../utils/config.js";

export interface OpenAICompatConfig {
  baseURL?: string;
  apiKey: string;
  name: string;
  defaultHeaders?: Record<string, string>;
  capabilities?: ProviderCapabilitiesConfig;
}

export class OpenAICompatProvider implements LLMProvider {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  private client: OpenAI;

  constructor(config: OpenAICompatConfig) {
    this.name = config.name;
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      defaultHeaders: config.defaultHeaders,
    });
    this.capabilities = mergeCapabilities(
      DEFAULT_OPENAI_COMPAT_CAPABILITIES,
      config.capabilities
    );
  }

  async chat(params: LLMChatParams): Promise<LLMResponse> {
    const tools = params.tools?.map((t) => this.toOpenAITool(t));

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: params.system },
    ];

    for (const m of params.messages) {
      if (typeof m.content === "string") {
        messages.push({
          role: m.role as "user" | "assistant",
          content: m.content,
        });
      } else {
        // Handle content blocks
        for (const block of m.content) {
          if (block.type === "text") {
            messages.push({
              role: m.role as "user" | "assistant",
              content: block.text,
            });
          } else if (block.type === "tool_use") {
            messages.push({
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: block.id,
                  type: "function",
                  function: {
                    name: block.name,
                    arguments: JSON.stringify(block.input),
                  },
                },
              ],
            });
          } else if (block.type === "tool_result") {
            messages.push({
              role: "tool",
              tool_call_id: block.tool_use_id,
              content: block.content,
            });
          }
        }
      }
    }

    const requestParams: OpenAI.ChatCompletionCreateParamsNonStreaming = {
      model: params.model,
      messages,
      max_tokens: params.maxTokens ?? 4096,
      ...(tools && tools.length > 0 ? { tools } : {}),
    };

    const response = await this.client.chat.completions.create(requestParams);

    return this.toResponse(response, params.model);
  }

  private toOpenAITool(
    tool: LLMToolDefinition
  ): OpenAI.ChatCompletionTool {
    return {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    };
  }

  private toResponse(
    response: OpenAI.ChatCompletion,
    model: string
  ): LLMResponse {
    const choice = response.choices[0];
    const message = choice?.message;

    let text: string | null = message?.content ?? null;
    const toolCalls: LLMToolCall[] = [];

    if (message?.tool_calls) {
      for (const tc of message.tool_calls) {
        toolCalls.push({
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments),
        });
      }
    }

    return {
      text,
      toolCalls,
      stopReason: this.mapStopReason(choice?.finish_reason),
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? null,
        outputTokens: response.usage?.completion_tokens ?? null,
      },
      model,
      provider: this.name,
    };
  }

  private mapStopReason(
    reason: string | null | undefined
  ): "end_turn" | "tool_use" | "max_tokens" {
    switch (reason) {
      case "tool_calls":
        return "tool_use";
      case "length":
        return "max_tokens";
      default:
        return "end_turn";
    }
  }
}
