/**
 * Wraps an LLM provider with retry logic and circuit breaker integration.
 * Retries on transient errors (429, 500, 503) with exponential backoff.
 */
import type {
  LLMProvider,
  LLMChatParams,
  LLMResponse,
  ProviderCapabilities,
} from "./provider.js";
import type { CircuitBreaker } from "./circuit-breaker.js";
import type { Logger } from "../../utils/logger.js";
import type { EventBus } from "../events.js";

const RETRY_DELAYS = [100, 200, 400]; // ms

export class ResilientLLMProvider implements LLMProvider {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;

  constructor(
    private inner: LLMProvider,
    private circuitBreaker: CircuitBreaker,
    private logger: Logger,
    private eventBus?: EventBus
  ) {
    this.name = inner.name;
    this.capabilities = inner.capabilities;
  }

  async chat(params: LLMChatParams): Promise<LLMResponse> {
    if (!this.circuitBreaker.canExecute()) {
      throw new Error(
        `Provider "${this.name}" circuit breaker is open — provider temporarily unavailable`
      );
    }

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
      try {
        const response = await this.inner.chat(params);
        this.circuitBreaker.recordSuccess();
        return response;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        if (attempt < RETRY_DELAYS.length && this.isRetryable(lastError)) {
          const delay = RETRY_DELAYS[attempt]!;
          this.logger.debug(
            {
              provider: this.name,
              attempt: attempt + 1,
              delay,
              error: lastError.message,
            },
            "Retrying LLM request"
          );
          await this.sleep(delay);
          continue;
        }

        break;
      }
    }

    // All retries exhausted
    this.circuitBreaker.recordFailure();

    // If circuit breaker just opened, publish alert
    if (this.circuitBreaker.getState() === "open" && this.eventBus) {
      this.eventBus.publish({
        eventType: "alert.system.llm_failure",
        timestamp: new Date().toISOString(),
        sourceSkill: "system",
        payload: {
          provider: this.name,
          error: lastError?.message ?? "Unknown error",
        },
        severity: "high",
      }).catch((e) => {
        this.logger.error({ error: e }, "Failed to publish LLM failure alert");
      });
    }

    throw lastError;
  }

  private isRetryable(error: Error): boolean {
    const msg = error.message.toLowerCase();
    return (
      msg.includes("429") ||
      msg.includes("500") ||
      msg.includes("503") ||
      msg.includes("rate limit") ||
      msg.includes("overloaded") ||
      msg.includes("timeout")
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
