import type { CodaEvent, EventBus } from "./events.js";
import type { Logger } from "../utils/logger.js";

export interface AlertRule {
  severity: "high" | "medium" | "low";
  channels: ("discord" | "slack")[];
  quietHours: boolean;
  cooldown: number;
}

export interface AlertSink {
  send(channel: string, message: string): Promise<void>;
}

/**
 * Routes events to alert sinks based on configurable rules.
 * Phase 1: stub that logs alerts. Phase 3: full routing with quiet hours and cooldowns.
 */
export class AlertRouter {
  private rules: Record<string, AlertRule> = {};
  private logger: Logger;
  private sinks: Map<string, AlertSink> = new Map();

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /** Register alert routing rules. */
  setRules(rules: Record<string, AlertRule>): void {
    this.rules = rules;
  }

  /** Register an alert sink (e.g., Discord, Slack). */
  registerSink(channel: string, sink: AlertSink): void {
    this.sinks.set(channel, sink);
  }

  /** Subscribe to alert events on the event bus. */
  attachToEventBus(eventBus: EventBus): void {
    eventBus.subscribe("alert.*", async (event) => {
      await this.routeAlert(event);
    });
  }

  private async routeAlert(event: CodaEvent): Promise<void> {
    const rule = this.rules[event.eventType];

    if (!rule) {
      this.logger.debug(
        { eventType: event.eventType },
        "No alert rule for event, skipping"
      );
      return;
    }

    this.logger.info(
      {
        eventType: event.eventType,
        severity: event.severity,
        channels: rule.channels,
      },
      "Routing alert"
    );

    for (const channel of rule.channels) {
      const sink = this.sinks.get(channel);
      if (sink) {
        try {
          const message = this.formatAlert(event);
          await sink.send(channel, message);
        } catch (err) {
          this.logger.error(
            { channel, eventType: event.eventType, error: err },
            "Failed to send alert"
          );
        }
      }
    }
  }

  private formatAlert(event: CodaEvent): string {
    const severity =
      event.severity === "high"
        ? "[HIGH]"
        : event.severity === "medium"
          ? "[MEDIUM]"
          : "[LOW]";
    return `${severity} ${event.eventType}: ${JSON.stringify(event.payload)}`;
  }
}
