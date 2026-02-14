/**
 * Utility for executing async operations with timeout, retries,
 * and transient error classification.
 */
import type { Logger } from "../utils/logger.js";
import { ErrorClassifier } from "./doctor/error-classifier.js";

export interface ExecutionOptions {
  timeout: number;
  retries: number;
}

const defaultClassifier = new ErrorClassifier();

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

        if (attempt < options.retries && defaultClassifier.classify(lastError).retryable) {
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

  /** @deprecated Use ErrorClassifier.classify() instead. */
  static isTransient(error: Error): boolean {
    return defaultClassifier.classify(error).retryable;
  }
}
