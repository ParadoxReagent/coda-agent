import type { Redis } from "ioredis";
import type { Logger } from "../utils/logger.js";
import type { CodaEvent, EventBus } from "./events.js";
import { generateEventId } from "../utils/id.js";
import { RETENTION } from "../utils/retention.js";

const STREAM_KEY = "coda:events";
const DEAD_LETTER_KEY = "coda:events:dead";
const CONSUMER_GROUP = "coda-main";
const MAX_RETRIES = 3;
const BLOCK_MS = 5000;

type StreamMessage = [id: string, fields: string[]];
type StreamReadResult = [key: string, messages: StreamMessage[]];

interface Subscription {
  pattern: RegExp;
  patternStr: string;
  handler: (event: CodaEvent) => Promise<void>;
  handlerName: string;
}

function escapeRegex(str: string): string {
  // Escape characters with special meaning in regular expressions
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Redis Streams-backed event bus with consumer groups, idempotency, and dead letter queue.
 * Replaces InProcessEventBus for production use.
 */
export class RedisStreamEventBus implements EventBus {
  private redis: Redis;
  private logger: Logger;
  private subscriptions: Subscription[] = [];
  private running = false;
  private consumerName: string;
  private retryCounts = new Map<string, number>();

  constructor(redis: Redis, logger: Logger, consumerName?: string) {
    this.redis = redis;
    this.logger = logger;
    this.consumerName = consumerName ?? `consumer-${process.pid}`;
  }

  async publish(event: CodaEvent): Promise<void> {
    if (!event.eventId) {
      event.eventId = generateEventId();
    }

    const data = JSON.stringify(event);

    await this.redis.xadd(
      STREAM_KEY,
      "MAXLEN",
      "~",
      String(RETENTION.EVENT_STREAM_MAX_LEN),
      "*",
      "data",
      data
    );

    this.logger.debug(
      { eventType: event.eventType, eventId: event.eventId },
      "Event published to stream"
    );
  }

  subscribe(
    pattern: string,
    handler: (event: CodaEvent) => Promise<void>
  ): void {
    const escapedPattern = escapeRegex(pattern);
    const regexStr = escapedPattern.replace(/\\\*/g, ".*");
    const regex = new RegExp(`^${regexStr}$`);

    // Derive handler name from pattern + subscription index for idempotency
    const handlerName = `${pattern}:${this.subscriptions.length}`;

    this.subscriptions.push({
      pattern: regex,
      patternStr: pattern,
      handler,
      handlerName,
    });

    this.logger.debug({ pattern }, "Event subscription registered");
  }

  async startConsumer(): Promise<void> {
    // Create consumer group (idempotent)
    try {
      await this.redis.xgroup(
        "CREATE",
        STREAM_KEY,
        CONSUMER_GROUP,
        "0",
        "MKSTREAM"
      );
      this.logger.info("Consumer group created");
    } catch (err: unknown) {
      // BUSYGROUP = group already exists, which is fine
      if (err instanceof Error && err.message.includes("BUSYGROUP")) {
        this.logger.debug("Consumer group already exists");
      } else {
        throw err;
      }
    }

    this.running = true;

    // Phase 1: Process pending (unACKed) messages from prior runs
    await this.processPending();

    // Phase 2: Read new messages in a loop
    await this.readLoop();
  }

  async stopConsumer(): Promise<void> {
    this.running = false;
    this.logger.info("Event bus consumer stopping");
  }

  /** Process pending (unACKed) messages for crash recovery. */
  private async processPending(): Promise<void> {
    while (this.running) {
      const results = await this.redis.xreadgroup(
        "GROUP",
        CONSUMER_GROUP,
        this.consumerName,
        "COUNT",
        "100",
        "STREAMS",
        STREAM_KEY,
        "0"
      );

      if (!results || results.length === 0) break;

      const streamResult = results[0] as unknown as StreamReadResult;
      const messages = streamResult[1];
      if (!messages || messages.length === 0) break;

      for (const [messageId, fields] of messages) {
        await this.processMessage(messageId, fields);
      }
    }
  }

  /** Main read loop for new messages. */
  private async readLoop(): Promise<void> {
    while (this.running) {
      try {
        const results = await this.redis.xreadgroup(
          "GROUP",
          CONSUMER_GROUP,
          this.consumerName,
          "COUNT",
          "10",
          "BLOCK",
          String(BLOCK_MS),
          "STREAMS",
          STREAM_KEY,
          ">"
        );

        if (!results || results.length === 0) {
          // Yield to event loop — in production BLOCK handles the wait,
          // but when it returns null we pause briefly to avoid tight spinning
          if (!this.running) break;
          await new Promise((r) => setTimeout(r, 50));
          continue;
        }

        const streamResult = results[0] as unknown as StreamReadResult;
        const messages = streamResult[1];
        if (!messages) continue;

        for (const [messageId, fields] of messages) {
          await this.processMessage(messageId, fields);
        }
      } catch (err) {
        if (!this.running) break;
        this.logger.error({ error: err }, "Error reading from event stream");
        // Brief pause before retrying
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  /** Process a single stream message, dispatching to matching handlers. */
  private async processMessage(
    messageId: string,
    fields: string[]
  ): Promise<void> {
    // fields is [key, value, key, value, ...]
    const dataIndex = fields.indexOf("data");
    if (dataIndex === -1 || dataIndex + 1 >= fields.length) {
      await this.redis.xack(STREAM_KEY, CONSUMER_GROUP, messageId);
      return;
    }

    let event: CodaEvent;
    try {
      event = JSON.parse(fields[dataIndex + 1]!) as CodaEvent;
    } catch {
      this.logger.warn({ messageId }, "Unparseable event in stream, skipping");
      await this.redis.xack(STREAM_KEY, CONSUMER_GROUP, messageId);
      return;
    }

    // Resolve matching subscriptions once
    const matchingSubs = this.subscriptions.filter(sub => sub.pattern.test(event.eventType));

    if (matchingSubs.length === 0) {
      await this.redis.xack(STREAM_KEY, CONSUMER_GROUP, messageId);
      return;
    }

    const eventId = event.eventId ?? messageId;
    const idemKeys = matchingSubs.map(sub => `idem:${eventId}:${sub.handlerName}`);

    // Batch-check all idempotency keys in a single round-trip instead of N sequential GETs
    const idemResults = await this.redis.mget(...idemKeys);

    let allHandlersSucceeded = true;
    const pipeline = this.redis.pipeline();

    for (let i = 0; i < matchingSubs.length; i++) {
      const sub = matchingSubs[i]!;
      const idemKey = idemKeys[i]!;

      if (idemResults[i]) continue; // Already processed by a prior consumer

      try {
        await sub.handler(event);
        // Queue the idempotency mark — all successful SETs flushed in one batch below
        pipeline.set(idemKey, "1", "EX", RETENTION.IDEMPOTENCY_KEY_TTL);
        // Clean up retry count on success (fixes slow memory leak on retried-then-recovered handlers)
        this.retryCounts.delete(`${messageId}:${sub.handlerName}`);
      } catch (err) {
        allHandlersSucceeded = false;
        const retryKey = `${messageId}:${sub.handlerName}`;
        const count = (this.retryCounts.get(retryKey) ?? 0) + 1;
        this.retryCounts.set(retryKey, count);

        if (count >= MAX_RETRIES) {
          this.logger.error(
            {
              messageId,
              eventType: event.eventType,
              handler: sub.handlerName,
              attempts: count,
              error: err,
            },
            "Handler failed after max retries, sending to dead letter"
          );

          await this.redis.xadd(
            DEAD_LETTER_KEY,
            "*",
            "data",
            JSON.stringify(event),
            "error",
            err instanceof Error ? err.message : "Unknown error",
            "handler",
            sub.handlerName,
            "originalMessageId",
            messageId
          );

          await this.publish({
            eventType: "alert.system.dead_letter",
            timestamp: new Date().toISOString(),
            sourceSkill: "system",
            payload: {
              originalEventType: event.eventType,
              handler: sub.handlerName,
              error: err instanceof Error ? err.message : "Unknown error",
            },
            severity: "high",
          });

          this.retryCounts.delete(retryKey);
        } else {
          this.logger.warn(
            {
              messageId,
              eventType: event.eventType,
              handler: sub.handlerName,
              attempt: count,
              error: err,
            },
            "Handler failed, will retry"
          );
        }
      }
    }

    // Flush all queued idempotency SET operations in a single round-trip
    await pipeline.exec();

    if (allHandlersSucceeded) {
      await this.redis.xack(STREAM_KEY, CONSUMER_GROUP, messageId);
    } else {
      // ACK only when all failed handlers have exhausted retries
      const allExhausted = matchingSubs.every((sub) => {
        const count = this.retryCounts.get(`${messageId}:${sub.handlerName}`) ?? 0;
        return count === 0; // 0 means either succeeded or was dead-lettered
      });

      if (allExhausted) {
        await this.redis.xack(STREAM_KEY, CONSUMER_GROUP, messageId);
      }
    }
  }
}
