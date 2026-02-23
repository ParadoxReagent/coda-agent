/**
 * MessageSender: Generalized outbound messaging interface for skills and
 * scheduled tasks to send proactive messages to users.
 *
 * Key properties:
 * - Rate-limited per channel (configurable, default 10/hour)
 * - Channel allowlist — only registered channels can receive messages
 * - All sends are fire-and-forget (errors logged, not thrown)
 * - Used by: morning briefing, ambient monitors, any skill needing proactive sends
 */
import type { Logger } from "../utils/logger.js";
import type { AuditService } from "./audit.js";

export interface MessageChannel {
  id: string;
  name: string;
  send(message: string): Promise<void>;
}

export interface MessageSenderOptions {
  /** Max outbound messages per channel per hour (default: 10) */
  rateLimit?: number;
}

interface RateBucket {
  count: number;
  windowStart: number;
}

export class MessageSender {
  private channels: Map<string, MessageChannel> = new Map();
  private rateBuckets: Map<string, RateBucket> = new Map();
  private rateLimit: number;

  constructor(
    private logger: Logger,
    private auditService?: AuditService,
    options: MessageSenderOptions = {}
  ) {
    this.rateLimit = options.rateLimit ?? 10;
  }

  /** Register a channel that can receive proactive messages. */
  registerChannel(channel: MessageChannel): void {
    this.channels.set(channel.id, channel);
    this.logger.debug({ channelId: channel.id, name: channel.name }, "MessageSender: channel registered");
  }

  /** Unregister a channel. */
  unregisterChannel(channelId: string): void {
    this.channels.delete(channelId);
  }

  /**
   * Send a proactive message to a registered channel.
   * Respects rate limits. Returns true if sent, false if rate-limited or channel unknown.
   * Never throws.
   */
  async send(channelId: string, message: string, source?: string): Promise<boolean> {
    const channel = this.channels.get(channelId);
    if (!channel) {
      this.logger.warn(
        { channelId, source },
        "MessageSender.send: unknown channel (not in allowlist)"
      );
      return false;
    }

    if (!this.checkRateLimit(channelId)) {
      this.logger.warn(
        { channelId, limit: this.rateLimit, source },
        "MessageSender.send: rate limit reached for channel"
      );
      return false;
    }

    try {
      await channel.send(message);

      void this.auditService?.write({
        eventType: "tool_call",
        skillName: source ?? "message-sender",
        toolName: "proactive_send",
        inputSummary: `channel=${channelId} len=${message.length}`,
        status: "success",
      });

      this.logger.debug(
        { channelId, len: message.length, source },
        "MessageSender: proactive message sent"
      );
      return true;
    } catch (err) {
      this.logger.error({ channelId, error: err, source }, "MessageSender.send failed");
      return false;
    }
  }

  /** Send to all registered channels (useful for system-wide notifications). */
  async broadcast(message: string, source?: string): Promise<void> {
    for (const channelId of this.channels.keys()) {
      await this.send(channelId, message, source);
    }
  }

  /** List registered channel IDs. */
  getChannelIds(): string[] {
    return Array.from(this.channels.keys());
  }

  private checkRateLimit(channelId: string): boolean {
    const now = Date.now();
    const windowMs = 3600 * 1000;
    const bucket = this.rateBuckets.get(channelId);

    if (!bucket || now - bucket.windowStart > windowMs) {
      this.rateBuckets.set(channelId, { count: 1, windowStart: now });
      return true;
    }

    if (bucket.count >= this.rateLimit) {
      return false;
    }

    bucket.count++;
    return true;
  }
}
