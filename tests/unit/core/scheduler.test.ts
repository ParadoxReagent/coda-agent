import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TaskScheduler } from "../../../src/core/scheduler.js";
import { createMockLogger, createMockEventBus } from "../../helpers/mocks.js";

describe("TaskScheduler", () => {
  let scheduler: TaskScheduler;
  let logger: ReturnType<typeof createMockLogger>;
  let eventBus: ReturnType<typeof createMockEventBus>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    logger = createMockLogger();
    eventBus = createMockEventBus();
    scheduler = new TaskScheduler(logger, eventBus);
  });

  afterEach(() => {
    scheduler.shutdown();
    vi.useRealTimers();
  });

  describe("registerTask", () => {
    it("registers a task and appears in listTasks()", () => {
      scheduler.registerTask({
        name: "test.task",
        cronExpression: "*/5 * * * *",
        handler: async () => {},
        description: "A test task",
      });

      const tasks = scheduler.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.name).toBe("test.task");
      expect(tasks[0]!.cronExpression).toBe("*/5 * * * *");
      expect(tasks[0]!.enabled).toBe(true);
      expect(tasks[0]!.description).toBe("A test task");
    });

    it("replaces existing task with same name", () => {
      const handler1 = vi.fn(async () => {});
      const handler2 = vi.fn(async () => {});

      scheduler.registerTask({
        name: "test.task",
        cronExpression: "*/5 * * * *",
        handler: handler1,
      });

      scheduler.registerTask({
        name: "test.task",
        cronExpression: "*/10 * * * *",
        handler: handler2,
      });

      const tasks = scheduler.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.cronExpression).toBe("*/10 * * * *");
    });

    it("respects enabled=false in task definition", () => {
      scheduler.registerTask({
        name: "disabled.task",
        cronExpression: "*/5 * * * *",
        handler: async () => {},
        enabled: false,
      });

      const tasks = scheduler.listTasks();
      expect(tasks[0]!.enabled).toBe(false);
      expect(tasks[0]!.nextRun).toBeNull();
    });

    it("applies config override for cron and enabled", () => {
      scheduler.registerTask(
        {
          name: "overridden.task",
          cronExpression: "*/5 * * * *",
          handler: async () => {},
        },
        { cron: "*/10 * * * *", enabled: false }
      );

      const tasks = scheduler.listTasks();
      expect(tasks[0]!.cronExpression).toBe("*/10 * * * *");
      expect(tasks[0]!.enabled).toBe(false);
    });
  });

  describe("executeTask", () => {
    it("executes handler and records success", async () => {
      const handler = vi.fn(async () => {});
      scheduler.registerTask({
        name: "exec.task",
        cronExpression: "*/5 * * * *",
        handler,
      });

      await scheduler.executeTask("exec.task");

      expect(handler).toHaveBeenCalledOnce();
      const tasks = scheduler.listTasks();
      expect(tasks[0]!.lastResult).toBe("success");
      expect(tasks[0]!.lastDurationMs).toBeGreaterThanOrEqual(0);
      expect(tasks[0]!.lastRun).toBeInstanceOf(Date);
    });

    it("retries once on failure before alerting", async () => {
      let callCount = 0;
      const handler = vi.fn(async () => {
        callCount++;
        if (callCount <= 2) throw new Error("Task boom");
      });

      scheduler.registerTask({
        name: "retry.task",
        cronExpression: "*/5 * * * *",
        handler,
      });

      await scheduler.executeTask("retry.task");

      // Should be called 2 times (1 attempt + 1 retry)
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it("publishes alert.system.task_failed after all retries exhausted", async () => {
      const handler = vi.fn(async () => {
        throw new Error("Permanent failure");
      });

      scheduler.registerTask({
        name: "fail.task",
        cronExpression: "*/5 * * * *",
        handler,
      });

      await scheduler.executeTask("fail.task");

      const failedAlerts = eventBus.publishedEvents.filter(
        (e) => e.eventType === "alert.system.task_failed"
      );
      expect(failedAlerts).toHaveLength(1);
      expect(failedAlerts[0]!.payload.taskName).toBe("fail.task");
      expect(failedAlerts[0]!.severity).toBe("high");

      const tasks = scheduler.listTasks();
      expect(tasks[0]!.lastResult).toBe("failure");
    });

    it("skips disabled tasks", async () => {
      const handler = vi.fn(async () => {});
      scheduler.registerTask({
        name: "disabled.task",
        cronExpression: "*/5 * * * *",
        handler,
        enabled: false,
      });

      await scheduler.executeTask("disabled.task");

      expect(handler).not.toHaveBeenCalled();
    });

    it("logs warning for unknown task", async () => {
      await scheduler.executeTask("nonexistent.task");
      expect(logger.warn).toHaveBeenCalled();
    });

    it("records duration on success", async () => {
      const handler = vi.fn(async () => {
        // Simulate some work
      });

      scheduler.registerTask({
        name: "timed.task",
        cronExpression: "*/5 * * * *",
        handler,
      });

      await scheduler.executeTask("timed.task");

      const tasks = scheduler.listTasks();
      expect(tasks[0]!.lastDurationMs).toBeDefined();
      expect(typeof tasks[0]!.lastDurationMs).toBe("number");
    });
  });

  describe("toggleTask", () => {
    it("disables an enabled task", () => {
      scheduler.registerTask({
        name: "toggle.task",
        cronExpression: "*/5 * * * *",
        handler: async () => {},
      });

      const result = scheduler.toggleTask("toggle.task", false);
      expect(result).toEqual({ previous: true, current: false });

      const tasks = scheduler.listTasks();
      expect(tasks[0]!.enabled).toBe(false);
      expect(tasks[0]!.nextRun).toBeNull();
    });

    it("enables a disabled task", () => {
      scheduler.registerTask({
        name: "toggle.task",
        cronExpression: "*/5 * * * *",
        handler: async () => {},
        enabled: false,
      });

      const result = scheduler.toggleTask("toggle.task", true);
      expect(result).toEqual({ previous: false, current: true });

      const tasks = scheduler.listTasks();
      expect(tasks[0]!.enabled).toBe(true);
    });

    it("returns null for nonexistent task", () => {
      const result = scheduler.toggleTask("nonexistent", true);
      expect(result).toBeNull();
    });
  });

  describe("getClientFor", () => {
    it("returns a client that auto-prefixes task names", () => {
      const client = scheduler.getClientFor("email");
      client.registerTask({
        name: "poll",
        cronExpression: "*/5 * * * *",
        handler: async () => {},
        description: "Poll emails",
      });

      const tasks = scheduler.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.name).toBe("email.poll");
    });

    it("client removeTask also prefixes", () => {
      const client = scheduler.getClientFor("unifi");
      client.registerTask({
        name: "poll",
        cronExpression: "*/5 * * * *",
        handler: async () => {},
      });

      expect(scheduler.listTasks()).toHaveLength(1);

      client.removeTask("poll");

      expect(scheduler.listTasks()).toHaveLength(0);
    });
  });

  describe("removeTask", () => {
    it("removes a registered task", () => {
      scheduler.registerTask({
        name: "removable",
        cronExpression: "*/5 * * * *",
        handler: async () => {},
      });

      expect(scheduler.listTasks()).toHaveLength(1);
      scheduler.removeTask("removable");
      expect(scheduler.listTasks()).toHaveLength(0);
    });
  });

  describe("shutdown", () => {
    it("stops all tasks and clears the list", () => {
      scheduler.registerTask({
        name: "task1",
        cronExpression: "*/5 * * * *",
        handler: async () => {},
      });
      scheduler.registerTask({
        name: "task2",
        cronExpression: "*/10 * * * *",
        handler: async () => {},
      });

      expect(scheduler.listTasks()).toHaveLength(2);
      scheduler.shutdown();
      expect(scheduler.listTasks()).toHaveLength(0);
    });
  });

  describe("listTasks", () => {
    it("returns metadata for all tasks", () => {
      scheduler.registerTask({
        name: "task.a",
        cronExpression: "*/5 * * * *",
        handler: async () => {},
        description: "Task A",
      });
      scheduler.registerTask({
        name: "task.b",
        cronExpression: "0 * * * *",
        handler: async () => {},
        description: "Task B",
        enabled: false,
      });

      const tasks = scheduler.listTasks();
      expect(tasks).toHaveLength(2);

      const taskA = tasks.find((t) => t.name === "task.a");
      const taskB = tasks.find((t) => t.name === "task.b");

      expect(taskA!.enabled).toBe(true);
      expect(taskA!.nextRun).toBeInstanceOf(Date);
      expect(taskB!.enabled).toBe(false);
      expect(taskB!.nextRun).toBeNull();
    });
  });
});
