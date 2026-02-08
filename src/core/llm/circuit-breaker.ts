/**
 * Circuit breaker pattern for LLM providers.
 * Prevents cascading failures by temporarily disabling a failing provider.
 *
 * States: closed (normal) → open (failing) → half-open (probe)
 */

export type CircuitState = "closed" | "open" | "half-open";

interface CircuitBreakerConfig {
  failureThreshold: number;
  resetTimeoutMs: number;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  resetTimeoutMs: 60_000,
};

export class CircuitBreaker {
  private state: CircuitState = "closed";
  private failures = 0;
  private lastFailureTime: number | null = null;
  private config: CircuitBreakerConfig;

  constructor(config?: Partial<CircuitBreakerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  canExecute(): boolean {
    switch (this.state) {
      case "closed":
        return true;

      case "open": {
        // Check if reset timeout has elapsed
        if (this.lastFailureTime !== null) {
          const elapsed = Date.now() - this.lastFailureTime;
          if (elapsed >= this.config.resetTimeoutMs) {
            this.state = "half-open";
            return true;
          }
        }
        return false;
      }

      case "half-open":
        return true;
    }
  }

  recordSuccess(): void {
    this.failures = 0;
    this.state = "closed";
  }

  recordFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();

    if (this.state === "half-open") {
      // Probe failed — go back to open
      this.state = "open";
      return;
    }

    if (this.failures >= this.config.failureThreshold) {
      this.state = "open";
    }
  }

  getState(): CircuitState {
    // Sync state if reset timeout has passed
    if (this.state === "open" && this.lastFailureTime !== null) {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed >= this.config.resetTimeoutMs) {
        this.state = "half-open";
      }
    }
    return this.state;
  }
}
