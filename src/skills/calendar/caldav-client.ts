import { createDAVClient, type DAVCalendar } from "tsdav";

type DAVClientInstance = Awaited<ReturnType<typeof createDAVClient>>;

export interface CalendarEvent {
  id: string;
  title: string;
  startTime: Date;
  endTime: Date;
  location?: string;
  description?: string;
  attendees: string[];
  allDay: boolean;
}

export interface CalDAVConfig {
  serverUrl: string;
  username: string;
  password: string;
  defaultCalendar?: string;
}

export class CalDAVClientWrapper {
  private client: DAVClientInstance | null = null;
  private calendars: DAVCalendar[] = [];
  private config: CalDAVConfig;

  constructor(config: CalDAVConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    this.client = await createDAVClient({
      serverUrl: this.config.serverUrl,
      credentials: {
        username: this.config.username,
        password: this.config.password,
      },
      authMethod: "Basic",
      defaultAccountType: "caldav",
    });

    this.calendars = await this.client.fetchCalendars();
  }

  async getEvents(from: Date, to: Date): Promise<CalendarEvent[]> {
    if (!this.client) throw new Error("CalDAV client not connected");

    const calendar = this.getTargetCalendar();
    if (!calendar) return [];

    const objects = await this.client.fetchCalendarObjects({
      calendar,
      timeRange: {
        start: from.toISOString(),
        end: to.toISOString(),
      },
    });

    return objects
      .map((obj) => this.parseCalendarObject(obj.data as string, obj.url))
      .filter((e): e is CalendarEvent => e !== null)
      .sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
  }

  async createEvent(event: {
    title: string;
    startTime: Date;
    endTime: Date;
    location?: string;
    description?: string;
  }): Promise<string> {
    if (!this.client) throw new Error("CalDAV client not connected");

    const calendar = this.getTargetCalendar();
    if (!calendar) throw new Error("No calendar found");

    const uid = crypto.randomUUID();
    const icsData = this.buildICS(uid, event);

    await this.client.createCalendarObject({
      calendar,
      filename: `${uid}.ics`,
      iCalString: icsData,
    });

    return uid;
  }

  async searchEvents(
    query: string,
    from?: Date,
    to?: Date
  ): Promise<CalendarEvent[]> {
    // CalDAV doesn't have native text search, so we fetch a range and filter
    const searchFrom =
      from ?? new Date(Date.now() - 30 * 24 * 3600_000); // 30 days back
    const searchTo =
      to ?? new Date(Date.now() + 90 * 24 * 3600_000); // 90 days forward

    const events = await this.getEvents(searchFrom, searchTo);
    const lowerQuery = query.toLowerCase();

    return events.filter(
      (e) =>
        e.title.toLowerCase().includes(lowerQuery) ||
        e.description?.toLowerCase().includes(lowerQuery) ||
        e.location?.toLowerCase().includes(lowerQuery)
    );
  }

  async disconnect(): Promise<void> {
    this.client = null;
    this.calendars = [];
  }

  private getTargetCalendar(): DAVCalendar | undefined {
    if (this.config.defaultCalendar) {
      return this.calendars.find(
        (c) =>
          c.displayName === this.config.defaultCalendar ||
          c.url.includes(this.config.defaultCalendar!)
      );
    }
    return this.calendars[0];
  }

  private parseCalendarObject(
    data: string,
    url: string
  ): CalendarEvent | null {
    try {
      const getField = (name: string): string | undefined => {
        const regex = new RegExp(`^${name}[;:](.*)$`, "m");
        const match = data.match(regex);
        return match?.[1]?.trim();
      };

      const summary = getField("SUMMARY") ?? "Untitled";
      const dtstart = getField("DTSTART");
      const dtend = getField("DTEND");
      const location = getField("LOCATION");
      const description = getField("DESCRIPTION");
      const uid = getField("UID") ?? url;

      if (!dtstart) return null;

      const allDay = !dtstart.includes("T");
      const startTime = this.parseICSDate(dtstart);
      const endTime = dtend
        ? this.parseICSDate(dtend)
        : new Date(startTime.getTime() + 3600_000);

      // Parse attendees
      const attendees: string[] = [];
      const attendeeRegex = /ATTENDEE[^:]*:mailto:([^\r\n]+)/gi;
      let attendeeMatch;
      while ((attendeeMatch = attendeeRegex.exec(data)) !== null) {
        attendees.push(attendeeMatch[1]!);
      }

      return {
        id: uid,
        title: summary,
        startTime,
        endTime,
        location: location || undefined,
        description: description || undefined,
        attendees,
        allDay,
      };
    } catch {
      return null;
    }
  }

  private parseICSDate(value: string): Date {
    // Handle VALUE=DATE:20250115 format
    const dateOnlyMatch = value.match(/(\d{4})(\d{2})(\d{2})$/);
    if (dateOnlyMatch) {
      return new Date(
        parseInt(dateOnlyMatch[1]!, 10),
        parseInt(dateOnlyMatch[2]!, 10) - 1,
        parseInt(dateOnlyMatch[3]!, 10)
      );
    }

    // Handle 20250115T100000Z format
    const dtMatch = value.match(
      /(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?/
    );
    if (dtMatch) {
      return new Date(
        Date.UTC(
          parseInt(dtMatch[1]!, 10),
          parseInt(dtMatch[2]!, 10) - 1,
          parseInt(dtMatch[3]!, 10),
          parseInt(dtMatch[4]!, 10),
          parseInt(dtMatch[5]!, 10),
          parseInt(dtMatch[6]!, 10)
        )
      );
    }

    return new Date(value);
  }

  private buildICS(
    uid: string,
    event: {
      title: string;
      startTime: Date;
      endTime: Date;
      location?: string;
      description?: string;
    }
  ): string {
    const formatDate = (d: Date): string =>
      d
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d{3}/, "");

    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//coda//EN",
      "BEGIN:VEVENT",
      `UID:${uid}`,
      `DTSTART:${formatDate(event.startTime)}`,
      `DTEND:${formatDate(event.endTime)}`,
      `SUMMARY:${event.title}`,
    ];

    if (event.location) lines.push(`LOCATION:${event.location}`);
    if (event.description) lines.push(`DESCRIPTION:${event.description}`);

    lines.push(
      `DTSTAMP:${formatDate(new Date())}`,
      "END:VEVENT",
      "END:VCALENDAR"
    );

    return lines.join("\r\n");
  }
}
