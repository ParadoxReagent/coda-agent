import { describe, it, expect, vi, beforeEach } from "vitest";
import { InProcessEventBus } from "../../src/core/events.js";
import { AlertRouter } from "../../src/core/alerts.js";
import type { AlertSink } from "../../src/core/alerts.js";
import type { CodaEvent } from "../../src/core/events.js";
import { createMockLogger } from "../helpers/mocks.js";

function createEvent(overrides: Partial<CodaEvent> = {}): CodaEvent {
  return {
    eventType: "alert.email.urgent",
    timestamp: new Date().toISOString(),
    sourceSkill: "email",
    payload: { from: "ceo@company.com", subject: "Important" },
    severity: "high",
    eventId: `evt-${Math.random().toString(36).slice(2)}`,
    ...overrides,
  };
}

function createMockSink(): AlertSink & {
  sentMessages: Array<{ channel: string; message: string }>;
  sentRich: Array<{ channel: string; formatted: unknown }>;
} {
  const sentMessages: Array<{ channel: string; message: string }> = [];
  const sentRich: Array<{ channel: string; formatted: unknown }> = [];
  return {
    sentMessages,
    sentRich,
    send: vi.fn(async (channel: string, message: string) => {
      sentMessages.push({ channel, message });
    }),
    sendRich: vi.fn(async (channel: string, formatted: unknown) => {
      sentRich.push({ channel, formatted });
    }),
  };
}

function createMockRedis() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string, ..._args: unknown[]) => {
      store.set(key, value);
      return "OK";
    }),
    _store: store,
  };
}

function createMockDb() {
  const insertedRows: unknown[] = [];
  return {
    insert: vi.fn().mockReturnValue({
      values: vi.fn(async (row: unknown) => {
        insertedRows.push(row);
      }),
    }),
    _insertedRows: insertedRows,
  };
}

