import type { Logger } from "../utils/logger.js";

export interface CodaEvent {
  eventType: string;
  timestamp: string;
  sourceSkill: string;
  payload: Record<string, unknown>;
  severity: "high" | "medium" | "low";
  eventId?: string;
}

export interface EventBus {
  publish(event: CodaEvent): Promise<void>;
  subscribe(
    pattern: string,
    handler: (event: CodaEvent) => Promise<void>
  ): void;
}

/**
 * Phase 1: In-process EventEmitter-based event bus.
 * Phase 3 replaces this with Redis Streams — same interface, new backend.
 */
export class InProcessEventBus implements EventBus {
  private subscriptions: Array<{
    pattern: RegExp;
    handler: (event: CodaEvent) => Promise<void>;
  }> = [];
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  async publish(event: CodaEvent): Promise<void> {
    this.logger.debug(
      { eventType: event.eventType, severity: event.severity },
      "Event published"
    );

    for (const sub of this.subscriptions) {
      if (sub.pattern.test(event.eventType)) {
        try {
          await sub.handler(event);
        } catch (err) {
          this.logger.error(
            { eventType: event.eventType, error: err },
            "Event handler error"
          );
        }
      }
    }
  }

  subscribe(
    pattern: string,
    handler: (event: CodaEvent) => Promise<void>
  ): void {
    // Convert glob-like pattern to regex: "alert.*" → /^alert\..*$/
    const regexStr = pattern
      .replace(/\./g, "\\.")
      .replace(/\*/g, ".*");
    const regex = new RegExp(`^${regexStr}$`);

    this.subscriptions.push({ pattern: regex, handler });
    this.logger.debug({ pattern }, "Event subscription registered");
  }
}
