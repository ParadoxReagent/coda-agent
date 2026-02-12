import type { Skill, SkillToolDefinition } from "../base.js";
import type { SkillContext } from "../context.js";
import type { TaskScheduler } from "../../core/scheduler.js";
import type { EventBus } from "../../core/events.js";
import type { Logger } from "../../utils/logger.js";

/**
 * Skill that exposes scheduler management to the LLM via tools.
 * Allows listing and toggling scheduled tasks.
 */
export class SchedulerSkill implements Skill {
  readonly name = "scheduler";
  readonly description = "List and manage scheduled background tasks";

  private taskScheduler: TaskScheduler;
  private logger!: Logger;
  private eventBus!: EventBus;

  constructor(taskScheduler: TaskScheduler) {
    this.taskScheduler = taskScheduler;
  }

  getTools(): SkillToolDefinition[] {
    return [
      {
        name: "scheduler_list",
        description:
          "List all scheduled tasks with their status, next run time, and last result.",
        input_schema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "scheduler_toggle",
        description:
          "Enable or disable a scheduled task. Requires confirmation.",
        input_schema: {
          type: "object",
          properties: {
            task_name: {
              type: "string",
              description: "The full task name (e.g., 'email.poll', 'reminders.check')",
            },
            enabled: {
              type: "boolean",
              description: "Whether to enable (true) or disable (false) the task",
            },
          },
          required: ["task_name", "enabled"],
        },
        requiresConfirmation: true,
        mainAgentOnly: true,
      },
    ];
  }

  async execute(
    toolName: string,
    toolInput: Record<string, unknown>
  ): Promise<string> {
    switch (toolName) {
      case "scheduler_list":
        return this.listTasks();
      case "scheduler_toggle":
        return this.toggleTask(toolInput);
      default:
        return `Unknown tool: ${toolName}`;
    }
  }

  getRequiredConfig(): string[] {
    return [];
  }

  async startup(ctx: SkillContext): Promise<void> {
    this.logger = ctx.logger;
    this.eventBus = ctx.eventBus;
    this.logger.info("Scheduler skill started");
  }

  async shutdown(): Promise<void> {
    this.logger?.info("Scheduler skill stopped");
  }

  private listTasks(): string {
    const tasks = this.taskScheduler.listTasks();

    if (tasks.length === 0) {
      return JSON.stringify({
        tasks: [],
        message: "No scheduled tasks registered.",
      });
    }

    return JSON.stringify({
      tasks: tasks.map((t) => ({
        name: t.name,
        cron: t.cronExpression,
        description: t.description ?? null,
        enabled: t.enabled,
        lastRun: t.lastRun?.toISOString() ?? null,
        lastResult: t.lastResult,
        lastDurationMs: t.lastDurationMs,
        nextRun: t.nextRun?.toISOString() ?? null,
      })),
      count: tasks.length,
    });
  }

  private async toggleTask(
    input: Record<string, unknown>
  ): Promise<string> {
    const taskName = input.task_name as string;
    const enabled = input.enabled as boolean;

    const result = this.taskScheduler.toggleTask(taskName, enabled);
    if (!result) {
      return JSON.stringify({
        success: false,
        message: `Task "${taskName}" not found`,
      });
    }

    // Publish audit event
    await this.eventBus.publish({
      eventType: "scheduler.task_toggled",
      timestamp: new Date().toISOString(),
      sourceSkill: "scheduler",
      payload: {
        taskName,
        previousState: result.previous,
        currentState: result.current,
      },
      severity: "low",
    });

    return JSON.stringify({
      success: true,
      taskName,
      previousState: result.previous ? "enabled" : "disabled",
      currentState: result.current ? "enabled" : "disabled",
      message: `Task "${taskName}" ${result.current ? "enabled" : "disabled"}`,
    });
  }
}
