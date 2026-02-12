/**
 * Unified agent abstraction encapsulating the agentic tool-use loop,
 * scoped tool access, and isolation boundary.
 * Both the main agent and subagents are instances of this class.
 */
import type { LLMProvider, LLMMessage, LLMContentBlock, LLMToolDefinition } from "./llm/provider.js";
import type { SkillRegistry } from "../skills/registry.js";
import type { Logger } from "../utils/logger.js";
import { ResilientExecutor } from "./resilient-executor.js";

const DEFAULT_MAX_TOOL_CALLS = 10;
const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

export interface BaseAgentConfig {
  /** Descriptive name for logging, e.g. "main", "researcher-abc123" */
  name: string;
  /** System prompt to use for this agent */
  systemPrompt: string;
  /** LLM provider to use */
  provider: LLMProvider;
  /** Model ID to use */
  model: string;
  /** Whitelist of skill names (null = all skills) */
  allowedSkills?: string[];
  /** Explicit tool blocklist */
  blockedTools?: string[];
  /** Controls mainAgentOnly filtering — when true, mainAgentOnly tools are excluded */
  isSubagent: boolean;
  /** Safety limit for total tool calls per run */
  maxToolCalls: number;
  /** Per-tool execution timeout in ms */
  toolExecutionTimeoutMs: number;
  /** Cumulative token limit (input + output) */
  maxTokenBudget?: number;
  /** External cancellation signal */
  abortSignal?: AbortSignal;
  /** Max tokens for LLM response */
  maxResponseTokens?: number;
}

export interface AgentRunResult {
  text: string;
  totalTokens: { input: number; output: number };
  toolCallCount: number;
  transcript: TranscriptEntry[];
}

export interface TranscriptEntry {
  role: "user" | "assistant" | "tool_result";
  content: string;
  timestamp: number;
  toolName?: string;
}

export class BaseAgent {
  private transcript: TranscriptEntry[] = [];
  private tools: LLMToolDefinition[];

  constructor(
    private config: BaseAgentConfig,
    private skills: SkillRegistry,
    private logger: Logger
  ) {
    // Build scoped tool list based on config
    this.tools = this.skills.getToolDefinitions({
      allowedSkills: config.allowedSkills,
      blockedTools: config.blockedTools,
      excludeMainAgentOnly: config.isSubagent,
    });

    this.logger.debug(
      { agent: config.name, toolCount: this.tools.length, isSubagent: config.isSubagent },
      "BaseAgent initialized"
    );
  }

