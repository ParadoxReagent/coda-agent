/**
 * TaskExecutionSkill (4.5): Persistent multi-day tasks with checkpointing.
 *
 * Tools: task_create, task_status, task_advance, task_block
 * Scheduled: task_resume (every 15 min) — resurfaces tasks whose next_action_at has arrived.
 */
import type { Skill, SkillToolDefinition } from "../base.js";
import type { SkillContext } from "../context.js";
import type { Database } from "../../db/index.js";
import type { MessageSender } from "../../core/message-sender.js";
import { taskState } from "../../db/schema.js";
import { eq, and, lte, inArray } from "drizzle-orm";
import type { TaskStep, TaskBlocker } from "./types.js";

export class TaskExecutionSkill implements Skill {
  readonly name = "tasks";
  readonly description = "Persistent multi-day task tracking with checkpointing and auto-resumption";
  readonly kind = "skill" as const;

  private db?: Database;
  private messageSender?: MessageSender;
  private resumeCron: string;

  constructor(config?: { max_active_per_user?: number; resume_cron?: string }) {
    this.resumeCron = config?.resume_cron ?? "*/15 * * * *";
  }

  getRequiredConfig(): string[] {
    return [];
  }

  getTools(): SkillToolDefinition[] {
    return [
      {
        name: "task_create",
        description: "Create a persistent multi-day task with explicit steps and an optional schedule for the first action.",
        input_schema: {
          type: "object" as const,
          properties: {
            goal: { type: "string", description: "High-level goal of the task" },
            steps: {
              type: "array",
              items: { type: "string" },
              description: "Ordered list of step descriptions",
            },
            next_action_at: {
              type: "string",
              description: "ISO timestamp for when to resume (optional, defaults to now)",
            },
          },
          required: ["goal", "steps"],
        },
        permissionTier: 1,
      },
      {
        name: "task_status",
        description: "Get status of a specific task by ID, or list all active tasks for the current user.",
        input_schema: {
          type: "object" as const,
          properties: {
            task_id: { type: "string", description: "Task ID (optional — omit to list all active)" },
          },
        },
        permissionTier: 0,
      },
      {
        name: "task_advance",
        description: "Mark the current step as completed and advance to the next step. Optionally schedule the next action.",
        input_schema: {
          type: "object" as const,
          properties: {
            task_id: { type: "string", description: "Task ID" },
            result: { type: "string", description: "Result or notes from completing this step" },
            next_action_at: { type: "string", description: "When to resume (ISO timestamp, optional)" },
          },
          required: ["task_id"],
        },
        permissionTier: 1,
      },
      {
        name: "task_block",
        description: "Mark a task as blocked, recording the reason. Task will not auto-resume until unblocked.",
        input_schema: {
          type: "object" as const,
          properties: {
            task_id: { type: "string", description: "Task ID" },
            blocker: { type: "string", description: "Description of what is blocking progress" },
            blocker_type: {
              type: "string",
              enum: ["user_input", "external_dependency", "technical", "other"],
              description: "Category of blocker",
            },
          },
          required: ["task_id", "blocker"],
        },
        permissionTier: 1,
      },
    ];
  }

  async startup(ctx: SkillContext): Promise<void> {
    this.db = ctx.db;
    this.messageSender = ctx.messageSender;

    // Register resume cron
    if (ctx.scheduler) {
      ctx.scheduler.registerTask({
        name: "task_resume",
        cronExpression: this.resumeCron,
        handler: () => this.resumeOverdueTasks(ctx),
        enabled: true,
        description: "Resume active tasks whose next_action_at has arrived",
      });
    }
  }

  async shutdown(): Promise<void> {}

  async execute(toolName: string, input: Record<string, unknown>): Promise<string> {
    switch (toolName) {
      case "task_create": return this.createTask(input);
      case "task_status": return this.getTaskStatus(input);
      case "task_advance": return this.advanceTask(input);
      case "task_block": return this.blockTask(input);
      default: return `Unknown tool: ${toolName}`;
    }
  }

  private async createTask(input: Record<string, unknown>): Promise<string> {
    if (!this.db) return "Database not initialized";

    const goal = input.goal as string;
    const stepDescriptions = input.steps as string[];
    const nextActionAt = input.next_action_at
      ? new Date(input.next_action_at as string)
      : new Date();

    // Check active task limit (we need userId from context — use metadata hack)
    const userId = (input._userId as string) ?? "system";
    const channel = (input._channel as string) ?? "unknown";

    const steps: TaskStep[] = stepDescriptions.map((desc, i) => ({
      index: i,
      description: desc,
      status: "pending",
    }));

    const [created] = await this.db.insert(taskState).values({
      userId,
      channel,
      goal,
      steps,
      currentStep: 0,
      status: "active",
      blockers: [],
      nextActionAt,
      metadata: {},
    }).returning({ id: taskState.id });

    if (!created) return "Failed to create task";

    return JSON.stringify({
      success: true,
      task_id: created.id,
      goal,
      step_count: steps.length,
      next_action_at: nextActionAt.toISOString(),
      message: `Task created with ${steps.length} steps. First action scheduled for ${nextActionAt.toISOString()}.`,
    });
  }

