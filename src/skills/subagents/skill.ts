/**
 * SubagentSkill: exposes sync and async subagent delegation tools to the LLM.
 * Provides tools for spawning, listing, stopping, inspecting, and messaging subagents.
 * Also exposes specialist_spawn and specialist_list for preset-based delegation.
 */
import type { Skill, SkillToolDefinition } from "../base.js";
import type { SkillContext } from "../context.js";
import type { SubagentManager } from "../../core/subagent-manager.js";
import { getCurrentContext } from "../../core/correlation.js";
import { resolvePreset, getPresetNames } from "../../core/specialist-presets.js";
import type { SpecialistsConfig } from "../../utils/config.js";
import { createEnvelope } from "../../core/subagent-envelope.js";
import type { SubagentTaskType } from "../../core/subagent-envelope.js";

export class SubagentSkill implements Skill {
  readonly name = "subagents";
  readonly description = "Delegate tasks to sub-agents that run in parallel or synchronously";

  private manager?: SubagentManager;
  private specialistConfig?: SpecialistsConfig;

  constructor(manager?: SubagentManager) {
    this.manager = manager;
  }

  /** Provide the manager reference (used when wiring after construction). */
  setManager(manager: SubagentManager): void {
    this.manager = manager;
  }

  /** Set specialist config overrides from app config. */
  setSpecialistConfig(config: SpecialistsConfig | undefined): void {
    this.specialistConfig = config;
  }

