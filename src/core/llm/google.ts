import { GoogleGenAI } from "@google/genai";
import type {
  LLMProvider,
  LLMChatParams,
  LLMResponse,
  LLMToolCall,
  LLMToolDefinition,
  ProviderCapabilities,
} from "./provider.js";
import {
  DEFAULT_GOOGLE_CAPABILITIES,
  mergeCapabilities,
} from "./capabilities.js";
import type { ProviderCapabilitiesConfig } from "../../utils/config.js";

export class GoogleProvider implements LLMProvider {
  readonly name = "google";
  readonly capabilities: ProviderCapabilities;
  private client: GoogleGenAI;

  constructor(apiKey: string, capabilityOverrides?: ProviderCapabilitiesConfig) {
    this.client = new GoogleGenAI({ apiKey });
    this.capabilities = mergeCapabilities(
      DEFAULT_GOOGLE_CAPABILITIES,
      capabilityOverrides
    );
  }

  async chat(params: LLMChatParams): Promise<LLMResponse> {
    const tools = params.tools?.length
      ? [
          {
            functionDeclarations: params.tools.map((t) =>
              this.toGeminiFunction(t)
            ),
          },
        ]
      : undefined;

    // Build Gemini contents from messages
    const contents = params.messages.map((m) => {
      const role = m.role === "assistant" ? "model" : "user";
      if (typeof m.content === "string") {
        return { role, parts: [{ text: m.content }] };
      }
      const parts = m.content.map((block) => {
        if (block.type === "text") return { text: block.text };
        if (block.type === "tool_use") {
          return {
            functionCall: { name: block.name, args: block.input },
          };
        }
        if (block.type === "tool_result") {
          return {
            functionResponse: {
              name: block.tool_use_id,
              response: { result: block.content },
            },
          };
        }
        return { text: "" };
      });
      return { role, parts };
    });

    const response = await this.client.models.generateContent({
      model: params.model,
      contents: contents as Parameters<typeof this.client.models.generateContent>[0]["contents"],
      config: {
        systemInstruction: params.system,
        maxOutputTokens: params.maxTokens ?? 4096,
        tools: tools as Parameters<typeof this.client.models.generateContent>[0]["config"] extends { tools?: infer T } ? T : never,
      },
    });

    return this.toResponse(response, params.model);
  }

  private toGeminiFunction(tool: LLMToolDefinition): Record<string, unknown> {
    // Convert JSON Schema to Gemini FunctionDeclaration format
    const { type: _type, ...schemaWithoutType } = tool.input_schema;
    return {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: "OBJECT",
        ...schemaWithoutType,
      },
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private toResponse(response: any, model: string): LLMResponse {
    let text: string | null = null;
    const toolCalls: LLMToolCall[] = [];

    const candidate = response.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];

    for (const part of parts) {
      if (part.text) {
        text = part.text;
      }
      if (part.functionCall) {
        toolCalls.push({
          id: `gemini-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: part.functionCall.name,
          input: part.functionCall.args ?? {},
        });
      }
    }

    const finishReason = candidate?.finishReason;
    const stopReason = this.mapStopReason(finishReason);

    const usageMetadata = response.usageMetadata;

    return {
      text,
      toolCalls,
      stopReason,
      usage: {
        inputTokens: usageMetadata?.promptTokenCount ?? null,
        outputTokens: usageMetadata?.candidatesTokenCount ?? null,
      },
      model,
      provider: this.name,
    };
  }

  private mapStopReason(
    reason: string | undefined
  ): "end_turn" | "tool_use" | "max_tokens" {
    switch (reason) {
      case "STOP":
        return "end_turn";
      case "MAX_TOKENS":
        return "max_tokens";
      // Gemini returns function calls with a STOP reason but also includes functionCall parts
      default:
        return "end_turn";
    }
  }
}
