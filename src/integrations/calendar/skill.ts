import {
  CalDAVClientWrapper,
  type CalendarEvent,
} from "./caldav-client.js";
import type { Skill, SkillToolDefinition } from "../../skills/base.js";
import type { SkillContext } from "../../skills/context.js";
import type { Logger } from "../../utils/logger.js";
import { ContentSanitizer } from "../../core/sanitizer.js";

const DEFAULT_TIMEZONE = "America/New_York";

export class CalendarSkill implements Skill {
  readonly name = "calendar";
  readonly description =
    "View today's schedule, upcoming events, create new events, and search your calendar";
  readonly kind = "integration" as const;

  private logger!: Logger;
  private caldav!: CalDAVClientWrapper;
  private timezone = DEFAULT_TIMEZONE;

  getTools(): SkillToolDefinition[] {
    return [
      {
        name: "calendar_today",
        description: "Get today's calendar events.",
        input_schema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "calendar_upcoming",
        description: "Get upcoming calendar events for the next N days.",
        input_schema: {
          type: "object",
          properties: {
            days: {
              type: "number",
              description: "Number of days to look ahead (default 7)",
            },
          },
        },
      },
      {
        name: "calendar_create",
        description:
          "Create a new calendar event. Checks for conflicts with existing events.",
        input_schema: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description: "Event title",
            },
            start_time: {
              type: "string",
              description: "Start time in ISO 8601 format",
            },
            end_time: {
              type: "string",
              description: "End time in ISO 8601 format",
            },
            location: {
              type: "string",
              description: "Optional event location",
            },
            description: {
              type: "string",
              description: "Optional event description",
            },
          },
          required: ["title", "start_time", "end_time"],
        },
        requiresConfirmation: true,
        mainAgentOnly: true,
      },
      {
        name: "calendar_search",
        description:
          "Search calendar events by keyword, with optional date range.",
        input_schema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search keyword",
            },
            from: {
              type: "string",
              description: "Optional start date (ISO 8601)",
            },
            to: {
              type: "string",
              description: "Optional end date (ISO 8601)",
            },
          },
          required: ["query"],
        },
      },
    ];
  }

  async execute(
    toolName: string,
    toolInput: Record<string, unknown>
  ): Promise<string> {
    switch (toolName) {
      case "calendar_today":
        return this.getToday();
      case "calendar_upcoming":
        return this.getUpcoming(toolInput);
      case "calendar_create":
        return this.createEvent(toolInput);
      case "calendar_search":
        return this.searchEvents(toolInput);
      default:
        return `Unknown tool: ${toolName}`;
    }
  }

  getRequiredConfig(): string[] {
    return ["caldav"];
  }

  async startup(ctx: SkillContext): Promise<void> {
    this.logger = ctx.logger;

    const configTz = ctx.config.timezone as string | undefined;
    if (configTz) {
      this.timezone = configTz;
    }

    this.caldav = new CalDAVClientWrapper({
      serverUrl: ctx.config.caldav_server_url as string,
      username: ctx.config.caldav_username as string,
      password: ctx.config.caldav_password as string,
      defaultCalendar: ctx.config.default_calendar as string | undefined,
    });

    await this.caldav.connect();
    this.logger.info("Calendar skill started — CalDAV connected");
  }

  async shutdown(): Promise<void> {
    if (this.caldav) {
      await this.caldav.disconnect();
    }
    this.logger?.info("Calendar skill stopped");
  }

  private async getToday(): Promise<string> {
    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(now);
    endOfDay.setHours(23, 59, 59, 999);

    const events = await this.caldav.getEvents(startOfDay, endOfDay);

    if (events.length === 0) {
      return JSON.stringify({
        events: [],
        message: "No events scheduled for today.",
      });
    }

    return JSON.stringify({
      date: now.toISOString().split("T")[0],
      timezone: this.timezone,
      events: events.map(formatEvent),
      count: events.length,
    });
  }

  private async getUpcoming(
    input: Record<string, unknown>
  ): Promise<string> {
    const days = (input.days as number | undefined) ?? 7;
    const now = new Date();
    const end = new Date(now.getTime() + days * 24 * 3600_000);

    const events = await this.caldav.getEvents(now, end);

    if (events.length === 0) {
      return JSON.stringify({
        events: [],
        message: `No events in the next ${days} days.`,
      });
    }

    // Group events by date
    const grouped: Record<string, ReturnType<typeof formatEvent>[]> = {};
    for (const event of events) {
      const dateKey = event.startTime.toISOString().split("T")[0]!;
      if (!grouped[dateKey]) {
        grouped[dateKey] = [];
      }
      grouped[dateKey]!.push(formatEvent(event));
    }

    return JSON.stringify({
      days,
      eventsByDate: grouped,
      totalCount: events.length,
    });
  }

  private async createEvent(
    input: Record<string, unknown>
  ): Promise<string> {
    const title = input.title as string;
    const startTime = new Date(input.start_time as string);
    const endTime = new Date(input.end_time as string);
    const location = input.location as string | undefined;
    const description = input.description as string | undefined;

    // Check for conflicts
    const existing = await this.caldav.getEvents(startTime, endTime);
    const conflicts = existing.filter(
      (e) =>
        e.startTime < endTime && e.endTime > startTime
    );

    let conflictWarning: string | null = null;
    if (conflicts.length > 0) {
      conflictWarning = `Warning: ${conflicts.length} conflicting event(s): ${conflicts
        .map((c) => c.title)
        .join(", ")}`;
    }

    const uid = await this.caldav.createEvent({
      title,
      startTime,
      endTime,
      location,
      description,
    });

    return JSON.stringify({
      success: true,
      id: uid,
      title,
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      conflictWarning,
      message: `Event "${title}" created${conflictWarning ? ` (${conflictWarning})` : ""}`,
    });
  }

  private async searchEvents(
    input: Record<string, unknown>
  ): Promise<string> {
    const query = input.query as string;
    const from = input.from ? new Date(input.from as string) : undefined;
    const to = input.to ? new Date(input.to as string) : undefined;

    const events = await this.caldav.searchEvents(query, from, to);

    if (events.length === 0) {
      return JSON.stringify({
        results: [],
        message: `No events matching "${query}"`,
      });
    }

    return JSON.stringify({
      results: events.map(formatEvent),
      count: events.length,
    });
  }
}

function formatEvent(event: CalendarEvent) {
  const sanitized = ContentSanitizer.sanitizeCalendarEvent(
    event.title,
    event.description ?? undefined
  );
  return {
    id: event.id,
    title: sanitized.title,
    startTime: event.startTime.toISOString(),
    endTime: event.endTime.toISOString(),
    location: event.location ?? null,
    description: sanitized.description,
    attendees: event.attendees,
    allDay: event.allDay,
  };
}
