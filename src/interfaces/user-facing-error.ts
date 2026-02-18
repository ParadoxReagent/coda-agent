/**
 * Convert internal errors into concise, safe user-facing messages.
 * Avoids exposing stack traces, file paths, tokens, or raw provider payloads.
 */
export function formatUserFacingError(err: unknown): string {
  const statusCode = extractStatusCode(err);
  const msg = extractMessage(err).toLowerCase();

  const isBudgetError =
    statusCode === 402 ||
    msg.includes("requires more credits") ||
    msg.includes("fewer max_tokens") ||
    msg.includes("can only afford") ||
    msg.includes("insufficient credits");

  if (isBudgetError) {
    return "I couldn't complete that because the AI provider rejected this turn's token budget. Please try again with a shorter request.";
  }

  if (statusCode === 429 || msg.includes("rate limit") || msg.includes("too many requests")) {
    return "I hit a provider rate limit. Please try again in about a minute.";
  }

  if (
    statusCode === 401 ||
    msg.includes("unauthorized") ||
    msg.includes("authentication") ||
    msg.includes("invalid api key")
  ) {
    return "I couldn't authenticate with the AI provider. Please check the provider API key configuration.";
  }

  if (
    msg.includes("all llm providers are currently unavailable") ||
    msg.includes("circuit breaker is open") ||
    msg.includes("service unavailable") ||
    msg.includes("overloaded") ||
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("econnreset") ||
    msg.includes("enotfound") ||
    msg.includes("econnrefused")
  ) {
    return "I'm having trouble reaching the AI provider right now. Please try again in a moment.";
  }

  if (
    msg.includes("context length") ||
    msg.includes("maximum context") ||
    msg.includes("token budget exceeded")
  ) {
    return "I couldn't complete that due to model context limits. Please shorten the request or split it into smaller steps.";
  }

  return "Sorry, I encountered an error processing your message. Please try again.";
}

function extractStatusCode(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const anyErr = err as Record<string, unknown>;

  if (typeof anyErr.status === "number") return anyErr.status;
  if (typeof anyErr.statusCode === "number") return anyErr.statusCode;
  if (typeof anyErr.code === "number") return anyErr.code;
  if (anyErr.response && typeof (anyErr.response as Record<string, unknown>).status === "number") {
    return (anyErr.response as Record<string, unknown>).status as number;
  }
  if (anyErr.error && typeof (anyErr.error as Record<string, unknown>).code === "number") {
    return (anyErr.error as Record<string, unknown>).code as number;
  }
  return null;
}

function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (!err || typeof err !== "object") return String(err ?? "");

  const anyErr = err as Record<string, unknown>;
  if (typeof anyErr.message === "string") return anyErr.message;
  if (anyErr.error && typeof (anyErr.error as Record<string, unknown>).message === "string") {
    return (anyErr.error as Record<string, unknown>).message as string;
  }
  return String(err);
}