  getTools(): SkillToolDefinition[] {
    return [
      {
        name: "delegate_to_subagent",
        description:
          "Delegate a task to a sub-agent that runs synchronously and returns the result in this turn. " +
          "Best for quick tasks requiring 1-3 tool calls. The sub-agent has scoped access only to the tools you specify.",
        input_schema: {
          type: "object",
          properties: {
            task: {
              type: "string",
              description: "Clear description of what the sub-agent should accomplish",
            },
            tools_needed: {
              type: "array",
              items: { type: "string" },
              description: "List of tool names the sub-agent needs access to (e.g. ['note_search', 'note_save'])",
            },
            worker_name: {
              type: "string",
              description: "Optional descriptive name for the sub-agent",
            },
            worker_instructions: {
              type: "string",
              description: "Optional custom system prompt for the sub-agent",
            },
            task_type: {
              type: "string",
              enum: ["research", "code_execution", "data_extraction", "summarization", "analysis", "general"],
              description: "Optional task type for envelope metadata",
            },
            priority: {
              type: "string",
              enum: ["low", "normal", "high"],
              description: "Optional task priority (default: normal)",
            },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Optional tags for the envelope",
            },
          },
          required: ["task", "tools_needed"],
        },
        mainAgentOnly: true,
      },
      {
        name: "sessions_spawn",
        description:
          "Spawn a background sub-agent that runs asynchronously. " +
          "Returns immediately with a run ID. The result will be announced when complete. " +
          "Best for longer research or analysis tasks.",
        input_schema: {
          type: "object",
          properties: {
            task: {
              type: "string",
              description: "Clear description of what the sub-agent should accomplish",
            },
            model: {
              type: "string",
              description: "Optional model ID to use (defaults to user's current model)",
            },
            provider: {
              type: "string",
              description: "Optional provider name (defaults to user's current provider)",
            },
            timeout_minutes: {
              type: "number",
              description: "Timeout in minutes (default: 5, max: 10)",
            },
            allowed_tools: {
              type: "array",
              items: { type: "string" },
              description: "Whitelist of tool names the sub-agent can use",
            },
            blocked_tools: {
              type: "array",
              items: { type: "string" },
              description: "Blacklist of tool names to exclude",
            },
            task_type: {
              type: "string",
              enum: ["research", "code_execution", "data_extraction", "summarization", "analysis", "general"],
              description: "Optional task type for envelope metadata",
            },
            priority: {
              type: "string",
              enum: ["low", "normal", "high"],
              description: "Optional task priority (default: normal)",
            },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Optional tags for the envelope",
            },
          },
          required: ["task"],
        },
        mainAgentOnly: true,
      },
      {
        name: "specialist_spawn",
        description:
          "Delegate a task to a specialist sub-agent with a pre-configured domain focus. " +
          "Each specialist has scoped tools and a tailored system prompt. " +
          "Use specialist_list to see available specialists.",
        input_schema: {
          type: "object",
          properties: {
            specialist: {
              type: "string",
              description: "Specialist preset name (e.g. 'research', 'lab', 'home', 'planner')",
            },
            task: {
              type: "string",
              description: "Clear description of what the specialist should accomplish",
            },
            timeout_minutes: {
              type: "number",
              description: "Timeout in minutes (default: 2, max: 10)",
            },
          },
          required: ["specialist", "task"],
        },
        mainAgentOnly: true,
      },
      {
        name: "specialist_list",
        description: "List available specialist agent presets and their descriptions",
        input_schema: {
          type: "object",
          properties: {},
        },
        mainAgentOnly: true,
        permissionTier: 0,
      },
      {
        name: "sessions_list",
        description: "List your active sub-agent runs",
        input_schema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "sessions_stop",
        description: "Stop a running sub-agent by its run ID",
        input_schema: {
          type: "object",
          properties: {
            run_id: {
              type: "string",
              description: "The run ID to stop",
            },
          },
          required: ["run_id"],
        },
        requiresConfirmation: true,
        mainAgentOnly: true,
      },
      {
        name: "sessions_log",
        description: "Get the execution transcript of a sub-agent run",
        input_schema: {
          type: "object",
          properties: {
            run_id: {
              type: "string",
              description: "The run ID to get logs for",
            },
          },
          required: ["run_id"],
        },
      },
      {
        name: "sessions_info",
        description: "Get detailed information about a sub-agent run",
        input_schema: {
          type: "object",
          properties: {
            run_id: {
              type: "string",
              description: "The run ID to get info for",
            },
          },
          required: ["run_id"],
        },
      },
      {
        name: "sessions_send",
        description: "Send a message to a running sub-agent",
        input_schema: {
          type: "object",
          properties: {
            run_id: {
              type: "string",
              description: "The run ID to send a message to",
            },
            message: {
              type: "string",
              description: "The message to send",
            },
          },
          required: ["run_id", "message"],
        },
      },
    ];
  }

  async execute(
    toolName: string,
    toolInput: Record<string, unknown>
  ): Promise<string> {
    if (!this.manager) {
      return "Subagent manager is not initialized.";
    }

    const ctx = getCurrentContext();
    const userId = ctx?.userId;
    const channel = ctx?.channel ?? "unknown";

    if (!userId) {
      return "Unable to determine user identity for subagent operation.";
    }

    switch (toolName) {
      case "delegate_to_subagent":
        return this.handleDelegateSync(userId, channel, toolInput);

      case "sessions_spawn":
        return this.handleSpawn(userId, channel, toolInput);

      case "sessions_list":
        return this.handleList(userId);

      case "sessions_stop":
        return this.handleStop(userId, toolInput);

      case "sessions_log":
        return this.handleLog(userId, toolInput);

      case "sessions_info":
        return this.handleInfo(userId, toolInput);

      case "sessions_send":
        return this.handleSend(userId, toolInput);

      case "specialist_spawn":
        return this.handleSpecialistSpawn(userId, channel, toolInput);

      case "specialist_list":
        return this.handleSpecialistList();

      default:
        return `Unknown subagent tool: ${toolName}`;
    }
  }

  getRequiredConfig(): string[] {
    return [];
  }

  async startup(_ctx: SkillContext): Promise<void> {
    // Manager is injected via constructor or setManager
  }

  async shutdown(): Promise<void> {
    // SubagentManager handles its own shutdown
  }

  // ---- Tool Handlers ----

  private async handleDelegateSync(
    userId: string,
    channel: string,
    input: Record<string, unknown>
  ): Promise<string> {
    const task = input.task as string;
    const toolsNeeded = input.tools_needed as string[];
    const workerName = input.worker_name as string | undefined;
    const workerInstructions = input.worker_instructions as string | undefined;
    const taskType = input.task_type as SubagentTaskType | undefined;
    const priority = input.priority as "low" | "normal" | "high" | undefined;
    const tags = input.tags as string[] | undefined;

    if (!task || !toolsNeeded || toolsNeeded.length === 0) {
      return "Both 'task' and 'tools_needed' are required for delegation.";
    }

    const envelope = taskType
      ? createEnvelope(crypto.randomUUID(), taskType, task, {
          requesterId: userId,
          requesterChannel: channel,
          priority,
          tags,
        })
      : undefined;

    try {
      return await this.manager!.delegateSync(userId, channel, task, {
        toolsNeeded,
        workerName,
        workerInstructions,
        envelope,
      });
    } catch (err) {
      return `Delegation failed: ${err instanceof Error ? err.message : "Unknown error"}`;
    }
  }

  private async handleSpawn(
    userId: string,
    channel: string,
    input: Record<string, unknown>
  ): Promise<string> {
    const task = input.task as string;
    if (!task) {
      return "The 'task' field is required to spawn a sub-agent.";
    }

    const taskType = input.task_type as SubagentTaskType | undefined;
    const priority = input.priority as "low" | "normal" | "high" | undefined;
    const tags = input.tags as string[] | undefined;

    const envelope = taskType
      ? createEnvelope(crypto.randomUUID(), taskType, task, {
          requesterId: userId,
          requesterChannel: channel,
          priority,
          tags,
        })
      : undefined;

    try {
      const result = await this.manager!.spawn(userId, channel, task, {
        model: input.model as string | undefined,
        provider: input.provider as string | undefined,
        timeoutMinutes: input.timeout_minutes as number | undefined,
        allowedTools: input.allowed_tools as string[] | undefined,
        blockedTools: input.blocked_tools as string[] | undefined,
        envelope,
      });

      return JSON.stringify({
        status: result.status,
        run_id: result.runId,
        message: "Sub-agent spawned. The result will be announced when complete.",
      });
    } catch (err) {
      return `Failed to spawn sub-agent: ${err instanceof Error ? err.message : "Unknown error"}`;
    }
  }

  private handleList(userId: string): string {
    const runs = this.manager!.listRuns(userId);

    if (runs.length === 0) {
      return "No active sub-agent runs.";
    }

    const entries = runs.map((r) => ({
      run_id: r.id.slice(0, 8),
      full_id: r.id,
      status: r.status,
      task: r.task.slice(0, 100),
      mode: r.mode,
      created_at: r.createdAt.toISOString(),
      tool_calls: r.toolCallCount,
    }));

    return JSON.stringify(entries, null, 2);
  }

  private async handleStop(
    userId: string,
    input: Record<string, unknown>
  ): Promise<string> {
    const runId = input.run_id as string;
    if (!runId) return "The 'run_id' field is required.";

    try {
      const stopped = await this.manager!.stopRun(userId, runId);
      if (stopped) {
        return `Sub-agent run ${runId.slice(0, 8)} has been stopped.`;
      }
      return `No active run found with ID ${runId.slice(0, 8)}.`;
    } catch (err) {
      return `Failed to stop run: ${err instanceof Error ? err.message : "Unknown error"}`;
    }
  }

  private handleLog(
    userId: string,
    input: Record<string, unknown>
  ): string {
    const runId = input.run_id as string;
    if (!runId) return "The 'run_id' field is required.";

    const transcript = this.manager!.getRunLog(userId, runId);
    if (!transcript) {
      return `No run found with ID ${runId.slice(0, 8)} or access denied.`;
    }

    if (transcript.length === 0) {
      return "No transcript entries yet.";
    }

    const entries = transcript.map((t) => ({
      role: t.role,
      content: t.content.slice(0, 500),
      tool: t.toolName,
      time: new Date(t.timestamp).toISOString(),
    }));

    return JSON.stringify(entries, null, 2);
  }

  private handleInfo(
    userId: string,
    input: Record<string, unknown>
  ): string {
    const runId = input.run_id as string;
    if (!runId) return "The 'run_id' field is required.";

    const info = this.manager!.getRunInfo(userId, runId);
    if (!info) {
      return `No run found with ID ${runId.slice(0, 8)} or access denied.`;
    }

    return JSON.stringify({
      run_id: info.id,
      status: info.status,
      mode: info.mode,
      task: info.task,
      model: info.model,
      provider: info.provider,
      input_tokens: info.inputTokens,
      output_tokens: info.outputTokens,
      tool_call_count: info.toolCallCount,
      created_at: info.createdAt.toISOString(),
      started_at: info.startedAt?.toISOString(),
      completed_at: info.completedAt?.toISOString(),
      result_preview: info.result?.slice(0, 300),
      error: info.error,
      envelope_result: info.metadata.envelopeResult ?? undefined,
    }, null, 2);
  }

  private async handleSpecialistSpawn(
    userId: string,
    channel: string,
    input: Record<string, unknown>
  ): Promise<string> {
    const specialistName = input.specialist as string;
    const task = input.task as string;

    if (!specialistName || !task) {
      return "Both 'specialist' and 'task' are required.";
    }

    let preset;
    try {
      preset = resolvePreset(specialistName, this.specialistConfig);
    } catch (err) {
      const available = getPresetNames().join(", ");
      return `Unknown specialist '${specialistName}'. Available: ${available}`;
    }

    const envelope = createEnvelope(crypto.randomUUID(), "general", task, {
      requesterId: userId,
      requesterChannel: channel,
      specialistPreset: specialistName,
    });

    try {
      const result = await this.manager!.delegateSync(userId, channel, task, {
        toolsNeeded: preset.allowedTools,
        workerName: `specialist-${specialistName}`,
        workerInstructions: preset.systemPrompt,
        tokenBudget: preset.tokenBudget,
        envelope,
      });
      return result;
    } catch (err) {
      return `Specialist delegation failed: ${err instanceof Error ? err.message : "Unknown error"}`;
    }
  }

  private handleSpecialistList(): string {
    const names = getPresetNames();
    const presets = names.map(name => {
      try {
        const preset = resolvePreset(name, this.specialistConfig);
        return { name: preset.name, description: preset.description, tools: preset.allowedTools };
      } catch {
        return { name, description: "unavailable", tools: [] };
      }
    });
    return JSON.stringify({ specialists: presets }, null, 2);
  }

  private handleSend(
    userId: string,
    input: Record<string, unknown>
  ): string {
    const runId = input.run_id as string;
    const message = input.message as string;
    if (!runId || !message) return "Both 'run_id' and 'message' are required.";

    const sent = this.manager!.sendToRun(userId, runId, message);
    if (sent) {
      return `Message sent to sub-agent ${runId.slice(0, 8)}.`;
    }
    return `Could not send message: run ${runId.slice(0, 8)} not found, not running, or access denied.`;
  }
}