  /** Run the agent on a single task. Returns final text response. */
  async run(input: string): Promise<AgentRunResult> {
    const { provider, model, systemPrompt, abortSignal } = this.config;
    const maxToolCalls = this.config.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
    const toolTimeout = this.config.toolExecutionTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    const maxResponseTokens = this.config.maxResponseTokens ?? 4096;

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let toolCallCount = 0;

    // Record input
    this.addTranscript("user", input);

    const tools = provider.capabilities.tools !== false ? this.tools : undefined;
    const messages: LLMMessage[] = [{ role: "user", content: input }];

    // Initial LLM call
    this.checkAbort(abortSignal);
    let response = await provider.chat({
      model,
      system: systemPrompt,
      messages,
      tools: tools && tools.length > 0 ? tools : undefined,
      maxTokens: maxResponseTokens,
    });

    totalInputTokens += response.usage.inputTokens ?? 0;
    totalOutputTokens += response.usage.outputTokens ?? 0;
    this.checkTokenBudget(totalInputTokens + totalOutputTokens);

    // Tool-use loop
    while (response.stopReason === "tool_use") {
      toolCallCount += response.toolCalls.length;

      if (toolCallCount > maxToolCalls) {
        this.logger.warn(
          { agent: this.config.name, toolCallCount },
          "Max tool calls exceeded in agent run"
        );
        const finalText = response.text ?? "Reached maximum number of tool calls.";
        this.addTranscript("assistant", finalText);
        return this.buildResult(finalText, totalInputTokens, totalOutputTokens, toolCallCount);
      }

      // Execute tool calls
      const toolResults = await this.executeTools(response.toolCalls, toolTimeout);

      // Build continuation messages
      const continuationBlocks: LLMContentBlock[] = [];
      if (response.text) {
        continuationBlocks.push({ type: "text", text: response.text });
        this.addTranscript("assistant", response.text);
      }
      for (const tc of response.toolCalls) {
        continuationBlocks.push({
          type: "tool_use",
          id: tc.id,
          name: tc.name,
          input: tc.input,
        });
      }

      const resultBlocks: LLMContentBlock[] = toolResults.map((r) => ({
        type: "tool_result" as const,
        tool_use_id: r.toolCallId,
        content: r.result,
      }));

      // Record tool results in transcript
      for (const r of toolResults) {
        this.addTranscript("tool_result", r.result, r.toolName);
      }

      const continuationMessages: LLMMessage[] = [
        ...messages,
        { role: "assistant", content: continuationBlocks },
        { role: "user", content: resultBlocks },
      ];

      // Continue the conversation
      this.checkAbort(abortSignal);
      response = await provider.chat({
        model,
        system: systemPrompt,
        messages: continuationMessages,
        tools: tools && tools.length > 0 ? tools : undefined,
        maxTokens: maxResponseTokens,
      });

      totalInputTokens += response.usage.inputTokens ?? 0;
      totalOutputTokens += response.usage.outputTokens ?? 0;
      this.checkTokenBudget(totalInputTokens + totalOutputTokens);

      // Update messages for next iteration
      messages.length = 0;
      messages.push(...continuationMessages);
    }

    const finalText = response.text ?? "No response generated.";
    this.addTranscript("assistant", finalText);

    return this.buildResult(finalText, totalInputTokens, totalOutputTokens, toolCallCount);
  }

  /** Get the transcript of this agent's execution. */
  getTranscript(): TranscriptEntry[] {
    return [...this.transcript];
  }

  /** Get the resolved tool definitions for this agent. */
  getToolDefinitions(): LLMToolDefinition[] {
    return [...this.tools];
  }

  private async executeTools(
    toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
    timeout: number
  ): Promise<Array<{ toolCallId: string; toolName: string; result: string }>> {
    const results: Array<{ toolCallId: string; toolName: string; result: string }> = [];

    for (const tc of toolCalls) {
      try {
        const result = await ResilientExecutor.execute(
          () => this.skills.executeToolCall(tc.name, tc.input),
          { timeout, retries: 1 },
          this.logger
        );
        results.push({ toolCallId: tc.id, toolName: tc.name, result });
      } catch (err) {
        this.logger.error(
          { agent: this.config.name, toolName: tc.name, error: err },
          "Tool execution error in agent"
        );
        results.push({
          toolCallId: tc.id,
          toolName: tc.name,
          result: `Error executing ${tc.name}: ${err instanceof Error ? err.message : "Unknown error"}`,
        });
      }
    }

    return results;
  }

  private addTranscript(role: TranscriptEntry["role"], content: string, toolName?: string): void {
    this.transcript.push({
      role,
      content,
      timestamp: Date.now(),
      toolName,
    });
  }

  private checkAbort(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new Error("Agent run was cancelled");
    }
  }

  private checkTokenBudget(totalTokens: number): void {
    if (this.config.maxTokenBudget && totalTokens > this.config.maxTokenBudget) {
      throw new Error(
        `Token budget exceeded: ${totalTokens} > ${this.config.maxTokenBudget}`
      );
    }
  }

  private buildResult(
    text: string,
    inputTokens: number,
    outputTokens: number,
    toolCallCount: number
  ): AgentRunResult {
    return {
      text,
      totalTokens: { input: inputTokens, output: outputTokens },
      toolCallCount,
      transcript: this.getTranscript(),
    };
  }
}
