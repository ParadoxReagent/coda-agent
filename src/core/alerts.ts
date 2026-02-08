import type { Redis } from "ioredis";
import type { CodaEvent, EventBus } from "./events.js";
import type { Logger } from "../utils/logger.js";
import type { Database } from "../db/index.js";
import { alertHistory } from "../db/schema.js";
import { generateEventId } from "../utils/id.js";
import {
  formatAlertPlainText,
  formatAlertForDiscord,
  formatAlertForSlack,
} from "./alert-formatters.js";
import type { PreferencesManager } from "./preferences.js";

export interface AlertRule {
  severity: "high" | "medium" | "low";
  channels: ("discord" | "slack")[];
  quietHours: boolean;
  cooldown: number;
}

export interface AlertSink {
  send(channel: string, message: string): Promise<void>;
  sendRich?(channel: string, formatted: unknown): Promise<void>;
}

export interface QuietHoursConfig {
  enabled: boolean;
  start: string;
  end: string;
  timezone: string;
  overrideSeverities: ("high" | "medium" | "low")[];
}

export interface AlertRouterConfig {
  rules: Record<string, AlertRule>;
  quietHours: QuietHoursConfig;
}

const DEFAULT_QUIET_HOURS: QuietHoursConfig = {
  enabled: false,
  start: "22:00",
  end: "07:00",
  timezone: "America/New_York",
  overrideSeverities: ["high"],
};

/**
 * Routes events to alert sinks based on configurable rules.
 * Supports quiet hours, per-type+source cooldowns, and alert history recording.
 */
export class AlertRouter {
  private rules: Record<string, AlertRule> = {};
  private logger: Logger;
  private sinks: Map<string, AlertSink> = new Map();
  private redis: Redis | null;
  private db: Database | null;
  private quietHours: QuietHoursConfig;
  private preferences: PreferencesManager | null;

  constructor(
    logger: Logger,
    redis?: Redis | null,
    db?: Database | null,
    config?: Partial<AlertRouterConfig>,
    preferences?: PreferencesManager
  ) {
    this.logger = logger;
    this.redis = redis ?? null;
    this.db = db ?? null;
    this.quietHours = config?.quietHours ?? DEFAULT_QUIET_HOURS;
    this.preferences = preferences ?? null;
    if (config?.rules) {
      this.rules = config.rules;
    }
  }

  setRules(rules: Record<string, AlertRule>): void {
    this.rules = rules;
  }

  registerSink(channel: string, sink: AlertSink): void {
    this.sinks.set(channel, sink);
  }

  attachToEventBus(eventBus: EventBus): void {
    eventBus.subscribe("alert.*", async (event) => {
      await this.routeAlert(event);
    });
  }

  async routeAlert(event: CodaEvent): Promise<void> {
    const rule = this.rules[event.eventType];

    if (!rule) {
      this.logger.debug(
        { eventType: event.eventType },
        "No alert rule for event, skipping"
      );
      return;
    }

    const eventId = event.eventId ?? generateEventId();

    // Check quiet hours
    if (rule.quietHours && this.isQuietHours()) {
      const bypass = this.quietHours.overrideSeverities.includes(
        event.severity
      );
      if (!bypass) {
        this.logger.info(
          { eventType: event.eventType, severity: event.severity },
          "Alert suppressed by quiet hours"
        );
        await this.recordAlertHistory(eventId, event, null, false, true, "quiet_hours");
        return;
      }
    }

    // Check user DND preferences
    if (this.preferences && event.payload?.userId) {
      const userId = event.payload.userId as string;
      const suppressed = await this.preferences.shouldSuppressAlert(
        userId,
        event.severity
      );
      if (suppressed) {
        this.logger.info(
          { eventType: event.eventType, userId },
          "Alert suppressed by user DND"
        );
        await this.recordAlertHistory(eventId, event, null, false, true, "user_dnd");
        return;
      }
    }

    // Check cooldown
    if (rule.cooldown > 0 && this.redis) {
      const cooldownKey = `alert:cooldown:${event.eventType}:${event.sourceSkill}`;
      const existing = await this.redis.get(cooldownKey);
      if (existing) {
        this.logger.info(
          { eventType: event.eventType, sourceSkill: event.sourceSkill },
          "Alert suppressed by cooldown"
        );
        await this.recordAlertHistory(eventId, event, null, false, true, "cooldown");
        return;
      }
      await this.redis.set(cooldownKey, "1", "EX", rule.cooldown);
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
          // Try rich format first
          if (sink.sendRich && channel === "discord") {
            const formatted = formatAlertForDiscord(event);
            await sink.sendRich(channel, formatted);
          } else if (sink.sendRich && channel === "slack") {
            const formatted = formatAlertForSlack(event);
            await sink.sendRich(channel, formatted);
          } else {
            const message = formatAlertPlainText(event);
            await sink.send(channel, message);
          }
          await this.recordAlertHistory(eventId, event, channel, true, false, null);
        } catch (err) {
          this.logger.error(
            { channel, eventType: event.eventType, error: err },
            "Failed to send alert"
          );
        }
      }
    }
  }

  /** Check whether the current time is within quiet hours. */
  isQuietHours(): boolean {
    if (!this.quietHours.enabled) return false;

    const now = new Date();
    const timeStr = now.toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      timeZone: this.quietHours.timezone,
    });

    const currentMinutes = parseTimeToMinutes(timeStr);
    const startMinutes = parseTimeToMinutes(this.quietHours.start);
    const endMinutes = parseTimeToMinutes(this.quietHours.end);

    // Overnight span (e.g., 22:00–07:00)
    if (startMinutes > endMinutes) {
      return currentMinutes >= startMinutes || currentMinutes < endMinutes;
    }

    // Same-day span (e.g., 13:00–14:00)
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }

  private async recordAlertHistory(
    eventId: string,
    event: CodaEvent,
    channel: string | null,
    delivered: boolean,
    suppressed: boolean,
    suppressionReason: string | null
  ): Promise<void> {
    if (!this.db) return;

    try {
      await this.db.insert(alertHistory).values({
        eventId,
        eventType: event.eventType,
        severity: event.severity,
        sourceSkill: event.sourceSkill,
        channel,
        payload: event.payload,
        formattedMessage: formatAlertPlainText(event),
        delivered: delivered ? 1 : 0,
        suppressed: suppressed ? 1 : 0,
        suppressionReason,
      });
    } catch (err) {
      this.logger.error(
        { error: err, eventType: event.eventType },
        "Failed to record alert history"
      );
    }
  }
}

function parseTimeToMinutes(timeStr: string): number {
  const parts = timeStr.split(":");
  return parseInt(parts[0]!, 10) * 60 + parseInt(parts[1]!, 10);
}
