import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ReminderSkill } from "../../../../src/skills/reminders/skill.js";
import {
  createMockSkillContext,
  createMockEventBus,
} from "../../../helpers/mocks.js";
import type { SkillContext } from "../../../../src/skills/context.js";

// Mock DB
const mockReturning = vi.fn();
const mockLimit = vi.fn();
const mockOrderBy = vi.fn();
const mockWhere = vi.fn();
const mockFrom = vi.fn();
const mockSelect = vi.fn();
const mockInsert = vi.fn();
const mockValues = vi.fn();
const mockDelete = vi.fn();
const mockUpdate = vi.fn();
const mockSet = vi.fn();

const mockDb = {
  select: mockSelect,
  insert: mockInsert,
  delete: mockDelete,
  update: mockUpdate,
};

vi.mock("../../../../src/db/connection.js", () => ({
  getDatabase: () => mockDb,
}));

function setupSelectChain(results: unknown[]) {
  mockLimit.mockResolvedValue(results);
  // orderBy can be terminal (returns thenable) or chained (.limit())
  const orderByResult = Object.assign(Promise.resolve(results), { limit: mockLimit });
  mockOrderBy.mockReturnValue(orderByResult);
  mockWhere.mockReturnValue({ orderBy: mockOrderBy, limit: mockLimit });
  mockFrom.mockReturnValue({ where: mockWhere, orderBy: mockOrderBy });
  mockSelect.mockReturnValue({ from: mockFrom });
}

function setupInsertChain(results: unknown[]) {
  mockReturning.mockResolvedValue(results);
  mockValues.mockReturnValue({ returning: mockReturning });
  mockInsert.mockReturnValue({ values: mockValues });
}

function setupUpdateChain(results: unknown[]) {
  mockReturning.mockResolvedValue(results);
  mockWhere.mockReturnValue({ returning: mockReturning });
  mockSet.mockReturnValue({ where: mockWhere });
  mockUpdate.mockReturnValue({ set: mockSet });
}

