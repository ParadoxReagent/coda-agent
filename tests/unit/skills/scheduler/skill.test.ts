import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SchedulerSkill } from "../../../../src/skills/scheduler/skill.js";
import { TaskScheduler } from "../../../../src/core/scheduler.js";
import {
  createMockSkillContext,
  createMockEventBus,
  createMockLogger,
} from "../../../helpers/mocks.js";
import type { SkillContext } from "../../../../src/skills/context.js";

describe("SchedulerSkill", () => {
  let scheduler: TaskScheduler;
  let skill: SchedulerSkill;
  let ctx: SkillContext;
  let eventBus: ReturnType<typeof createMockEventBus>;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-15T10:00:00.000Z"));

    eventBus = createMockEventBus();
    scheduler = new TaskScheduler(createMockLogger(), eventBus);
    skill = new SchedulerSkill(scheduler);
    ctx = {
      ...createMockSkillContext("scheduler"),
      eventBus,
    };
    await skill.startup(ctx);
  });

  afterEach(async () => {
    await skill.shutdown();
    scheduler.shutdown();
    vi.useRealTimers();
  });

  it("has correct metadata", () => {
    expect(skill.name).toBe("scheduler");
    expect(skill.getRequiredConfig()).toEqual([]);
  });

  it("registers 2 tools", () => {
    const tools = skill.getTools();
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name)).toEqual([
      "scheduler_list",
      "scheduler_toggle",
    ]);
  });

  it("scheduler_toggle requires confirmation", () => {
    const tools = skill.getTools();
    const toggleTool = tools.find((t) => t.name === "scheduler_toggle");
    expect(toggleTool!.requiresConfirmation).toBe(true);
  });

  describe("scheduler_list", () => {
    it("returns empty list when no tasks registered", async () => {
      const result = await skill.execute("scheduler_list", {});
      const parsed = JSON.parse(result);
      expect(parsed.tasks).toEqual([]);
      expect(parsed.message).toContain("No scheduled tasks");
    });

    it("returns formatted task list", async () => {
      scheduler.registerTask({
        name: "email.poll",
        cronExpression: "*/5 * * * *",
        handler: async () => {},
        description: "Poll emails",
      });

      scheduler.registerTask({
        name: "reminders.check",
        cronExpression: "* * * * *",
        handler: async () => {},
        description: "Check reminders",
        enabled: false,
      });

      const result = await skill.execute("scheduler_list", {});
      const parsed = JSON.parse(result);
      expect(parsed.count).toBe(2);
      expect(parsed.tasks[0].name).toBe("email.poll");
      expect(parsed.tasks[0].enabled).toBe(true);
      expect(parsed.tasks[0].cron).toBe("*/5 * * * *");
      expect(parsed.tasks[1].name).toBe("reminders.check");
      expect(parsed.tasks[1].enabled).toBe(false);
    });
  });

  describe("scheduler_toggle", () => {
    it("disables a task and publishes audit event", async () => {
      scheduler.registerTask({
        name: "email.poll",
        cronExpression: "*/5 * * * *",
        handler: async () => {},
      });

      const result = await skill.execute("scheduler_toggle", {
        task_name: "email.poll",
        enabled: false,
      });

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.previousState).toBe("enabled");
      expect(parsed.currentState).toBe("disabled");

      // Check audit event
      const auditEvents = eventBus.publishedEvents.filter(
        (e) => e.eventType === "scheduler.task_toggled"
      );
      expect(auditEvents).toHaveLength(1);
      expect(auditEvents[0]!.payload.taskName).toBe("email.poll");
      expect(auditEvents[0]!.payload.previousState).toBe(true);
      expect(auditEvents[0]!.payload.currentState).toBe(false);
    });

    it("enables a disabled task", async () => {
      scheduler.registerTask({
        name: "email.poll",
        cronExpression: "*/5 * * * *",
        handler: async () => {},
        enabled: false,
      });

      const result = await skill.execute("scheduler_toggle", {
        task_name: "email.poll",
        enabled: true,
      });

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.previousState).toBe("disabled");
      expect(parsed.currentState).toBe("enabled");
    });

    it("returns error for nonexistent task", async () => {
      const result = await skill.execute("scheduler_toggle", {
        task_name: "nonexistent.task",
        enabled: true,
      });

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.message).toContain("not found");
    });
  });

  it("returns unknown tool message for invalid tool name", async () => {
    const result = await skill.execute("scheduler_invalid", {});
    expect(result).toContain("Unknown tool");
  });
});
