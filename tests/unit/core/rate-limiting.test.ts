import { describe, it, expect, beforeEach, vi } from "vitest";
import { RateLimiter } from "../../../src/core/rate-limiter.js";
import { ConfirmationManager } from "../../../src/core/confirmation.js";
import { createMockLogger, createMockEventBus } from "../../helpers/mocks.js";

describe("RateLimiter (in-memory fallback)", () => {
  let limiter: RateLimiter;
  const logger = createMockLogger();

  beforeEach(() => {
    limiter = new RateLimiter(null, logger);
  });

  it("allows requests within limit", async () => {
    const config = { maxRequests: 5, windowSeconds: 60 };
    for (let i = 0; i < 5; i++) {
      const result = await limiter.check("test", "user1", config);
      expect(result.allowed).toBe(true);
    }
  });

  it("blocks requests exceeding limit", async () => {
    const config = { maxRequests: 3, windowSeconds: 60 };
    for (let i = 0; i < 3; i++) {
      await limiter.check("test", "user1", config);
    }
    const result = await limiter.check("test", "user1", config);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("returns remaining count", async () => {
    const config = { maxRequests: 5, windowSeconds: 60 };
    const r1 = await limiter.check("test", "user1", config);
    expect(r1.remaining).toBe(4);

    await limiter.check("test", "user1", config);
    const r3 = await limiter.check("test", "user1", config);
    expect(r3.remaining).toBe(2);
  });

  it("different scopes are independent", async () => {
    const config = { maxRequests: 2, windowSeconds: 60 };

    await limiter.check("email", "user1", config);
    await limiter.check("email", "user1", config);
    const emailResult = await limiter.check("email", "user1", config);
    expect(emailResult.allowed).toBe(false);

    const calendarResult = await limiter.check("calendar", "user1", config);
    expect(calendarResult.allowed).toBe(true);
  });

  it("different identifiers are independent", async () => {
    const config = { maxRequests: 2, windowSeconds: 60 };

    await limiter.check("test", "user1", config);
    await limiter.check("test", "user1", config);
    const r1 = await limiter.check("test", "user1", config);
    expect(r1.allowed).toBe(false);

    const r2 = await limiter.check("test", "user2", config);
    expect(r2.allowed).toBe(true);
  });

  it("rate limit returns user-friendly retryAfter", async () => {
    const config = { maxRequests: 1, windowSeconds: 60 };
    await limiter.check("test", "user1", config);
    const result = await limiter.check("test", "user1", config);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(result.retryAfterSeconds).toBeLessThanOrEqual(60);
  });
});

describe("ConfirmationManager — abuse detection", () => {
  let manager: ConfirmationManager;
  let eventBus: ReturnType<typeof createMockEventBus>;

  beforeEach(() => {
    eventBus = createMockEventBus();
    manager = new ConfirmationManager(createMockLogger(), eventBus);
  });

  it("allows valid confirmation", () => {
    const token = manager.createConfirmation(
      "user1", "test", "test_action", {}, "Test action"
    );
    const result = manager.consumeConfirmation(token, "user1");
    expect(result).not.toBeNull();
    expect(result?.toolName).toBe("test_action");
  });

  it("tracks invalid attempts", () => {
    for (let i = 0; i < 5; i++) {
      manager.consumeConfirmation("INVALIDTOKEN", "user1");
    }
    // Should still work (below threshold)
    const token = manager.createConfirmation(
      "user1", "test", "test_action", {}, "Test action"
    );
    expect(manager.consumeConfirmation(token, "user1")).not.toBeNull();
  });

  it("blocks after abuse threshold and publishes alert", () => {
    // Make 10 invalid attempts
    for (let i = 0; i < 10; i++) {
      manager.consumeConfirmation(`INVALID${i}TOKENPAD`, "user1");
    }

    // Now even a valid token should be blocked
    const token = manager.createConfirmation(
      "user1", "test", "test_action", {}, "Test action"
    );
    const result = manager.consumeConfirmation(token, "user1");
    expect(result).toBeNull();

    // Should have published abuse alert
    const abuseAlerts = eventBus.publishedEvents.filter(
      (e) => e.eventType === "alert.system.abuse"
    );
    expect(abuseAlerts.length).toBeGreaterThan(0);
  });

  it("different users are tracked independently", () => {
    for (let i = 0; i < 10; i++) {
      manager.consumeConfirmation(`INVALID${i}TOKENPAD`, "user1");
    }

    // user2 should still work
    const token = manager.createConfirmation(
      "user2", "test", "test_action", {}, "Test action"
    );
    expect(manager.consumeConfirmation(token, "user2")).not.toBeNull();
  });
});
