/**
 * Utility for executing async operations with timeout, retries,
 * and transient error classification.
 */
import type { Logger } from "../utils/logger.js";

export interface ExecutionOptions {
  timeout: number;
  retries: number;
}

export class ResilientExecutor {
  static async execute<T>(
    fn: () => Promise<T>,
    options: ExecutionOptions,
    logger: Logger
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= options.retries; attempt++) {
      try {
        const result = await Promise.race([
          fn(),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("Tool execution timed out")),
              options.timeout
            )
          ),
        ]);
        return result;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        if (attempt < options.retries && this.isTransient(lastError)) {
          logger.debug(
            { attempt: attempt + 1, error: lastError.message },
            "Retrying after transient error"
          );
          continue;
        }

        break;
      }
    }

    throw lastError;
  }

  static isTransient(error: Error): boolean {
    const message = error.message.toLowerCase();
    const code = (error as NodeJS.ErrnoException).code;

    // Network errors
    if (code === "ECONNREFUSED") return true;
    if (code === "ETIMEDOUT") return true;
    if (code === "ENOTFOUND") return true;
    if (code === "ECONNRESET") return true;

    // HTTP status code errors
    if (message.includes("429")) return true;
    if (message.includes("500")) return true;
    if (message.includes("503")) return true;

    // Timeout
    if (message.includes("timeout")) return true;
    if (message.includes("timed out")) return true;

    return false;
  }
}
