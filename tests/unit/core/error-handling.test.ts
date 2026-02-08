import { describe, it, expect, vi, beforeEach } from "vitest";
import { SkillHealthTracker } from "../../../src/core/skill-health.js";
import { ResilientExecutor } from "../../../src/core/resilient-executor.js";
import { createMockLogger } from "../../helpers/mocks.js";

describe("SkillHealthTracker", () => {
  let tracker: SkillHealthTracker;

  beforeEach(() => {
    tracker = new SkillHealthTracker({
      degradedThreshold: 3,
      unavailableThreshold: 5,
      recoveryWindowMs: 100,
    });
  });

  it("starts healthy", () => {
    expect(tracker.getHealth("test").status).toBe("healthy");
    expect(tracker.isAvailable("test")).toBe(true);
  });

  it("records success and stays healthy", () => {
    tracker.recordSuccess("test");
    const health = tracker.getHealth("test");
    expect(health.status).toBe("healthy");
    expect(health.totalSuccesses).toBe(1);
  });

  it("degrades after threshold consecutive failures", () => {
    for (let i = 0; i < 3; i++) {
      tracker.recordFailure("test", new Error("fail"));
    }
    expect(tracker.getHealth("test").status).toBe("degraded");
    expect(tracker.isAvailable("test")).toBe(true);
  });

  it("becomes unavailable after unavailable threshold", () => {
    for (let i = 0; i < 5; i++) {
      tracker.recordFailure("test", new Error("fail"));
    }
    expect(tracker.getHealth("test").status).toBe("unavailable");
    expect(tracker.isAvailable("test")).toBe(false);
  });

  it("recovers to degraded after recovery window", async () => {
    for (let i = 0; i < 5; i++) {
      tracker.recordFailure("test", new Error("fail"));
    }
    expect(tracker.isAvailable("test")).toBe(false);

    // Wait for recovery window
    await new Promise((r) => setTimeout(r, 150));

    expect(tracker.isAvailable("test")).toBe(true);
    expect(tracker.getHealth("test").status).toBe("degraded");
  });

  it("resets to healthy on success after failure", () => {
    for (let i = 0; i < 3; i++) {
      tracker.recordFailure("test", new Error("fail"));
    }
    expect(tracker.getHealth("test").status).toBe("degraded");

    tracker.recordSuccess("test");
    expect(tracker.getHealth("test").status).toBe("healthy");
    expect(tracker.getHealth("test").consecutiveFailures).toBe(0);
  });

  it("tracks independent skills separately", () => {
    for (let i = 0; i < 5; i++) {
      tracker.recordFailure("email", new Error("fail"));
    }
    tracker.recordSuccess("calendar");

    expect(tracker.getHealth("email").status).toBe("unavailable");
    expect(tracker.getHealth("calendar").status).toBe("healthy");
  });

  it("getAllHealth returns all tracked skills", () => {
    tracker.recordSuccess("email");
    tracker.recordSuccess("calendar");
    tracker.recordFailure("notes", new Error("fail"));

    const all = tracker.getAllHealth();
    expect(all.size).toBe(3);
  });
});

describe("ResilientExecutor", () => {
  const logger = createMockLogger();

  it("executes successfully on first try", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await ResilientExecutor.execute(
      fn,
      { timeout: 1000, retries: 2 },
      logger
    );
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on transient error", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("503 Service Unavailable"))
      .mockResolvedValue("ok");

    const result = await ResilientExecutor.execute(
      fn,
      { timeout: 1000, retries: 2 },
      logger
    );
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry permanent errors", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("Invalid input"));
    await expect(
      ResilientExecutor.execute(fn, { timeout: 1000, retries: 2 }, logger)
    ).rejects.toThrow("Invalid input");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throws on timeout", async () => {
    const fn = vi.fn(
      () => new Promise((resolve) => setTimeout(resolve, 500))
    );
    await expect(
      ResilientExecutor.execute(fn, { timeout: 50, retries: 0 }, logger)
    ).rejects.toThrow("timed out");
  });

  describe("isTransient", () => {
    it("classifies ECONNREFUSED as transient", () => {
      const err = new Error("connect ECONNREFUSED") as NodeJS.ErrnoException;
      err.code = "ECONNREFUSED";
      expect(ResilientExecutor.isTransient(err)).toBe(true);
    });

    it("classifies 429 as transient", () => {
      expect(ResilientExecutor.isTransient(new Error("429 Too Many Requests"))).toBe(true);
    });

    it("classifies 500 as transient", () => {
      expect(ResilientExecutor.isTransient(new Error("500 Internal Server Error"))).toBe(true);
    });

    it("classifies 503 as transient", () => {
      expect(ResilientExecutor.isTransient(new Error("503 Service Unavailable"))).toBe(true);
    });

    it("classifies timeout as transient", () => {
      expect(ResilientExecutor.isTransient(new Error("timeout"))).toBe(true);
    });

    it("classifies other errors as non-transient", () => {
      expect(ResilientExecutor.isTransient(new Error("Invalid argument"))).toBe(false);
    });
  });
});
