import { randomBytes } from "node:crypto";
import { Redis } from "ioredis";

const STREAM_KEY = "coda:events";
const MAX_STREAM_LEN = 10_000;

interface CodaEvent {
  eventType: string;
  timestamp: string;
  sourceSkill: string;
  payload: Record<string, unknown>;
  severity: "high" | "medium" | "low";
  eventId: string;
}

function generateEventId(): string {
  const timePart = Date.now().toString(36);
  const randomPart = randomBytes(4).toString("hex");
  return `${timePart}-${randomPart}`;
}

export class EventBusClient {
  private redis: Redis;

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl);
  }

  async publish(event: Omit<CodaEvent, "eventId">): Promise<string> {
    const eventId = generateEventId();
    const fullEvent: CodaEvent = { ...event, eventId };
    const data = JSON.stringify(fullEvent);

    await this.redis.xadd(
      STREAM_KEY,
      "MAXLEN",
      "~",
      String(MAX_STREAM_LEN),
      "*",
      "data",
      data
    );

    return eventId;
  }

  async disconnect(): Promise<void> {
    this.redis.disconnect();
  }
}
