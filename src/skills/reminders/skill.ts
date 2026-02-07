import { eq, and, lte } from "drizzle-orm";
import { getDatabase } from "../../db/connection.js";
import { reminders } from "../../db/schema.js";
import { parseNaturalTime } from "./time-parser.js";
import type { Skill, SkillToolDefinition } from "../base.js";
import type { SkillContext } from "../context.js";
import type { SkillRedisClient } from "../context.js";
import type { EventBus } from "../../core/events.js";
import type { Logger } from "../../utils/logger.js";
import type { Database } from "../../db/index.js";

const DEFAULT_USER_ID = "default";
const DEFAULT_TIMEZONE = "America/New_York";
const NOTIFIED_KEY_PREFIX = "reminder:notified:";

export class ReminderSkill implements Skill {
  readonly name = "reminders";
  readonly description =
    "Create, list, complete, and snooze reminders with natural language time parsing";

  private logger!: Logger;
  private db!: Database;
  private redis!: SkillRedisClient;
  private eventBus!: EventBus;
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private timezone = DEFAULT_TIMEZONE;

  getTools(): SkillToolDefinition[] {
    return [
      {
        name: "reminder_create",
        description:
          "Create a new reminder. Supports natural language time: 'in 2 hours', 'Friday at 3pm', 'every Monday at 9am'.",
        input_schema: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description: "What to be reminded about",
            },
            time: {
              type: "string",
              description:
                "When to be reminded (natural language, e.g., 'in 2 hours', 'tomorrow at 9am', 'every Monday at 9am')",
            },
            description: {
              type: "string",
              description: "Optional additional details",
            },
          },
          required: ["title", "time"],
        },
      },
      {
        name: "reminder_list",
        description: "List reminders, optionally filtered by status.",
        input_schema: {
          type: "object",
          properties: {
            status: {
              type: "string",
              enum: ["pending", "completed", "all"],
              description: "Filter by status (default: pending)",
            },
            limit: {
              type: "number",
              description: "Max results (default 20)",
            },
          },
        },
      },
      {
        name: "reminder_complete",
        description:
          "Mark a reminder as completed. If recurring, automatically creates the next occurrence.",
        input_schema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "The UUID of the reminder",
            },
          },
          required: ["id"],
        },
      },
      {
        name: "reminder_snooze",
        description: "Snooze a reminder to a later time.",
        input_schema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "The UUID of the reminder",
            },
            until: {
              type: "string",
              description:
                "When to be reminded again (natural language, e.g., 'in 15 minutes', 'tomorrow morning')",
            },
          },
          required: ["id", "until"],
        },
      },
    ];
  }

  async execute(
    toolName: string,
    toolInput: Record<string, unknown>
  ): Promise<string> {
    switch (toolName) {
      case "reminder_create":
        return this.createReminder(toolInput);
      case "reminder_list":
        return this.listReminders(toolInput);
      case "reminder_complete":
        return this.completeReminder(toolInput);
      case "reminder_snooze":
        return this.snoozeReminder(toolInput);
      default:
        return `Unknown tool: ${toolName}`;
    }
  }

  getRequiredConfig(): string[] {
    return [];
  }

  async startup(ctx: SkillContext): Promise<void> {
    this.logger = ctx.logger;
    this.db = getDatabase();
    this.redis = ctx.redis;
    this.eventBus = ctx.eventBus;

    const configTz = ctx.config.timezone as string | undefined;
    if (configTz) {
      this.timezone = configTz;
    }

    const checkIntervalSec =
      (ctx.config.check_interval_seconds as number | undefined) ?? 60;

    // Start background reminder checker
    this.checkInterval = setInterval(
      () => this.checkDueReminders().catch((err) => {
        this.logger.error({ error: err }, "Error checking due reminders");
      }),
      checkIntervalSec * 1000
    );

    this.logger.info(
      { checkIntervalSec, timezone: this.timezone },
      "Reminders skill started"
    );
  }

  async shutdown(): Promise<void> {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    this.logger?.info("Reminders skill stopped");
  }

  /** Background checker: find and publish overdue reminders. */
  async checkDueReminders(): Promise<void> {
    const now = new Date();

    const dueReminders = await this.db
      .select()
      .from(reminders)
      .where(
        and(
          eq(reminders.status, "pending"),
          lte(reminders.dueAt, now)
        )
      )
      .orderBy(reminders.dueAt);

    for (const reminder of dueReminders) {
      // Check if already notified (avoid duplicate alerts)
      const notifiedKey = `${NOTIFIED_KEY_PREFIX}${reminder.id}`;
      const alreadyNotified = await this.redis.get(notifiedKey);
      if (alreadyNotified) continue;

      // Check if snoozed
      if (reminder.snoozedUntil && reminder.snoozedUntil > now) continue;

      // Publish alert event
      await this.eventBus.publish({
        eventType: "alert.reminder.due",
        timestamp: now.toISOString(),
        sourceSkill: this.name,
        payload: {
          reminderId: reminder.id,
          title: reminder.title,
          description: reminder.description,
          dueAt: reminder.dueAt.toISOString(),
          recurring: reminder.recurring,
        },
        severity: "medium",
      });

      // Mark as notified for 1 hour (so it doesn't re-fire every check)
      await this.redis.set(notifiedKey, "1", 3600);

      this.logger.info(
        { reminderId: reminder.id, title: reminder.title },
        "Reminder due alert published"
      );
    }
  }

  private async createReminder(
    input: Record<string, unknown>
  ): Promise<string> {
    const title = input.title as string;
    const timeStr = input.time as string;
    const description = (input.description as string | undefined) ?? null;

    const parsed = parseNaturalTime(timeStr, this.timezone);
    if (!parsed) {
      return JSON.stringify({
        success: false,
        message: `Could not parse time from "${timeStr}". Try something like "in 2 hours", "tomorrow at 3pm", or "every Monday at 9am".`,
      });
    }

    const [inserted] = await this.db
      .insert(reminders)
      .values({
        userId: DEFAULT_USER_ID,
        title,
        description,
        dueAt: parsed.date,
        recurring: parsed.isRecurring
          ? parsed.cronExpression ?? parsed.text
          : null,
        status: "pending",
      })
      .returning({ id: reminders.id, dueAt: reminders.dueAt });

    return JSON.stringify({
      success: true,
      id: inserted!.id,
      title,
      dueAt: inserted!.dueAt.toISOString(),
      parsedTime: parsed.text,
      isRecurring: parsed.isRecurring,
      message: `Reminder set: "${title}" — ${parsed.text}`,
    });
  }

  private async listReminders(
    input: Record<string, unknown>
  ): Promise<string> {
    const statusFilter = (input.status as string | undefined) ?? "pending";
    const limit = (input.limit as number | undefined) ?? 20;

    const conditions = [eq(reminders.userId, DEFAULT_USER_ID)];
    if (statusFilter !== "all") {
      conditions.push(eq(reminders.status, statusFilter));
    }

    const results = await this.db
      .select({
        id: reminders.id,
        title: reminders.title,
        description: reminders.description,
        dueAt: reminders.dueAt,
        recurring: reminders.recurring,
        status: reminders.status,
        snoozedUntil: reminders.snoozedUntil,
        createdAt: reminders.createdAt,
      })
      .from(reminders)
      .where(and(...conditions))
      .orderBy(reminders.dueAt)
      .limit(limit);

    if (results.length === 0) {
      return JSON.stringify({
        results: [],
        message:
          statusFilter === "pending"
            ? "No pending reminders"
            : `No ${statusFilter} reminders found`,
      });
    }

    return JSON.stringify({
      results: results.map((r) => ({
        id: r.id,
        title: r.title,
        description: r.description,
        dueAt: r.dueAt.toISOString(),
        recurring: r.recurring,
        status: r.status,
        snoozedUntil: r.snoozedUntil?.toISOString() ?? null,
      })),
      count: results.length,
    });
  }

  private async completeReminder(
    input: Record<string, unknown>
  ): Promise<string> {
    const id = input.id as string;

    const [existing] = await this.db
      .select()
      .from(reminders)
      .where(
        and(eq(reminders.id, id), eq(reminders.userId, DEFAULT_USER_ID))
      );

    if (!existing) {
      return JSON.stringify({
        success: false,
        message: `Reminder "${id}" not found`,
      });
    }

    // Mark as completed
    await this.db
      .update(reminders)
      .set({
        status: "completed",
        completedAt: new Date(),
      })
      .where(eq(reminders.id, id));

    // If recurring, create next occurrence
    if (existing.recurring) {
      const nextParsed = parseNaturalTime(
        existing.recurring,
        this.timezone,
        new Date()
      );
      if (nextParsed) {
        await this.db.insert(reminders).values({
          userId: DEFAULT_USER_ID,
          title: existing.title,
          description: existing.description,
          dueAt: nextParsed.date,
          recurring: existing.recurring,
          status: "pending",
        });
      }
    }

    // Clear notification tracking
    await this.redis.del(`${NOTIFIED_KEY_PREFIX}${id}`);

    return JSON.stringify({
      success: true,
      message: `Reminder "${existing.title}" completed`,
      nextOccurrence: existing.recurring ? "Created next occurrence" : null,
    });
  }

  private async snoozeReminder(
    input: Record<string, unknown>
  ): Promise<string> {
    const id = input.id as string;
    const until = input.until as string;

    const parsed = parseNaturalTime(until, this.timezone);
    if (!parsed) {
      return JSON.stringify({
        success: false,
        message: `Could not parse snooze time from "${until}".`,
      });
    }

    const [updated] = await this.db
      .update(reminders)
      .set({ snoozedUntil: parsed.date })
      .where(
        and(eq(reminders.id, id), eq(reminders.userId, DEFAULT_USER_ID))
      )
      .returning({ id: reminders.id, title: reminders.title });

    if (!updated) {
      return JSON.stringify({
        success: false,
        message: `Reminder "${id}" not found`,
      });
    }

    // Clear notification so it can re-fire at snooze time
    await this.redis.del(`${NOTIFIED_KEY_PREFIX}${id}`);

    return JSON.stringify({
      success: true,
      message: `Reminder "${updated.title}" snoozed until ${parsed.text}`,
      snoozedUntil: parsed.date.toISOString(),
    });
  }
}
