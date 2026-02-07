import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AlertRouter } from "../../../src/core/alerts.js";
import type { AlertSink } from "../../../src/core/alerts.js";
import type { CodaEvent } from "../../../src/core/events.js";
import { createMockLogger, createMockEventBus } from "../../helpers/mocks.js";

function createEvent(overrides: Partial<CodaEvent> = {}): CodaEvent {
  return {
    eventType: "alert.email.urgent",
    timestamp: new Date().toISOString(),
    sourceSkill: "email",
    payload: { from: "test@example.com", subject: "Test" },
    severity: "high",
    eventId: "evt-test-123",
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

describe("AlertRouter", () => {
  let logger: ReturnType<typeof createMockLogger>;
  let redis: ReturnType<typeof createMockRedis>;
  let db: ReturnType<typeof createMockDb>;
  let router: AlertRouter;
  let sink: ReturnType<typeof createMockSink>;

  beforeEach(() => {
    vi.clearAllMocks();
    logger = createMockLogger();
    redis = createMockRedis();
    db = createMockDb();
    sink = createMockSink();
  });

  describe("routing by event type", () => {
    it("routes alert to correct sink based on rules", async () => {
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
      router.registerSink("discord", sink);

      await router.routeAlert(createEvent());

      expect(sink.sendRich).toHaveBeenCalledOnce();
    });

    it("skips events with no matching rule", async () => {
      router = new AlertRouter(logger, redis as never, db as never, {
        rules: {},
      });
      router.registerSink("discord", sink);

      await router.routeAlert(createEvent({ eventType: "alert.unknown.type" }));

      expect(sink.send).not.toHaveBeenCalled();
      expect(sink.sendRich).not.toHaveBeenCalled();
    });

    it("routes to multiple channels", async () => {
      const slackSink = createMockSink();
      router = new AlertRouter(logger, redis as never, db as never, {
        rules: {
          "alert.email.urgent": {
            severity: "high",
            channels: ["discord", "slack"],
            quietHours: false,
            cooldown: 0,
          },
        },
      });
      router.registerSink("discord", sink);
      router.registerSink("slack", slackSink);

      await router.routeAlert(createEvent());

      expect(sink.sendRich).toHaveBeenCalledOnce();
      expect(slackSink.send).toHaveBeenCalledOnce();
    });
  });

  describe("quiet hours", () => {
    it("suppresses medium-severity during quiet hours", async () => {
      // Use a quiet hours config where we know current time falls inside
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

      // Set quiet hours to include current time
      const startHour = Math.floor(
        ((startMinutes - 30 + 1440) % 1440) / 60
      );
      const endHour = Math.floor(
        ((startMinutes + 30) % 1440) / 60
      );
      const startMin = (startMinutes - 30 + 1440) % 60;
      const endMin = (startMinutes + 30) % 60;

      router = new AlertRouter(logger, redis as never, db as never, {
        rules: {
          "alert.reminder.due": {
            severity: "medium",
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
      router.registerSink("discord", sink);

      await router.routeAlert(
        createEvent({
          eventType: "alert.reminder.due",
          severity: "medium",
        })
      );

      expect(sink.send).not.toHaveBeenCalled();
      expect(sink.sendRich).not.toHaveBeenCalled();
    });

    it("high-severity bypasses quiet hours", async () => {
      // Same as above but with high severity
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

      router = new AlertRouter(logger, redis as never, db as never, {
        rules: {
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
      router.registerSink("discord", sink);

      await router.routeAlert(
        createEvent({
          eventType: "alert.email.urgent",
          severity: "high",
        })
      );

      expect(sink.sendRich).toHaveBeenCalledOnce();
    });

    it("does not suppress when quiet hours are disabled", async () => {
      router = new AlertRouter(logger, redis as never, db as never, {
        rules: {
          "alert.reminder.due": {
            severity: "medium",
            channels: ["discord"],
            quietHours: true,
            cooldown: 0,
          },
        },
        quietHours: {
          enabled: false,
          start: "00:00",
          end: "23:59",
          timezone: "UTC",
          overrideSeverities: ["high"],
        },
      });
      router.registerSink("discord", sink);

      await router.routeAlert(
        createEvent({
          eventType: "alert.reminder.due",
          severity: "medium",
        })
      );

      expect(sink.sendRich).toHaveBeenCalledOnce();
    });
  });

  describe("cooldown", () => {
    it("suppresses duplicate alerts within cooldown window", async () => {
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
      router.registerSink("discord", sink);

      // First call should go through
      await router.routeAlert(createEvent());
      expect(sink.sendRich).toHaveBeenCalledOnce();

      // Second call should be suppressed (cooldown key set)
      await router.routeAlert(createEvent({ eventId: "evt-2" }));
      expect(sink.sendRich).toHaveBeenCalledOnce(); // Still just once
    });

    it("cooldown is scoped per event type + source", async () => {
      router = new AlertRouter(logger, redis as never, db as never, {
        rules: {
          "alert.email.urgent": {
            severity: "high",
            channels: ["discord"],
            quietHours: false,
            cooldown: 300,
          },
          "alert.reminder.due": {
            severity: "medium",
            channels: ["discord"],
            quietHours: false,
            cooldown: 300,
          },
        },
      });
      router.registerSink("discord", sink);

      // Email alert should go through
      await router.routeAlert(createEvent());

      // Reminder alert (different type) should also go through
      await router.routeAlert(
        createEvent({
          eventType: "alert.reminder.due",
          sourceSkill: "reminders",
          severity: "medium",
          eventId: "evt-2",
        })
      );

      expect(sink.sendRich).toHaveBeenCalledTimes(2);
    });

    it("no cooldown when cooldown is 0", async () => {
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
      router.registerSink("discord", sink);

      await router.routeAlert(createEvent());
      await router.routeAlert(createEvent({ eventId: "evt-2" }));

      expect(sink.sendRich).toHaveBeenCalledTimes(2);
    });
  });

  describe("alert history recording", () => {
    it("records delivered alert in history", async () => {
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
      router.registerSink("discord", sink);

      await router.routeAlert(createEvent());

      expect(db.insert).toHaveBeenCalled();
    });

    it("records suppressed alert with reason", async () => {
      // Create quiet hours that include now
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

      router = new AlertRouter(logger, redis as never, db as never, {
        rules: {
          "alert.reminder.due": {
            severity: "medium",
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
      router.registerSink("discord", sink);

      await router.routeAlert(
        createEvent({
          eventType: "alert.reminder.due",
          severity: "medium",
        })
      );

      // DB insert should have been called for the suppressed alert
      expect(db.insert).toHaveBeenCalled();
    });
  });

  describe("event bus integration", () => {
    it("subscribes to alert.* pattern on attach", () => {
      router = new AlertRouter(logger);
      const eventBus = createMockEventBus();
      router.attachToEventBus(eventBus);

      expect(eventBus.handlers.has("alert.*")).toBe(true);
    });
  });

  describe("setRules", () => {
    it("allows updating rules after construction", async () => {
      router = new AlertRouter(logger, redis as never, db as never);
      router.registerSink("discord", sink);

      // Initially no rules — alert should be skipped
      await router.routeAlert(createEvent());
      expect(sink.sendRich).not.toHaveBeenCalled();

      // Set rules
      router.setRules({
        "alert.email.urgent": {
          severity: "high",
          channels: ["discord"],
          quietHours: false,
          cooldown: 0,
        },
      });

      await router.routeAlert(createEvent({ eventId: "evt-2" }));
      expect(sink.sendRich).toHaveBeenCalledOnce();
    });
  });

  describe("unknown events", () => {
    it("handles unknown event types gracefully", async () => {
      router = new AlertRouter(logger, redis as never, db as never, {
        rules: {},
      });

      await router.routeAlert(
        createEvent({ eventType: "alert.unknown.thing" })
      );

      // Should not throw, just log debug
      expect(logger.debug).toHaveBeenCalled();
    });
  });
});