describe("Alert Pipeline Integration", () => {
  let logger: ReturnType<typeof createMockLogger>;
  let eventBus: InProcessEventBus;
  let redis: ReturnType<typeof createMockRedis>;
  let db: ReturnType<typeof createMockDb>;
  let router: AlertRouter;
  let discordSink: ReturnType<typeof createMockSink>;

  beforeEach(() => {
    vi.clearAllMocks();
    logger = createMockLogger();
    eventBus = new InProcessEventBus(logger);
    redis = createMockRedis();
    db = createMockDb();
    discordSink = createMockSink();
  });

  describe("end-to-end: publish → route → sink", () => {
    it("event published on bus reaches Discord sink", async () => {
      router = new AlertRouter(logger, redis as never, db as never, {
        rules: {
          "alert.email.urgent": {
            severity: "high",
            channels: ["discord"],
            quietHours: false,
            cooldown: 0,
          },
        },
      });
      router.registerSink("discord", discordSink);
      router.attachToEventBus(eventBus);

      await eventBus.publish(createEvent());

      expect(discordSink.sendRich).toHaveBeenCalledOnce();
      const formatted = discordSink.sentRich[0]!.formatted as {
        embeds: unknown[];
      };
      expect(formatted.embeds).toHaveLength(1);
    });

    it("reminder due event routes correctly", async () => {
      router = new AlertRouter(logger, redis as never, db as never, {
        rules: {
          "alert.reminder.due": {
            severity: "medium",
            channels: ["discord"],
            quietHours: false,
            cooldown: 0,
          },
        },
      });
      router.registerSink("discord", discordSink);
      router.attachToEventBus(eventBus);

      await eventBus.publish(
        createEvent({
          eventType: "alert.reminder.due",
          sourceSkill: "reminders",
          severity: "medium",
          payload: { title: "Call dentist", dueAt: "2025-01-15T14:00:00Z" },
        })
      );

      expect(discordSink.sendRich).toHaveBeenCalledOnce();
    });
  });

  describe("quiet hours suppression", () => {
    function createQuietHoursRouter() {
      // Create quiet hours that include the current time
      const now = new Date();
      const hourNow = now.toLocaleTimeString("en-US", {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "UTC",
      });
      const startMinutes =
        parseInt(hourNow.split(":")[0]!, 10) * 60 +
        parseInt(hourNow.split(":")[1]!, 10);

      const startHour = Math.floor(
        ((startMinutes - 30 + 1440) % 1440) / 60
      );
      const endHour = Math.floor(
        ((startMinutes + 30) % 1440) / 60
      );
      const startMin = (startMinutes - 30 + 1440) % 60;
      const endMin = (startMinutes + 30) % 60;

      return new AlertRouter(logger, redis as never, db as never, {
        rules: {
          "alert.reminder.due": {
            severity: "medium",
            channels: ["discord"],
            quietHours: true,
            cooldown: 0,
          },
          "alert.email.urgent": {
            severity: "high",
            channels: ["discord"],
            quietHours: true,
            cooldown: 0,
          },
        },
        quietHours: {
          enabled: true,
          start: `${String(startHour).padStart(2, "0")}:${String(startMin).padStart(2, "0")}`,
          end: `${String(endHour).padStart(2, "0")}:${String(endMin).padStart(2, "0")}`,
          timezone: "UTC",
          overrideSeverities: ["high"],
        },
      });
    }

    it("suppresses medium-severity during quiet hours", async () => {
      router = createQuietHoursRouter();
      router.registerSink("discord", discordSink);
      router.attachToEventBus(eventBus);

      await eventBus.publish(
        createEvent({
          eventType: "alert.reminder.due",
          severity: "medium",
          sourceSkill: "reminders",
        })
      );

      expect(discordSink.sendRich).not.toHaveBeenCalled();
      expect(discordSink.send).not.toHaveBeenCalled();
    });

    it("high-severity bypasses quiet hours", async () => {
      router = createQuietHoursRouter();
      router.registerSink("discord", discordSink);
      router.attachToEventBus(eventBus);

      await eventBus.publish(
        createEvent({
          eventType: "alert.email.urgent",
          severity: "high",
        })
      );

      expect(discordSink.sendRich).toHaveBeenCalledOnce();
    });
  });

  describe("cooldown prevention", () => {
    it("prevents rapid duplicate alerts", async () => {
      router = new AlertRouter(logger, redis as never, db as never, {
        rules: {
          "alert.email.urgent": {
            severity: "high",
            channels: ["discord"],
            quietHours: false,
            cooldown: 300,
          },
        },
      });
      router.registerSink("discord", discordSink);
      router.attachToEventBus(eventBus);

      // First event goes through
      await eventBus.publish(createEvent());
      expect(discordSink.sendRich).toHaveBeenCalledOnce();

      // Second rapid event is suppressed
      await eventBus.publish(createEvent());
      expect(discordSink.sendRich).toHaveBeenCalledOnce(); // Still just once
    });
  });

  describe("multiple event types", () => {
    it("routes different event types to correct rules", async () => {
      router = new AlertRouter(logger, redis as never, db as never, {
        rules: {
          "alert.email.urgent": {
            severity: "high",
            channels: ["discord"],
            quietHours: false,
            cooldown: 0,
          },
          "alert.reminder.due": {
            severity: "medium",
            channels: ["discord"],
            quietHours: false,
            cooldown: 0,
          },
        },
      });
      router.registerSink("discord", discordSink);
      router.attachToEventBus(eventBus);

      await eventBus.publish(createEvent({ eventType: "alert.email.urgent" }));
      await eventBus.publish(
        createEvent({
          eventType: "alert.reminder.due",
          sourceSkill: "reminders",
          severity: "medium",
        })
      );

      expect(discordSink.sendRich).toHaveBeenCalledTimes(2);
    });

    it("ignores event types without rules", async () => {
      router = new AlertRouter(logger, redis as never, db as never, {
        rules: {
          "alert.email.urgent": {
            severity: "high",
            channels: ["discord"],
            quietHours: false,
            cooldown: 0,
          },
        },
      });
      router.registerSink("discord", discordSink);
      router.attachToEventBus(eventBus);

      await eventBus.publish(
        createEvent({
          eventType: "alert.unifi.new_client",
          sourceSkill: "unifi",
          severity: "medium",
        })
      );

      expect(discordSink.sendRich).not.toHaveBeenCalled();
    });
  });

  describe("alert history", () => {
    it("records delivered alerts in database", async () => {
      router = new AlertRouter(logger, redis as never, db as never, {
        rules: {
          "alert.email.urgent": {
            severity: "high",
            channels: ["discord"],
            quietHours: false,
            cooldown: 0,
          },
        },
      });
      router.registerSink("discord", discordSink);
      router.attachToEventBus(eventBus);

      await eventBus.publish(createEvent());

      expect(db.insert).toHaveBeenCalled();
      expect(db._insertedRows.length).toBeGreaterThan(0);
    });
  });
});