  private async getTaskStatus(input: Record<string, unknown>): Promise<string> {
    if (!this.db) return "Database not initialized";

    const taskId = input.task_id as string | undefined;
    const userId = (input._userId as string) ?? "system";

    if (taskId) {
      const [task] = await this.db
        .select()
        .from(taskState)
        .where(eq(taskState.id, taskId))
        .limit(1);

      if (!task) return JSON.stringify({ error: "Task not found" });

      return JSON.stringify({
        id: task.id,
        goal: task.goal,
        status: task.status,
        current_step: task.currentStep,
        total_steps: (task.steps as TaskStep[]).length,
        steps: task.steps,
        blockers: task.blockers,
        next_action_at: task.nextActionAt?.toISOString(),
        result: task.result,
        created_at: task.createdAt.toISOString(),
        updated_at: task.updatedAt.toISOString(),
      });
    }

    // List all active tasks for user
    const tasks = await this.db
      .select({
        id: taskState.id,
        goal: taskState.goal,
        status: taskState.status,
        currentStep: taskState.currentStep,
        steps: taskState.steps,
        nextActionAt: taskState.nextActionAt,
        createdAt: taskState.createdAt,
      })
      .from(taskState)
      .where(and(
        eq(taskState.userId, userId),
        inArray(taskState.status, ["active", "paused"])
      ))
      .limit(20);

    return JSON.stringify({
      tasks: tasks.map(t => ({
        id: t.id,
        goal: t.goal,
        status: t.status,
        progress: `${t.currentStep}/${(t.steps as TaskStep[]).length}`,
        next_action_at: t.nextActionAt?.toISOString(),
        created_at: t.createdAt.toISOString(),
      })),
      total: tasks.length,
    });
  }

  private async advanceTask(input: Record<string, unknown>): Promise<string> {
    if (!this.db) return "Database not initialized";

    const taskId = input.task_id as string;
    const result = input.result as string | undefined;
    const nextActionAt = input.next_action_at
      ? new Date(input.next_action_at as string)
      : undefined;

    const [task] = await this.db
      .select()
      .from(taskState)
      .where(eq(taskState.id, taskId))
      .limit(1);

    if (!task) return JSON.stringify({ error: "Task not found" });
    if (task.status === "completed") return JSON.stringify({ error: "Task is already completed" });

    const steps = task.steps as TaskStep[];
    const currentIdx = task.currentStep ?? 0;

    // Mark current step complete
    if (steps[currentIdx]) {
      steps[currentIdx]!.status = "completed";
      steps[currentIdx]!.result = result;
      steps[currentIdx]!.completedAt = new Date().toISOString();
    }

    const nextIdx = currentIdx + 1;
    const isComplete = nextIdx >= steps.length;

    await this.db
      .update(taskState)
      .set({
        steps,
        currentStep: nextIdx,
        status: isComplete ? "completed" : "active",
        result: isComplete ? (result ?? "Task completed") : task.result,
        nextActionAt: isComplete ? null : (nextActionAt ?? null),
        updatedAt: new Date(),
      })
      .where(eq(taskState.id, taskId));

    if (isComplete) {
      return JSON.stringify({
        success: true,
        task_id: taskId,
        message: "Task completed! All steps finished.",
        final_result: result,
      });
    }

    const nextStep = steps[nextIdx];
    return JSON.stringify({
      success: true,
      task_id: taskId,
      completed_step: currentIdx,
      next_step: nextIdx,
      next_step_description: nextStep?.description,
      next_action_at: nextActionAt?.toISOString(),
      remaining_steps: steps.length - nextIdx,
    });
  }

  private async blockTask(input: Record<string, unknown>): Promise<string> {
    if (!this.db) return "Database not initialized";

    const taskId = input.task_id as string;
    const blockerDesc = input.blocker as string;
    const blockerType = (input.blocker_type as TaskBlocker["type"]) ?? "other";

    const [task] = await this.db
      .select({ id: taskState.id, blockers: taskState.blockers, status: taskState.status })
      .from(taskState)
      .where(eq(taskState.id, taskId))
      .limit(1);

    if (!task) return JSON.stringify({ error: "Task not found" });

    const blockers = (task.blockers as TaskBlocker[] | null) ?? [];
    blockers.push({
      description: blockerDesc,
      type: blockerType,
      createdAt: new Date().toISOString(),
    });

    await this.db
      .update(taskState)
      .set({
        status: "paused",
        blockers,
        updatedAt: new Date(),
      })
      .where(eq(taskState.id, taskId));

    return JSON.stringify({
      success: true,
      task_id: taskId,
      message: `Task paused. Blocker recorded: ${blockerDesc}`,
      blocker_type: blockerType,
    });
  }

  /**
   * Scheduled handler: resurface tasks whose next_action_at has arrived.
   * Uses light LLM to decide next action; notifies user for complex continuations.
   */
  private async resumeOverdueTasks(ctx: SkillContext): Promise<void> {
    if (!this.db) return;

    try {
      const now = new Date();
      const overdue = await this.db
        .select()
        .from(taskState)
        .where(and(
          eq(taskState.status, "active"),
          lte(taskState.nextActionAt, now)
        ))
        .limit(20);

      for (const task of overdue) {
        await this.notifyTaskResumption(task, ctx);
      }
    } catch (err) {
      ctx.logger.warn({ error: err }, "task_resume cron failed");
    }
  }

  private async notifyTaskResumption(
    task: typeof taskState.$inferSelect,
    ctx: SkillContext
  ): Promise<void> {
    try {
      const steps = task.steps as TaskStep[];
      const currentStep = steps[task.currentStep ?? 0];
      const message = `**Task Resumption Notice**\n📋 **Goal:** ${task.goal}\n🔄 **Current step (${(task.currentStep ?? 0) + 1}/${steps.length}):** ${currentStep?.description ?? "Unknown"}\n\nUse \`task_advance ${task.id}\` to mark this step complete.`;

      await this.messageSender?.send(task.channel, message, "tasks");

      // Clear next_action_at to avoid re-notifying
      await this.db!
        .update(taskState)
        .set({ nextActionAt: null, updatedAt: new Date() })
        .where(eq(taskState.id, task.id));
    } catch (err) {
      ctx.logger.debug({ error: err, taskId: task.id }, "Failed to notify task resumption");
    }
  }
}