describe("ReminderSkill", () => {
  let skill: ReminderSkill;
  let ctx: SkillContext;
  let eventBus: ReturnType<typeof createMockEventBus>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-15T10:00:00.000Z"));

    skill = new ReminderSkill();
    eventBus = createMockEventBus();
    ctx = {
      ...createMockSkillContext("reminders"),
      eventBus,
      config: { timezone: "UTC", check_interval_seconds: 60 },
    };
  });

  afterEach(async () => {
    await skill.shutdown();
    vi.useRealTimers();
  });

  it("has correct metadata", () => {
    expect(skill.name).toBe("reminders");
    expect(skill.getRequiredConfig()).toEqual([]);
  });

  it("registers 4 tools", () => {
    const tools = skill.getTools();
    expect(tools).toHaveLength(4);
    expect(tools.map((t) => t.name)).toEqual([
      "reminder_create",
      "reminder_list",
      "reminder_complete",
      "reminder_snooze",
    ]);
  });

  describe("after startup", () => {
    beforeEach(async () => {
      await skill.startup(ctx);
    });

    describe("reminder_create", () => {
      it("creates a reminder with parsed time", async () => {
        const dueDate = new Date("2025-01-15T12:00:00.000Z");
        setupInsertChain([{ id: "rem-1", dueAt: dueDate }]);

        const result = await skill.execute("reminder_create", {
          title: "Call dentist",
          time: "in 2 hours",
        });

        const parsed = JSON.parse(result);
        expect(parsed.success).toBe(true);
        expect(parsed.title).toBe("Call dentist");
        expect(parsed.parsedTime).toContain("2 hour");
        expect(parsed.isRecurring).toBe(false);
      });

      it("creates a recurring reminder", async () => {
        const dueDate = new Date("2025-01-20T09:00:00.000Z");
        setupInsertChain([{ id: "rem-2", dueAt: dueDate }]);

        const result = await skill.execute("reminder_create", {
          title: "Weekly standup",
          time: "every Monday at 9am",
        });

        const parsed = JSON.parse(result);
        expect(parsed.success).toBe(true);
        expect(parsed.isRecurring).toBe(true);
      });

      it("returns error for unparseable time", async () => {
        const result = await skill.execute("reminder_create", {
          title: "Something",
          time: "when pigs fly",
        });

        const parsed = JSON.parse(result);
        expect(parsed.success).toBe(false);
        expect(parsed.message).toContain("Could not parse time");
      });
    });

    describe("reminder_list", () => {
      it("lists pending reminders", async () => {
        setupSelectChain([
          {
            id: "rem-1",
            title: "Call dentist",
            description: null,
            dueAt: new Date("2025-01-15T14:00:00Z"),
            recurring: null,
            status: "pending",
            snoozedUntil: null,
            createdAt: new Date("2025-01-15T10:00:00Z"),
          },
        ]);

        const result = await skill.execute("reminder_list", {});

        const parsed = JSON.parse(result);
        expect(parsed.count).toBe(1);
        expect(parsed.results[0].title).toBe("Call dentist");
      });

      it("returns empty message when no reminders", async () => {
        setupSelectChain([]);

        const result = await skill.execute("reminder_list", { status: "pending" });

        const parsed = JSON.parse(result);
        expect(parsed.results).toEqual([]);
        expect(parsed.message).toContain("No pending reminders");
      });
    });

    describe("reminder_complete", () => {
      it("marks reminder as completed", async () => {
        // First select to find existing
        mockSelect.mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([
              {
                id: "rem-1",
                title: "Call dentist",
                recurring: null,
                description: null,
                userId: "default",
              },
            ]),
          }),
        });

        // Then update
        setupUpdateChain([{ id: "rem-1" }]);

        const result = await skill.execute("reminder_complete", { id: "rem-1" });

        const parsed = JSON.parse(result);
        expect(parsed.success).toBe(true);
        expect(parsed.message).toContain("completed");
      });

      it("returns error when reminder not found", async () => {
        mockSelect.mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]),
          }),
        });

        const result = await skill.execute("reminder_complete", {
          id: "nonexistent",
        });

        const parsed = JSON.parse(result);
        expect(parsed.success).toBe(false);
        expect(parsed.message).toContain("not found");
      });
    });

    describe("reminder_snooze", () => {
      it("snoozes a reminder", async () => {
        const snoozedDate = new Date("2025-01-15T10:15:00.000Z");
        setupUpdateChain([{ id: "rem-1", title: "Call dentist" }]);

        const result = await skill.execute("reminder_snooze", {
          id: "rem-1",
          until: "in 15 minutes",
        });

        const parsed = JSON.parse(result);
        expect(parsed.success).toBe(true);
        expect(parsed.message).toContain("snoozed");
      });

      it("returns error for unparseable snooze time", async () => {
        const result = await skill.execute("reminder_snooze", {
          id: "rem-1",
          until: "whenever",
        });

        const parsed = JSON.parse(result);
        expect(parsed.success).toBe(false);
        expect(parsed.message).toContain("Could not parse");
      });

      it("returns error when reminder not found", async () => {
        setupUpdateChain([]);

        const result = await skill.execute("reminder_snooze", {
          id: "nonexistent",
          until: "in 15 minutes",
        });

        const parsed = JSON.parse(result);
        expect(parsed.success).toBe(false);
        expect(parsed.message).toContain("not found");
      });
    });

    describe("background checker", () => {
      it("publishes alert for overdue reminders", async () => {
        const pastDue = new Date("2025-01-15T09:00:00.000Z");
        setupSelectChain([
          {
            id: "rem-1",
            userId: "default",
            title: "Overdue task",
            description: "This is overdue",
            dueAt: pastDue,
            recurring: null,
            status: "pending",
            snoozedUntil: null,
          },
        ]);

        await skill.checkDueReminders();

        expect(eventBus.publishedEvents).toHaveLength(1);
        expect(eventBus.publishedEvents[0]!.eventType).toBe(
          "alert.reminder.due"
        );
        expect(eventBus.publishedEvents[0]!.payload.title).toBe(
          "Overdue task"
        );
      });

      it("skips snoozed reminders", async () => {
        const futureSnoozed = new Date("2025-01-15T11:00:00.000Z");
        setupSelectChain([
          {
            id: "rem-1",
            userId: "default",
            title: "Snoozed",
            description: null,
            dueAt: new Date("2025-01-15T09:00:00.000Z"),
            recurring: null,
            status: "pending",
            snoozedUntil: futureSnoozed,
          },
        ]);

        await skill.checkDueReminders();

        expect(eventBus.publishedEvents).toHaveLength(0);
      });

      it("skips already-notified reminders", async () => {
        setupSelectChain([
          {
            id: "rem-1",
            userId: "default",
            title: "Already notified",
            description: null,
            dueAt: new Date("2025-01-15T09:00:00.000Z"),
            recurring: null,
            status: "pending",
            snoozedUntil: null,
          },
        ]);

        // Pre-set the notified key
        await ctx.redis.set("reminder:notified:rem-1", "1");

        await skill.checkDueReminders();

        expect(eventBus.publishedEvents).toHaveLength(0);
      });
    });

    it("returns unknown tool message for invalid tool name", async () => {
      const result = await skill.execute("reminder_invalid", {});
      expect(result).toContain("Unknown tool");
    });
  });
});
