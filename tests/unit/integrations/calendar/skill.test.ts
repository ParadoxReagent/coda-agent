import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CalendarSkill } from "../../../../src/integrations/calendar/skill.js";
import { createMockSkillContext } from "../../../helpers/mocks.js";
import type { CalendarEvent } from "../../../../src/integrations/calendar/caldav-client.js";
import type { SkillContext } from "../../../../src/skills/context.js";

// Mock CalDAV client
const mockConnect = vi.fn();
const mockDisconnect = vi.fn();
const mockGetEvents = vi.fn();
const mockCreateEvent = vi.fn();
const mockSearchEvents = vi.fn();

vi.mock("../../../../src/integrations/calendar/caldav-client.js", () => ({
  CalDAVClientWrapper: vi.fn().mockImplementation(() => ({
    connect: mockConnect,
    disconnect: mockDisconnect,
    getEvents: mockGetEvents,
    createEvent: mockCreateEvent,
    searchEvents: mockSearchEvents,
  })),
}));

function createTestEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: "event-1",
    title: "Team Meeting",
    startTime: new Date("2025-01-15T14:00:00Z"),
    endTime: new Date("2025-01-15T15:00:00Z"),
    location: "Conference Room A",
    description: "Weekly sync",
    attendees: ["alice@example.com"],
    allDay: false,
    ...overrides,
  };
}

describe("CalendarSkill", () => {
  let skill: CalendarSkill;
  let ctx: SkillContext;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-15T10:00:00.000Z"));

    skill = new CalendarSkill();
    ctx = {
      ...createMockSkillContext("calendar"),
      config: {
        caldav_server_url: "https://caldav.example.com",
        caldav_username: "user",
        caldav_password: "pass",
        timezone: "UTC",
      },
    };
  });

  afterEach(async () => {
    await skill.shutdown();
    vi.useRealTimers();
  });

  it("has correct metadata", () => {
    expect(skill.name).toBe("calendar");
    expect(skill.getRequiredConfig()).toEqual(["caldav"]);
  });

  it("registers 4 tools", () => {
    const tools = skill.getTools();
    expect(tools).toHaveLength(4);
    expect(tools.map((t) => t.name)).toEqual([
      "calendar_today",
      "calendar_upcoming",
      "calendar_create",
      "calendar_search",
    ]);
  });

  it("calendar_create requires confirmation", () => {
    const createTool = skill.getTools().find((t) => t.name === "calendar_create");
    expect(createTool?.requiresConfirmation).toBe(true);
  });

  describe("after startup", () => {
    beforeEach(async () => {
      await skill.startup(ctx);
    });

    it("connects CalDAV on startup", () => {
      expect(mockConnect).toHaveBeenCalled();
    });

    describe("calendar_today", () => {
      it("returns today's events", async () => {
        mockGetEvents.mockResolvedValue([createTestEvent()]);

        const result = await skill.execute("calendar_today", {});

        const parsed = JSON.parse(result);
        expect(parsed.count).toBe(1);
        expect(parsed.events[0].title).toBe("Team Meeting");
        expect(parsed.events[0].location).toBe("Conference Room A");
      });

      it("returns empty message when no events", async () => {
        mockGetEvents.mockResolvedValue([]);

        const result = await skill.execute("calendar_today", {});

        const parsed = JSON.parse(result);
        expect(parsed.events).toEqual([]);
        expect(parsed.message).toContain("No events");
      });
    });

    describe("calendar_upcoming", () => {
      it("returns upcoming events grouped by date", async () => {
        mockGetEvents.mockResolvedValue([
          createTestEvent({ startTime: new Date("2025-01-15T14:00:00Z") }),
          createTestEvent({
            id: "event-2",
            title: "Lunch",
            startTime: new Date("2025-01-16T12:00:00Z"),
            endTime: new Date("2025-01-16T13:00:00Z"),
          }),
        ]);

        const result = await skill.execute("calendar_upcoming", { days: 7 });

        const parsed = JSON.parse(result);
        expect(parsed.totalCount).toBe(2);
        expect(parsed.days).toBe(7);
        expect(parsed.eventsByDate).toBeDefined();
      });

      it("uses default 7 days when no argument", async () => {
        mockGetEvents.mockResolvedValue([]);

        const result = await skill.execute("calendar_upcoming", {});

        const parsed = JSON.parse(result);
        expect(parsed.message).toContain("No events");
      });
    });

    describe("calendar_create", () => {
      it("creates an event", async () => {
        mockGetEvents.mockResolvedValue([]);
        mockCreateEvent.mockResolvedValue("new-uid-1");

        const result = await skill.execute("calendar_create", {
          title: "New Meeting",
          start_time: "2025-01-16T10:00:00Z",
          end_time: "2025-01-16T11:00:00Z",
          location: "Room B",
        });

        const parsed = JSON.parse(result);
        expect(parsed.success).toBe(true);
        expect(parsed.id).toBe("new-uid-1");
        expect(parsed.title).toBe("New Meeting");
        expect(parsed.conflictWarning).toBeNull();
      });

      it("warns about conflicts", async () => {
        mockGetEvents.mockResolvedValue([
          createTestEvent({
            title: "Existing Meeting",
            startTime: new Date("2025-01-16T10:00:00Z"),
            endTime: new Date("2025-01-16T11:00:00Z"),
          }),
        ]);
        mockCreateEvent.mockResolvedValue("new-uid-2");

        const result = await skill.execute("calendar_create", {
          title: "Conflicting Meeting",
          start_time: "2025-01-16T10:30:00Z",
          end_time: "2025-01-16T11:30:00Z",
        });

        const parsed = JSON.parse(result);
        expect(parsed.success).toBe(true);
        expect(parsed.conflictWarning).toContain("Existing Meeting");
      });
    });

    describe("calendar_search", () => {
      it("returns matching events", async () => {
        mockSearchEvents.mockResolvedValue([createTestEvent()]);

        const result = await skill.execute("calendar_search", {
          query: "Team",
        });

        const parsed = JSON.parse(result);
        expect(parsed.count).toBe(1);
        expect(parsed.results[0].title).toBe("Team Meeting");
      });

      it("returns empty when no matches", async () => {
        mockSearchEvents.mockResolvedValue([]);

        const result = await skill.execute("calendar_search", {
          query: "nonexistent",
        });

        const parsed = JSON.parse(result);
        expect(parsed.results).toEqual([]);
        expect(parsed.message).toContain("No events matching");
      });

      it("passes date range to search", async () => {
        mockSearchEvents.mockResolvedValue([]);

        await skill.execute("calendar_search", {
          query: "meeting",
          from: "2025-01-01T00:00:00Z",
          to: "2025-01-31T23:59:59Z",
        });

        expect(mockSearchEvents).toHaveBeenCalledWith(
          "meeting",
          expect.any(Date),
          expect.any(Date)
        );
      });
    });

    it("disconnects CalDAV on shutdown", async () => {
      await skill.shutdown();
      expect(mockDisconnect).toHaveBeenCalled();
    });

    it("returns unknown tool message for invalid tool", async () => {
      const result = await skill.execute("calendar_invalid", {});
      expect(result).toContain("Unknown tool");
    });
  });
});
