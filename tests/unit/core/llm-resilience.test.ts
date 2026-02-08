import { describe, it, expect, vi, beforeEach } from "vitest";
import { CircuitBreaker } from "../../../src/core/llm/circuit-breaker.js";
import { ResilientLLMProvider } from "../../../src/core/llm/resilient-provider.js";
import { createMockLogger, createMockProvider, createMockEventBus } from "../../helpers/mocks.js";
import type { LLMProvider, LLMChatParams } from "../../../src/core/llm/provider.js";

describe("CircuitBreaker", () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker({
      failureThreshold: 3,
      resetTimeoutMs: 100,
    });
  });

  it("starts in closed state", () => {
    expect(breaker.getState()).toBe("closed");
    expect(breaker.canExecute()).toBe(true);
  });

  it("stays closed after fewer failures than threshold", () => {
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe("closed");
    expect(breaker.canExecute()).toBe(true);
  });

  it("opens after reaching failure threshold", () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe("open");
    expect(breaker.canExecute()).toBe(false);
  });

  it("transitions to half-open after reset timeout", async () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.canExecute()).toBe(false);

    await new Promise((r) => setTimeout(r, 150));

    expect(breaker.getState()).toBe("half-open");
    expect(breaker.canExecute()).toBe(true);
  });

  it("returns to closed on success in half-open state", async () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();

    await new Promise((r) => setTimeout(r, 150));
    expect(breaker.canExecute()).toBe(true);

    breaker.recordSuccess();
    expect(breaker.getState()).toBe("closed");
  });

  it("returns to open on failure in half-open state", async () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();

    await new Promise((r) => setTimeout(r, 150));
    breaker.canExecute(); // trigger state transition to half-open

    breaker.recordFailure();
    expect(breaker.getState()).toBe("open");
  });

  it("resets failure count on success", () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess();
    breaker.recordFailure();
    // Only 1 consecutive failure now, not 3
    expect(breaker.getState()).toBe("closed");
  });
});

describe("ResilientLLMProvider", () => {
  const logger = createMockLogger();
  let breaker: CircuitBreaker;
  let eventBus: ReturnType<typeof createMockEventBus>;
  const defaultParams: LLMChatParams = {
    model: "test-model",
    system: "test",
    messages: [{ role: "user", content: "hello" }],
    maxTokens: 100,
  };

  beforeEach(() => {
    breaker = new CircuitBreaker({ failureThreshold: 5, resetTimeoutMs: 100 });
    eventBus = createMockEventBus();
  });

  it("passes through successful calls", async () => {
    const mock = createMockProvider({ name: "test" });
    const resilient = new ResilientLLMProvider(mock, breaker, logger, eventBus);
    const result = await resilient.chat(defaultParams);
    expect(result.text).toBe("Mock response");
  });

  it("retries on 429 with exponential backoff", async () => {
    const mock = createMockProvider({ name: "test" });
    mock.chatMock
      .mockRejectedValueOnce(new Error("429 Too Many Requests"))
      .mockRejectedValueOnce(new Error("429 Too Many Requests"));

    const resilient = new ResilientLLMProvider(mock, breaker, logger, eventBus);
    const result = await resilient.chat(defaultParams);
    expect(result.text).toBe("Mock response");
    expect(mock.chatMock).toHaveBeenCalledTimes(3);
  });

  it("retries on 500 error", async () => {
    const mock = createMockProvider({ name: "test" });
    mock.chatMock
      .mockRejectedValueOnce(new Error("500 Internal Server Error"));

    const resilient = new ResilientLLMProvider(mock, breaker, logger, eventBus);
    const result = await resilient.chat(defaultParams);
    expect(result.text).toBe("Mock response");
    expect(mock.chatMock).toHaveBeenCalledTimes(2);
  });

  it("retries on 503 error", async () => {
    const mock = createMockProvider({ name: "test" });
    mock.chatMock
      .mockRejectedValueOnce(new Error("503 Service Unavailable"));

    const resilient = new ResilientLLMProvider(mock, breaker, logger, eventBus);
    const result = await resilient.chat(defaultParams);
    expect(result.text).toBe("Mock response");
  });

  it("records success to circuit breaker", async () => {
    const mock = createMockProvider({ name: "test" });
    const resilient = new ResilientLLMProvider(mock, breaker, logger, eventBus);
    await resilient.chat(defaultParams);
    expect(breaker.getState()).toBe("closed");
  });

  it("records failure to circuit breaker after all retries exhausted", async () => {
    const mock = createMockProvider({ name: "test" });
    mock.chatMock.mockRejectedValue(new Error("503 Service Unavailable"));

    const resilient = new ResilientLLMProvider(mock, breaker, logger, eventBus);
    await expect(resilient.chat(defaultParams)).rejects.toThrow("503");
    // One failure recorded
    expect(breaker.getState()).toBe("closed"); // not yet at threshold
  });

  it("opens circuit breaker after threshold failures", async () => {
    const mock = createMockProvider({ name: "test" });
    mock.chatMock.mockRejectedValue(new Error("503 Service Unavailable"));

    const resilient = new ResilientLLMProvider(mock, breaker, logger, eventBus);

    for (let i = 0; i < 5; i++) {
      await resilient.chat(defaultParams).catch(() => {});
    }

    expect(breaker.getState()).toBe("open");
  });

  it("publishes alert when circuit breaker opens", async () => {
    const mock = createMockProvider({ name: "test" });
    mock.chatMock.mockRejectedValue(new Error("503 Service Unavailable"));

    const resilient = new ResilientLLMProvider(mock, breaker, logger, eventBus);

    for (let i = 0; i < 5; i++) {
      await resilient.chat(defaultParams).catch(() => {});
    }

    const alertEvents = eventBus.publishedEvents.filter(
      (e) => e.eventType === "alert.system.llm_failure"
    );
    expect(alertEvents.length).toBeGreaterThan(0);
    expect(alertEvents[0]!.payload.provider).toBe("test");
  });

  it("throws when circuit breaker is open", async () => {
    const mock = createMockProvider({ name: "test" });
    mock.chatMock.mockRejectedValue(new Error("503 Service Unavailable"));

    const resilient = new ResilientLLMProvider(mock, breaker, logger, eventBus);

    // Open the circuit
    for (let i = 0; i < 5; i++) {
      await resilient.chat(defaultParams).catch(() => {});
    }

    // Next call should fail immediately
    await expect(resilient.chat(defaultParams)).rejects.toThrow(
      "circuit breaker is open"
    );
  });

  it("allows probe after reset timeout", async () => {
    const mock = createMockProvider({ name: "test" });
    const error = new Error("503 Service Unavailable");
    mock.chatMock.mockRejectedValue(error);

    const resilient = new ResilientLLMProvider(mock, breaker, logger, eventBus);

    for (let i = 0; i < 5; i++) {
      await resilient.chat(defaultParams).catch(() => {});
    }

    // Wait for reset timeout
    await new Promise((r) => setTimeout(r, 150));

    // Reset mock to succeed
    mock.chatMock.mockResolvedValue({
      text: "recovered",
      toolCalls: [],
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 5 },
      model: "test",
      provider: "test",
    });

    const result = await resilient.chat(defaultParams);
    expect(result.text).toBe("recovered");
    expect(breaker.getState()).toBe("closed");
  });

  it("preserves provider name and capabilities", () => {
    const mock = createMockProvider({ name: "anthropic" });
    const resilient = new ResilientLLMProvider(mock, breaker, logger, eventBus);
    expect(resilient.name).toBe("anthropic");
    expect(resilient.capabilities.tools).toBe(true);
  });
});
