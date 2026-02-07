import { describe, it, expect, beforeEach, vi } from "vitest";
import { UsageTracker } from "../../../../src/core/llm/usage.js";
import { createMockLogger } from "../../../helpers/mocks.js";

describe("UsageTracker", () => {
  let tracker: UsageTracker;

  beforeEach(() => {
    tracker = new UsageTracker(
      {
        "mock-model": { input: 3.0, output: 15.0 },
        "gpt-4o": { input: 2.5, output: 10.0 },
      },
      10.0,
      createMockLogger()
    );
  });

  it("trackUsage stores token counts per provider/model", async () => {
    await tracker.track("anthropic", "mock-model", {
      inputTokens: 100,
      outputTokens: 50,
    });

    const usage = tracker.getDailyUsage();
    expect(usage).toHaveLength(1);
    expect(usage[0]!.totalInputTokens).toBe(100);
    expect(usage[0]!.totalOutputTokens).toBe(50);
    expect(usage[0]!.requestCount).toBe(1);
  });

  it("trackUsage handles null token values", async () => {
    await tracker.track("ollama", "llama3.1:8b", {
      inputTokens: null,
      outputTokens: null,
    });

    const usage = tracker.getDailyUsage();
    expect(usage).toHaveLength(1);
    expect(usage[0]!.usageTracked).toBe(false);
    expect(usage[0]!.totalInputTokens).toBe(0);
  });

  it("getDailyUsage aggregates today's tokens by provider", async () => {
    await tracker.track("anthropic", "mock-model", {
      inputTokens: 100,
      outputTokens: 50,
    });
    await tracker.track("anthropic", "mock-model", {
      inputTokens: 200,
      outputTokens: 100,
    });

    const usage = tracker.getDailyUsage();
    expect(usage).toHaveLength(1);
    expect(usage[0]!.totalInputTokens).toBe(300);
    expect(usage[0]!.totalOutputTokens).toBe(150);
    expect(usage[0]!.requestCount).toBe(2);
  });

  it("getDailyUsage shows usage not tracked for providers with null usage", async () => {
    await tracker.track("ollama", "llama3.1:8b", {
      inputTokens: null,
      outputTokens: null,
    });

    const usage = tracker.getDailyUsage();
    expect(usage[0]!.usageTracked).toBe(false);
  });

  it("getEstimatedCost calculates cost from token counts and rates", async () => {
    await tracker.track("anthropic", "mock-model", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });

    const cost = tracker.getTodayTotalCost();
    expect(cost).toBe(18.0); // 3.0 input + 15.0 output
  });

  it("getEstimatedCost skips providers with null usage data", async () => {
    await tracker.track("ollama", "llama3.1:8b", {
      inputTokens: null,
      outputTokens: null,
    });

    const cost = tracker.getTodayTotalCost();
    expect(cost).toBeNull();
  });

  it("handles missing cost configuration gracefully", async () => {
    await tracker.track("unknown", "unknown-model", {
      inputTokens: 100,
      outputTokens: 50,
    });

    const usage = tracker.getDailyUsage();
    expect(usage[0]!.estimatedCost).toBeNull();
  });

  it("daily spend alert fires when threshold exceeded", async () => {
    const logger = createMockLogger();
    const alertTracker = new UsageTracker(
      { "mock-model": { input: 3.0, output: 15.0 } },
      0.01, // Very low threshold
      logger
    );

    await alertTracker.track("anthropic", "mock-model", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ dailyCost: expect.any(Number) }),
      expect.stringContaining("threshold exceeded")
    );
  });
});
