/**
 * Unified error taxonomy and classification.
 * Replaces scattered isTransient()/isRetryable() checks with a single classifier.
 */

export type ErrorCategory =
  | "transient"
  | "malformed_output"
  | "auth_expired"
  | "rate_limited"
  | "schema_violation"
  | "permanent"
  | "resource_exhausted"
  | "unknown";

export type ErrorStrategy =
  | "retry"
  | "retry_with_backoff"
  | "reprompt_with_error"
  | "refresh_and_retry"
  | "escalate"
  | "skip"
  | "none";

export interface ClassifiedError {
  category: ErrorCategory;
  strategy: ErrorStrategy;
  retryable: boolean;
  maxRetries: number;
  original: Error;
  context?: Record<string, unknown>;
}

export class ErrorClassifier {
  classify(error: unknown, context?: { source?: string }): ClassifiedError {
    const err = error instanceof Error ? error : new Error(String(error));
    const msg = err.message.toLowerCase();
    const code = (err as NodeJS.ErrnoException).code;
    const statusCode = this.extractStatusCode(err);

    // Rate limited
    if (statusCode === 429 || msg.includes("rate limit") || msg.includes("too many requests")) {
      return this.build(err, "rate_limited", "retry_with_backoff", true, 3, context);
    }

    // Auth expired
    if (
      statusCode === 401 ||
      msg.includes("token expired") ||
      msg.includes("invalid_grant") ||
      msg.includes("unauthorized") ||
      msg.includes("authentication")
    ) {
      return this.build(err, "auth_expired", "refresh_and_retry", false, 1, context);
    }

    // Malformed output
    if (
      err instanceof SyntaxError ||
      msg.includes("unexpected token") ||
      msg.includes("json.parse") ||
      msg.includes("unexpected end of json") ||
      msg.includes("not valid json")
    ) {
      return this.build(err, "malformed_output", "reprompt_with_error", false, 2, context);
    }

    // Resource exhausted
    if (
      msg.includes("max tool calls") ||
      msg.includes("token budget exceeded") ||
      msg.includes("context length exceeded") ||
      msg.includes("maximum context")
    ) {
      return this.build(err, "resource_exhausted", "escalate", false, 0, context);
    }

    // Transient network errors
    if (
      code === "ECONNRESET" ||
      code === "ETIMEDOUT" ||
      code === "ENOTFOUND" ||
      code === "ECONNREFUSED" ||
      code === "EPIPE" ||
      code === "EAI_AGAIN"
    ) {
      return this.build(err, "transient", "retry", true, 3, context);
    }

    // Transient HTTP errors
    if (statusCode === 500 || statusCode === 502 || statusCode === 503 || statusCode === 504) {
      return this.build(err, "transient", "retry_with_backoff", true, 3, context);
    }

    // Timeout
    if (msg.includes("timeout") || msg.includes("timed out")) {
      return this.build(err, "transient", "retry", true, 2, context);
    }

    // Overloaded
    if (msg.includes("overloaded") || msg.includes("capacity")) {
      return this.build(err, "transient", "retry_with_backoff", true, 3, context);
    }

    // Permanent errors
    if (statusCode === 400 || statusCode === 404 || statusCode === 405 || statusCode === 422) {
      return this.build(err, "permanent", "none", false, 0, context);
    }

    if (msg.includes("missing config") || msg.includes("not configured")) {
      return this.build(err, "permanent", "escalate", false, 0, context);
    }

    // Schema violation
    if (msg.includes("validation failed") || msg.includes("invalid input")) {
      return this.build(err, "schema_violation", "reprompt_with_error", false, 1, context);
    }

    return this.build(err, "unknown", "none", false, 0, context);
  }

  private build(
    original: Error,
    category: ErrorCategory,
    strategy: ErrorStrategy,
    retryable: boolean,
    maxRetries: number,
    context?: { source?: string }
  ): ClassifiedError {
    return {
      category,
      strategy,
      retryable,
      maxRetries,
      original,
      context: context ? { source: context.source } : undefined,
    };
  }

  private extractStatusCode(error: Error): number | null {
    // Check common patterns for HTTP status codes
    const statusMatch = error.message.match(/\b(4\d{2}|5\d{2})\b/);
    if (statusMatch) return parseInt(statusMatch[1]!, 10);

    // Check error properties (common in HTTP client libraries)
    const anyErr = error as unknown as Record<string, unknown>;
    if (typeof anyErr.status === "number") return anyErr.status;
    if (typeof anyErr.statusCode === "number") return anyErr.statusCode;
    if (anyErr.response && typeof (anyErr.response as Record<string, unknown>).status === "number") {
      return (anyErr.response as Record<string, unknown>).status as number;
    }

    return null;
  }
}
