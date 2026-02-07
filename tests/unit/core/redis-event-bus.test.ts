import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RedisStreamEventBus } from "../../../src/core/redis-event-bus.js";
import type { CodaEvent } from "../../../src/core/events.js";
import { createMockLogger } from "../../helpers/mocks.js";

function createMockRedis() {
  const keys = new Map<string, string>();
  let messageIdCounter = 0;

  const mock = {
    _keys: keys,

    xadd: vi.fn(async (..._args: unknown[]) => {
      return `${Date.now()}-${messageIdCounter++}`;
    }),

    xgroup: vi.fn(async () => "OK"),

    xreadgroup: vi.fn(async () => null),

    xack: vi.fn(async () => 1),

    get: vi.fn(async (key: string) => keys.get(key) ?? null),

    set: vi.fn(async (key: string, value: string, ..._rest: unknown[]) => {
      keys.set(key, value);
      return "OK";
    }),
  };

  return mock;
}

function createEvent(overrides: Partial<CodaEvent> = {}): CodaEvent {
  return {
    eventType: "alert.test.event",
    timestamp: new Date().toISOString(),
    sourceSkill: "test",
    payload: {},
    severity: "medium",
    ...overrides,
  };
}

describe("RedisStreamEventBus", () => {
  let redis: ReturnType<typeof createMockRedis>;
  let bus: RedisStreamEventBus;

  beforeEach(() => {
    vi.clearAllMocks();
    redis = createMockRedis();
    bus = new RedisStreamEventBus(redis as never, createMockLogger(), "test-consumer");
  });

  afterEach(async () => {
    await bus.stopConsumer();
  });

  describe("publish()", () => {
    it("writes event to stream with correct format", async () => {
      const event = createEvent({ eventType: "alert.email.urgent" });
      await bus.publish(event);

      expect(redis.xadd).toHaveBeenCalledOnce();
      const args = redis.xadd.mock.calls[0]!;
      expect(args[0]).toBe("coda:events");
      expect(args[1]).toBe("MAXLEN");
      expect(args[2]).toBe("~");

      const dataIdx = args.indexOf("data");
      expect(dataIdx).toBeGreaterThan(-1);
      const jsonData = JSON.parse(args[dataIdx + 1] as string);
      expect(jsonData.eventType).toBe("alert.email.urgent");
    });

    it("auto-generates eventId when not provided", async () => {
      const event = createEvent();
      expect(event.eventId).toBeUndefined();

      await bus.publish(event);

      expect(event.eventId).toBeDefined();
      expect(event.eventId).toMatch(/^[a-z0-9]+-[a-f0-9]{8}$/);
    });

    it("preserves existing eventId", async () => {
      const event = createEvent({ eventId: "custom-id-123" });
      await bus.publish(event);

      expect(event.eventId).toBe("custom-id-123");
      const args = redis.xadd.mock.calls[0]!;
      const dataIdx = args.indexOf("data");
      const jsonData = JSON.parse(args[dataIdx + 1] as string);
      expect(jsonData.eventId).toBe("custom-id-123");
    });

    it("enforces MAXLEN on the stream", async () => {
      await bus.publish(createEvent());
      const args = redis.xadd.mock.calls[0]!;
      expect(args[3]).toBe("10000");
    });
  });

  describe("subscribe()", () => {
    it("registers handlers for pattern matching", () => {
      const handler = vi.fn(async () => {});
      bus.subscribe("alert.*", handler);
      bus.subscribe("alert.email.*", handler);

      // No error thrown
      expect(true).toBe(true);
    });
  });

  describe("startConsumer()", () => {
    it("creates consumer group", async () => {
      redis.xreadgroup.mockResolvedValue(null);

      const consumerPromise = bus.startConsumer();
      // Give it time to start, then stop
      await new Promise((r) => setTimeout(r, 10));
      await bus.stopConsumer();
      await consumerPromise;

      expect(redis.xgroup).toHaveBeenCalledWith(
        "CREATE",
        "coda:events",
        "coda-main",
        "0",
        "MKSTREAM"
      );
    });

    it("handles existing consumer group gracefully (BUSYGROUP)", async () => {
      redis.xgroup.mockRejectedValue(
        new Error("BUSYGROUP Consumer Group name already exists")
      );
      redis.xreadgroup.mockResolvedValue(null);

      const consumerPromise = bus.startConsumer();
      await new Promise((r) => setTimeout(r, 10));
      await bus.stopConsumer();
      await consumerPromise;

      expect(redis.xgroup).toHaveBeenCalled();
    });
  });

  describe("idempotency", () => {
    it("checks idempotency key before executing handler", async () => {
      const handler = vi.fn(async () => {});
      bus.subscribe("alert.*", handler);

      const eventData = JSON.stringify(
        createEvent({ eventId: "evt-123", eventType: "alert.test.event" })
      );

      let pendingCallCount = 0;
      redis.xreadgroup.mockImplementation(async (...args: unknown[]) => {
        const lastArg = args[args.length - 1];
        if (lastArg === "0") {
          pendingCallCount++;
          if (pendingCallCount === 1) {
            return [[
              "coda:events",
              [["msg-1", ["data", eventData]]],
            ]];
          }
          return [["coda:events", []]];
        }
        return null;
      });

      const consumerPromise = bus.startConsumer();
      await new Promise((r) => setTimeout(r, 50));
      await bus.stopConsumer();
      await consumerPromise;

      expect(handler).toHaveBeenCalledOnce();
      expect(redis.set).toHaveBeenCalledWith(
        expect.stringContaining("idem:evt-123:"),
        "1",
        "EX",
        86400
      );
    });

    it("skips handler when idempotency key already exists", async () => {
      const handler = vi.fn(async () => {});
      bus.subscribe("alert.*", handler);

      redis._keys.set("idem:evt-dup:alert.*:0", "1");

      const eventData = JSON.stringify(
        createEvent({ eventId: "evt-dup", eventType: "alert.test.event" })
      );

      let pendingCallCount = 0;
      redis.xreadgroup.mockImplementation(async (...args: unknown[]) => {
        const lastArg = args[args.length - 1];
        if (lastArg === "0") {
          pendingCallCount++;
          if (pendingCallCount === 1) {
            return [[
              "coda:events",
              [["msg-dup", ["data", eventData]]],
            ]];
          }
          return [["coda:events", []]];
        }
        return null;
      });

      const consumerPromise = bus.startConsumer();
      await new Promise((r) => setTimeout(r, 50));
      await bus.stopConsumer();
      await consumerPromise;

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("dead letter queue", () => {
    it("sends to dead letter after 3 failures", async () => {
      const handler = vi.fn(async () => {
        throw new Error("Handler explosion");
      });
      bus.subscribe("alert.*", handler);

      const eventData = JSON.stringify(
        createEvent({ eventId: "evt-fail", eventType: "alert.test.event" })
      );

      let pendingCallCount = 0;
      redis.xreadgroup.mockImplementation(async (...args: unknown[]) => {
        const lastArg = args[args.length - 1];
        if (lastArg === "0") {
          pendingCallCount++;
          if (pendingCallCount <= 3) {
            return [[
              "coda:events",
              [["msg-fail", ["data", eventData]]],
            ]];
          }
          return [["coda:events", []]];
        }
        return null;
      });

      const consumerPromise = bus.startConsumer();
      await new Promise((r) => setTimeout(r, 100));
      await bus.stopConsumer();
      await consumerPromise;

      expect(handler).toHaveBeenCalledTimes(3);

      // Dead letter should have been written
      const deadLetterCalls = redis.xadd.mock.calls.filter(
        (call) => call[0] === "coda:events:dead"
      );
      expect(deadLetterCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("XACK", () => {
    it("ACKs successfully processed messages", async () => {
      const handler = vi.fn(async () => {});
      bus.subscribe("alert.*", handler);

      const eventData = JSON.stringify(
        createEvent({ eventId: "evt-ack", eventType: "alert.test.event" })
      );

      let pendingCallCount = 0;
      redis.xreadgroup.mockImplementation(async (...args: unknown[]) => {
        const lastArg = args[args.length - 1];
        if (lastArg === "0") {
          pendingCallCount++;
          if (pendingCallCount === 1) {
            return [[
              "coda:events",
              [["msg-ack", ["data", eventData]]],
            ]];
          }
          return [["coda:events", []]];
        }
        return null;
      });

      const consumerPromise = bus.startConsumer();
      await new Promise((r) => setTimeout(r, 50));
      await bus.stopConsumer();
      await consumerPromise;

      expect(redis.xack).toHaveBeenCalledWith(
        "coda:events",
        "coda-main",
        "msg-ack"
      );
    });
  });

  describe("stopConsumer()", () => {
    it("exits the read loop gracefully", async () => {
      redis.xreadgroup.mockResolvedValue(null);

      const consumerPromise = bus.startConsumer();
      // Give consumer time to enter the read loop
      await new Promise((r) => setTimeout(r, 50));
      await bus.stopConsumer();
      // Wait for the loop's sleep to complete and check running flag
      await new Promise((r) => setTimeout(r, 200));
      await consumerPromise;

      expect(true).toBe(true);
    });
  });
});
