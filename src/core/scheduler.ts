import { Cron } from "croner";
import type { Logger } from "../utils/logger.js";
import type { EventBus } from "./events.js";

export interface ScheduledTaskDef {
  name: string;
  cronExpression: string;
  handler: () => Promise<void>;
  enabled?: boolean;
  description?: string;
}

export interface TaskMetadata {
  name: string;
  cronExpression: string;
  description?: string;
  enabled: boolean;
  lastRun: Date | null;
  lastResult: "success" | "failure" | null;
  lastDurationMs: number | null;
  nextRun: Date | null;
}

export interface TaskSchedulerClient {
  registerTask(task: ScheduledTaskDef): void;
  removeTask(taskName: string): void;
}

interface ManagedTask {
  def: ScheduledTaskDef;
  cron: Cron | null;
  metadata: TaskMetadata;
}

/**
 * Centralized cron-based task scheduler using croner.
 * Skills register tasks via scoped TaskSchedulerClient.
 */
export class TaskScheduler {
  private tasks = new Map<string, ManagedTask>();
  private logger: Logger;
  private eventBus: EventBus;

  constructor(logger: Logger, eventBus: EventBus) {
    this.logger = logger;
    this.eventBus = eventBus;
  }

  registerTask(
    def: ScheduledTaskDef,
    configOverride?: { cron?: string; enabled?: boolean }
  ): void {
    const fullName = def.name;

    if (this.tasks.has(fullName)) {
      this.logger.warn({ task: fullName }, "Task already registered, replacing");
      this.removeTask(fullName);
    }

    const enabled = configOverride?.enabled ?? def.enabled ?? true;
    const cronExpression = configOverride?.cron ?? def.cronExpression;

    const metadata: TaskMetadata = {
      name: fullName,
      cronExpression,
      description: def.description,
      enabled,
      lastRun: null,
      lastResult: null,
      lastDurationMs: null,
      nextRun: null,
    };

    let cron: Cron | null = null;

    if (enabled) {
      cron = new Cron(cronExpression, { catch: true }, async () => {
        await this.executeTask(fullName);
      });
      metadata.nextRun = cron.nextRun() ?? null;
    }

    this.tasks.set(fullName, {
      def: { ...def, cronExpression, enabled },
      cron,
      metadata,
    });

    this.logger.info(
      { task: fullName, cron: cronExpression, enabled },
      "Scheduled task registered"
    );
  }

  removeTask(taskName: string): void {
    const managed = this.tasks.get(taskName);
    if (managed) {
      managed.cron?.stop();
      this.tasks.delete(taskName);
      this.logger.info({ task: taskName }, "Scheduled task removed");
    }
  }

  async executeTask(taskName: string): Promise<void> {
    const managed = this.tasks.get(taskName);
    if (!managed) {
      this.logger.warn({ task: taskName }, "Task not found for execution");
      return;
    }

    if (!managed.metadata.enabled) {
      this.logger.debug({ task: taskName }, "Skipping disabled task");
      return;
    }

    const startTime = Date.now();
    managed.metadata.lastRun = new Date();

    let attempt = 0;
    const maxAttempts = 2;

    while (attempt < maxAttempts) {
      attempt++;
      try {
        await managed.def.handler();
        managed.metadata.lastResult = "success";
        managed.metadata.lastDurationMs = Date.now() - startTime;
        managed.metadata.nextRun = managed.cron?.nextRun() ?? null;

        this.logger.debug(
          {
            task: taskName,
            durationMs: managed.metadata.lastDurationMs,
          },
          "Scheduled task completed"
        );
        return;
      } catch (err) {
        if (attempt < maxAttempts) {
          this.logger.warn(
            { task: taskName, attempt, error: err },
            "Scheduled task failed, retrying"
          );
          continue;
        }

        managed.metadata.lastResult = "failure";
        managed.metadata.lastDurationMs = Date.now() - startTime;
        managed.metadata.nextRun = managed.cron?.nextRun() ?? null;

        this.logger.error(
          { task: taskName, error: err },
          "Scheduled task failed after all retries"
        );

        await this.eventBus.publish({
          eventType: "alert.system.task_failed",
          timestamp: new Date().toISOString(),
          sourceSkill: "scheduler",
          payload: {
            taskName,
            error: err instanceof Error ? err.message : "Unknown error",
          },
          severity: "high",
        });
      }
    }
  }

  toggleTask(
    taskName: string,
    enabled: boolean
  ): { previous: boolean; current: boolean } | null {
    const managed = this.tasks.get(taskName);
    if (!managed) return null;

    const previous = managed.metadata.enabled;
    managed.metadata.enabled = enabled;

    if (enabled && !managed.cron) {
      // Start the cron
      managed.cron = new Cron(
        managed.def.cronExpression,
        { catch: true },
        async () => {
          await this.executeTask(taskName);
        }
      );
      managed.metadata.nextRun = managed.cron.nextRun() ?? null;
    } else if (!enabled && managed.cron) {
      managed.cron.stop();
      managed.cron = null;
      managed.metadata.nextRun = null;
    }

    return { previous, current: enabled };
  }

  listTasks(): TaskMetadata[] {
    return Array.from(this.tasks.values()).map((t) => ({ ...t.metadata }));
  }

  getClientFor(skillName: string): TaskSchedulerClient {
    return {
      registerTask: (task: ScheduledTaskDef) => {
        this.registerTask({
          ...task,
          name: `${skillName}.${task.name}`,
        });
      },
      removeTask: (taskName: string) => {
        this.removeTask(`${skillName}.${taskName}`);
      },
    };
  }

  shutdown(): void {
    for (const [name, managed] of this.tasks) {
      managed.cron?.stop();
      this.logger.debug({ task: name }, "Scheduled task stopped");
    }
    this.tasks.clear();
    this.logger.info("Task scheduler shut down");
  }
}
