import { describe, it, expect, vi } from "vitest";
import { InProcessEventBus } from "../../../src/core/events.js";
import type { CodaEvent } from "../../../src/core/events.js";
import { createMockLogger } from "../../helpers/mocks.js";

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

describe("InProcessEventBus", () => {
  it("dispatches event to matching subscriber", async () => {
    const bus = new InProcessEventBus(createMockLogger());
    const handler = vi.fn(async () => {});

    bus.subscribe("alert.test.event", handler);
    await bus.publish(createEvent());

    expect(handler).toHaveBeenCalledOnce();
  });

  it("pattern matches with wildcard (alert.*)", async () => {
    const bus = new InProcessEventBus(createMockLogger());
    const handler = vi.fn(async () => {});

    bus.subscribe("alert.*", handler);
    await bus.publish(createEvent({ eventType: "alert.test.event" }));
    await bus.publish(createEvent({ eventType: "alert.email.urgent" }));

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("does not dispatch to non-matching subscribers", async () => {
    const bus = new InProcessEventBus(createMockLogger());
    const handler = vi.fn(async () => {});

    bus.subscribe("alert.email.*", handler);
    await bus.publish(createEvent({ eventType: "alert.unifi.new_client" }));

    expect(handler).not.toHaveBeenCalled();
  });

  it("events with no matching subscriber are silently dropped", async () => {
    const bus = new InProcessEventBus(createMockLogger());
    // No subscribers registered — should not throw
    await expect(bus.publish(createEvent())).resolves.toBeUndefined();
  });

  it("multiple subscribers for the same pattern all receive the event", async () => {
    const bus = new InProcessEventBus(createMockLogger());
    const handler1 = vi.fn(async () => {});
    const handler2 = vi.fn(async () => {});

    bus.subscribe("alert.*", handler1);
    bus.subscribe("alert.*", handler2);
    await bus.publish(createEvent());

    expect(handler1).toHaveBeenCalledOnce();
    expect(handler2).toHaveBeenCalledOnce();
  });

  it("handler errors are caught and logged, not propagated", async () => {
    const logger = createMockLogger();
    const bus = new InProcessEventBus(logger);

    bus.subscribe("alert.*", async () => {
      throw new Error("Handler boom");
    });

    // Should not throw
    await expect(bus.publish(createEvent())).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });
});
