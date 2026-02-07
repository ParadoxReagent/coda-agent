import Anthropic from "@anthropic-ai/sdk";
import type {
  LLMProvider,
  LLMChatParams,
  LLMResponse,
  LLMToolCall,
  LLMToolDefinition,
  ProviderCapabilities,
} from "./provider.js";
import {
  DEFAULT_ANTHROPIC_CAPABILITIES,
  mergeCapabilities,
} from "./capabilities.js";
import type { ProviderCapabilitiesConfig } from "../../utils/config.js";

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  readonly capabilities: ProviderCapabilities;
  private client: Anthropic;

  constructor(apiKey: string, capabilityOverrides?: ProviderCapabilitiesConfig) {
    this.client = new Anthropic({ apiKey });
    this.capabilities = mergeCapabilities(
      DEFAULT_ANTHROPIC_CAPABILITIES,
      capabilityOverrides
    );
  }

  async chat(params: LLMChatParams): Promise<LLMResponse> {
    const tools = params.tools?.map((t) => this.toAnthropicTool(t));

    const messages = params.messages.map((m) => {
      if (typeof m.content === "string") {
        return { role: m.role as "user" | "assistant", content: m.content };
      }
      // Convert content blocks to Anthropic format
      const blocks = m.content.map((block) => {
        if (block.type === "text") {
          return { type: "text" as const, text: block.text };
        }
        if (block.type === "tool_use") {
          return {
            type: "tool_use" as const,
            id: block.id,
            name: block.name,
            input: block.input,
          };
        }
        if (block.type === "tool_result") {
          return {
            type: "tool_result" as const,
            tool_use_id: block.tool_use_id,
            content: block.content,
          };
        }
        return block;
      });
      return { role: m.role as "user" | "assistant", content: blocks };
    });

    const response = await this.client.messages.create({
      model: params.model,
      max_tokens: params.maxTokens ?? 4096,
      system: params.system,
      messages: messages as Anthropic.MessageParam[],
      ...(tools && tools.length > 0 ? { tools: tools as unknown as Anthropic.Tool[] } : {}),
    });

    return this.toResponse(response, params.model);
  }

  private toAnthropicTool(
    tool: LLMToolDefinition
  ): Record<string, unknown> {
    return {
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema,
    };
  }

  private toResponse(
    response: Anthropic.Message,
    model: string
  ): LLMResponse {
    let text: string | null = null;
    const toolCalls: LLMToolCall[] = [];

    for (const block of response.content) {
      if (block.type === "text") {
        text = block.text;
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        });
      }
    }

    return {
      text,
      toolCalls,
      stopReason: this.mapStopReason(response.stop_reason),
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
      model,
      provider: this.name,
    };
  }

  private mapStopReason(
    reason: string | null
  ): "end_turn" | "tool_use" | "max_tokens" {
    switch (reason) {
      case "tool_use":
        return "tool_use";
      case "max_tokens":
        return "max_tokens";
      default:
        return "end_turn";
    }
  }
}
