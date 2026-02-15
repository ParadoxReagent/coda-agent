import Fastify from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { EventBusClient } from "./event-bus.js";
import {
  N8nWebhookPayload,
  validateWebhookSecret,
  type N8nWebhookPayloadType,
} from "./validation.js";

const REDIS_URL = process.env.REDIS_URL || "redis://redis:6379";
const PORT = parseInt(process.env.PORT || "3001", 10);
const HOST = process.env.HOST || "0.0.0.0";

const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || "info"
  }
});
const eventBus = new EventBusClient(REDIS_URL);

await fastify.register(helmet);
await fastify.register(rateLimit, {
  max: 100,
  timeWindow: "1 minute",
});

fastify.get("/health", async () => ({ status: "ok" }));

fastify.post<{ Body: N8nWebhookPayloadType }>(
  "/n8n-ingest",
  {
    schema: {
      body: {
        type: "object",
        required: ["type", "priority", "data"],
        properties: {
          type: { type: "string", minLength: 1, maxLength: 100 },
          category: {
            type: "string",
            enum: [
              "communication",
              "calendar",
              "system",
              "business",
              "development",
              "monitoring",
              "custom",
            ],
          },
          priority: { type: "string", enum: ["high", "normal", "low"] },
          data: { type: "object" },
          metadata: { type: "object" },
          tags: { type: "array", items: { type: "string" } },
          source_workflow: { type: "string", maxLength: 255 },
          timestamp: { type: "string", format: "date-time" },
        },
      },
    },
  },
  async (request, reply) => {
    if (!validateWebhookSecret(request.headers)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    const parseResult = N8nWebhookPayload.safeParse(request.body);
    if (!parseResult.success) {
      fastify.log.warn({ errors: parseResult.error }, "Invalid webhook payload");
      return reply.code(400).send({
        error: "Invalid payload",
        details: parseResult.error.format(),
      });
    }

    const payload = parseResult.data;
    const timestamp = payload.timestamp || new Date().toISOString();

    try {
      const sanitizedData = sanitizeData(payload.data);
      const sanitizedMetadata = payload.metadata
        ? sanitizeData(payload.metadata)
        : {};

      const severityMap: Record<string, "high" | "medium" | "low"> = {
        high: "high",
        normal: "medium",
        low: "low",
      };

      const eventId = await eventBus.publish({
        eventType: `n8n.${payload.type}.received`,
        timestamp,
        sourceSkill: "n8n-webhook",
        payload: {
          type: payload.type,
          category: payload.category || "custom",
          priority: payload.priority,
          timestamp,
          data: sanitizedData,
          metadata: sanitizedMetadata,
          tags: payload.tags || [],
          source_workflow: payload.source_workflow,
        },
        severity: severityMap[payload.priority] ?? "medium",
      });

      fastify.log.info(
        {
          type: payload.type,
          category: payload.category,
          priority: payload.priority,
          source: payload.source_workflow,
          eventId,
        },
        "Event published to bus"
      );

      return {
        success: true,
        event_id: eventId,
        event_type: `n8n.${payload.type}.received`,
      };
    } catch (err) {
      fastify.log.error({ error: err }, "Failed to publish event");
      return reply.code(500).send({ error: "Internal server error" });
    }
  }
);

function sanitizeData(
  data: Record<string, unknown>
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(data)) {
    if (key.startsWith("__") || key === "constructor" || key === "prototype") {
      continue;
    }

    if (typeof value === "string") {
      sanitized[key] = value
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    } else if (typeof value === "object" && value !== null) {
      sanitized[key] = Array.isArray(value)
        ? value.map((v) =>
            typeof v === "object" && v !== null
              ? sanitizeData(v as Record<string, unknown>)
              : v
          )
        : sanitizeData(value as Record<string, unknown>);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

async function start() {
  try {
    await fastify.listen({ port: PORT, host: HOST });
    fastify.log.info(`Webhook service listening on ${HOST}:${PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

process.on("SIGTERM", async () => {
  fastify.log.info("SIGTERM received, shutting down gracefully");
  await fastify.close();
  await eventBus.disconnect();
  process.exit(0);
});

start();
