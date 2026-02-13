# n8n Skill Implementation Plan

> **Note:** The n8n skill has been moved from `src/skills/n8n/` to `src/integrations/n8n/`. Paths in this document reflect the original plan.

## Overview

This plan implements a secure, event-driven integration between n8n workflows and coda-agent. The architecture uses a webhook service to ingest data from n8n, publishes events to coda's event bus, and provides a skill that makes this data available to the LLM for morning briefings and on-demand queries.

**Key Design Decision: Fully Generic Event Model**

Unlike typical integrations that hardcode specific event types (email, calendar, etc.), this implementation is **completely generic**. It accepts ANY event type you send from n8n, with no code changes required. This means:

✅ **Future-proof**: Add new event types without touching code
✅ **Flexible**: Send github PRs, slack messages, server alerts, customer signups, deployment notifications, etc.
✅ **Extensible**: Use categories, tags, and metadata for advanced organization
✅ **Intelligent**: LLM automatically adapts to new event types
✅ **Scalable**: Same infrastructure handles 5 event types or 500

**Example Use Cases:**
- Email notifications → `type: "email"`
- GitHub pull requests → `type: "github_pr"`
- Server CPU alerts → `type: "server_alert"`
- Customer signups → `type: "customer_signup"`
- Deployment completions → `type: "deployment"`
- Backup status → `type: "backup_completed"`
- Slack mentions → `type: "slack_mention"`
- *Literally anything you can imagine*

**Architecture Flow:**
```
n8n workflows → Webhook Service → Event Bus (Redis pub/sub)
                                      ↓
                                  n8n Skill subscribes
                                      ↓
                                  PostgreSQL storage
                                      ↓
                      LLM queries via orchestrator tools
```

**How It Works:**
1. You define your event type in n8n (any string: "email", "github_pr", "custom_alert")
2. n8n sends it to the webhook with your data structure
3. Webhook validates and publishes to event bus
4. n8n skill stores it in PostgreSQL
5. User asks "what github PRs came in?" → LLM queries with `types=['github_pr']`
6. No code changes needed, ever

---

## Phase 1: Database Schema & Migration

### 1.1 Create n8n Events Table

**File:** `src/db/migrations/000X_add_n8n_events.sql`

```sql
-- n8n events table for storing ANY kind of ingested workflow data
CREATE TABLE "n8n_events" (
  "id" serial PRIMARY KEY,
  "type" varchar(100) NOT NULL,  -- Increased size for custom types
  "category" varchar(50),         -- Optional grouping (email, calendar, system, custom)
  "priority" varchar(20) NOT NULL,
  "timestamp" timestamp with time zone NOT NULL,
  "data" jsonb NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb, -- Flexible metadata storage
  "tags" text[] DEFAULT '{}',     -- Searchable tags
  "source_workflow" varchar(255), -- Which n8n workflow created this
  "processed" boolean DEFAULT false NOT NULL,
  "processed_at" timestamp with time zone,
  "created_at" timestamp DEFAULT now() NOT NULL
);

-- Indexes for efficient querying
CREATE INDEX "n8n_events_type_idx" ON "n8n_events" ("type");
CREATE INDEX "n8n_events_category_idx" ON "n8n_events" ("category");
CREATE INDEX "n8n_events_timestamp_idx" ON "n8n_events" ("timestamp");
CREATE INDEX "n8n_events_processed_idx" ON "n8n_events" ("processed");
CREATE INDEX "n8n_events_priority_timestamp_idx" ON "n8n_events" ("priority", "timestamp" DESC);

-- Composite index for common query pattern (unprocessed events by time)
CREATE INDEX "n8n_events_unprocessed_time_idx" 
  ON "n8n_events" ("processed", "timestamp" DESC) 
  WHERE processed = false;

-- GIN index for tag searching
CREATE INDEX "n8n_events_tags_idx" ON "n8n_events" USING GIN ("tags");

-- GIN index for flexible metadata queries
CREATE INDEX "n8n_events_metadata_idx" ON "n8n_events" USING GIN ("metadata");
```

### 1.2 Update Schema TypeScript Definitions

**File:** `src/db/schema.ts`

Add to existing schema:

```typescript
/** n8n workflow events ingested via webhook - supports ANY event type. */
export const n8nEvents = pgTable(
  "n8n_events",
  {
    id: serial("id").primaryKey(),
    type: varchar("type", { length: 100 }).notNull(), // Any custom type from n8n
    category: varchar("category", { length: 50 }),    // Optional: email, calendar, system, custom
    priority: varchar("priority", { length: 20 }).notNull(),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
    data: jsonb("data").notNull(),                    // Flexible data structure
    metadata: jsonb("metadata").default({}).notNull(), // Workflow info, custom fields
    tags: text("tags").array().default([]).notNull(), // Searchable tags
    sourceWorkflow: varchar("source_workflow", { length: 255 }), // Which n8n workflow
    processed: boolean("processed").default(false).notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("n8n_events_type_idx").on(table.type),
    index("n8n_events_category_idx").on(table.category),
    index("n8n_events_timestamp_idx").on(table.timestamp),
    index("n8n_events_processed_idx").on(table.processed),
    index("n8n_events_priority_timestamp_idx").on(table.priority, table.timestamp.desc()),
  ]
);
```

### 1.3 Run Migration

```bash
npm run db:migrate
```

---

## Phase 2: Webhook Service Implementation

### 2.1 Create Webhook Service Directory Structure

```
services/
  n8n-webhook/
    src/
      index.ts          # Main server
      validation.ts     # Input validation schemas
      event-bus.ts      # Redis pub/sub client
    package.json
    tsconfig.json
    Dockerfile
```

### 2.2 Webhook Service Code

**File:** `services/n8n-webhook/src/validation.ts`

```typescript
import { z } from "zod";

/** Priority levels - standard across all event types */
export const Priority = z.enum(["high", "normal", "low"]);

/** 
 * Event type is now a free-form string to support ANY custom event type.
 * Common examples: email, calendar, alert, notification, github_pr, slack_message, 
 * system_metric, backup_status, deployment, customer_signup, etc.
 */
export const EventType = z.string().min(1).max(100);

/**
 * Optional category for grouping related event types.
 * Examples: communication, system, business, development, monitoring
 */
export const EventCategory = z.enum([
  "communication",  // emails, messages, calls
  "calendar",       // events, meetings
  "system",         // alerts, metrics, logs
  "business",       // sales, signups, transactions
  "development",    // PRs, deployments, builds
  "monitoring",     // uptime, performance
  "custom"          // catch-all for user-defined categories
]).optional();

/** Incoming webhook payload schema - now fully flexible */
export const N8nWebhookPayload = z.object({
  type: EventType,
  category: EventCategory,
  priority: Priority,
  data: z.record(z.unknown()), // Any JSON structure
  metadata: z.record(z.unknown()).optional(), // Workflow metadata
  tags: z.array(z.string()).optional(), // Searchable tags
  source_workflow: z.string().max(255).optional(), // n8n workflow name/ID
  timestamp: z.string().datetime().optional(), // ISO 8601 timestamp
});

export type N8nWebhookPayloadType = z.infer<typeof N8nWebhookPayload>;

/** Webhook authentication */
export const WEBHOOK_SECRET = process.env.N8N_WEBHOOK_SECRET || "";

export function validateWebhookSecret(provided: string | undefined): boolean {
  if (!WEBHOOK_SECRET) {
    console.warn("N8N_WEBHOOK_SECRET not configured - webhook is unprotected!");
    return true; // In dev mode, allow unprotected access
  }
  return provided === WEBHOOK_SECRET;
}
```

**File:** `services/n8n-webhook/src/event-bus.ts`

```typescript
import { createClient, RedisClientType } from "redis";

export class EventBusClient {
  private client: RedisClientType;
  private publisher: RedisClientType;

  constructor(redisUrl: string) {
    this.client = createClient({ url: redisUrl });
    this.publisher = this.client.duplicate();
  }

  async connect(): Promise<void> {
    await this.client.connect();
    await this.publisher.connect();
  }

  async disconnect(): Promise<void> {
    await this.client.disconnect();
    await this.publisher.disconnect();
  }

  async publish(channel: string, message: unknown): Promise<void> {
    await this.publisher.publish(channel, JSON.stringify(message));
  }
}
```

**File:** `services/n8n-webhook/src/index.ts`

```typescript
import Fastify from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { EventBusClient } from "./event-bus.js";
import {
  N8nWebhookPayload,
  validateWebhookSecret,
  type N8nWebhookPayloadType,
} from "./validation.js";
import { pino } from "pino";

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

const REDIS_URL = process.env.REDIS_URL || "redis://redis:6379";
const PORT = parseInt(process.env.PORT || "3001", 10);
const HOST = process.env.HOST || "0.0.0.0";

const fastify = Fastify({ logger });
const eventBus = new EventBusClient(REDIS_URL);

// Security middleware
await fastify.register(helmet);
await fastify.register(rateLimit, {
  max: 100, // Max 100 requests per minute per IP
  timeWindow: "1 minute",
});

// Health check endpoint
fastify.get("/health", async () => ({ status: "ok" }));

// Webhook ingestion endpoint
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
            enum: ["communication", "calendar", "system", "business", "development", "monitoring", "custom"]
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
    // Authenticate request
    const authHeader = request.headers["x-webhook-secret"];
    if (!validateWebhookSecret(authHeader)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    // Validate payload
    const parseResult = N8nWebhookPayload.safeParse(request.body);
    if (!parseResult.success) {
      logger.warn({ errors: parseResult.error }, "Invalid webhook payload");
      return reply.code(400).send({
        error: "Invalid payload",
        details: parseResult.error.format(),
      });
    }

    const payload = parseResult.data;
    const timestamp = payload.timestamp || new Date().toISOString();

    try {
      // Sanitize data to prevent injection attacks
      const sanitizedData = sanitizeData(payload.data);
      const sanitizedMetadata = payload.metadata 
        ? sanitizeData(payload.metadata) 
        : {};

      // Publish to event bus with all flexible fields
      const eventChannel = `n8n.${payload.type}.received`;
      await eventBus.publish(eventChannel, {
        type: payload.type,
        category: payload.category || "custom",
        priority: payload.priority,
        timestamp,
        data: sanitizedData,
        metadata: sanitizedMetadata,
        tags: payload.tags || [],
        source_workflow: payload.source_workflow,
      });

      logger.info(
        { 
          type: payload.type, 
          category: payload.category,
          priority: payload.priority,
          source: payload.source_workflow 
        },
        "Event published to bus"
      );

      return { success: true, event: eventChannel };
    } catch (err) {
      logger.error({ error: err }, "Failed to publish event");
      return reply.code(500).send({ error: "Internal server error" });
    }
  }
);

/** Sanitize incoming data to prevent injection attacks */
function sanitizeData(data: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  
  for (const [key, value] of Object.entries(data)) {
    // Remove any keys that could be dangerous
    if (key.startsWith("__") || key === "constructor" || key === "prototype") {
      continue;
    }
    
    if (typeof value === "string") {
      // Basic HTML entity escaping for string values
      sanitized[key] = value
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#x27;");
    } else if (typeof value === "object" && value !== null) {
      // Recursively sanitize nested objects
      sanitized[key] = Array.isArray(value) 
        ? value.map(v => typeof v === "object" ? sanitizeData(v as Record<string, unknown>) : v)
        : sanitizeData(value as Record<string, unknown>);
    } else {
      sanitized[key] = value;
    }
  }
  
  return sanitized;
}

// Startup
async function start() {
  try {
    await eventBus.connect();
    logger.info("Connected to Redis event bus");

    await fastify.listen({ port: PORT, host: HOST });
    logger.info(`Webhook service listening on ${HOST}:${PORT}`);
  } catch (err) {
    logger.error(err);
    process.exit(1);
  }
}

// Graceful shutdown
process.on("SIGTERM", async () => {
  logger.info("SIGTERM received, shutting down gracefully");
  await fastify.close();
  await eventBus.disconnect();
  process.exit(0);
});

start();
```

**File:** `services/n8n-webhook/package.json`

```json
{
  "name": "n8n-webhook",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@fastify/helmet": "^12.0.0",
    "@fastify/rate-limit": "^10.0.0",
    "fastify": "^5.0.0",
    "pino": "^9.0.0",
    "redis": "^4.7.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0"
  }
}
```

**File:** `services/n8n-webhook/Dockerfile`

```dockerfile
FROM node:22-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine

WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package*.json ./
RUN npm ci --only=production

ENV NODE_ENV=production
EXPOSE 3001

CMD ["node", "dist/index.js"]
```

### 2.3 Update Docker Compose

**File:** `docker-compose.yml`

Add to services:

```yaml
  n8n-webhook:
    build: ./services/n8n-webhook
    container_name: coda-n8n-webhook
    networks:
      - coda-internal
      - lan-bridge  # Accessible from n8n on LAN
    ports:
      - "3001:3001"  # Expose to LAN for n8n access
    environment:
      - REDIS_URL=redis://redis:6379
      - N8N_WEBHOOK_SECRET=${N8N_WEBHOOK_SECRET}
      - LOG_LEVEL=info
      - NODE_ENV=production
    depends_on:
      - redis
    restart: unless-stopped
```

---

## Phase 3: n8n Skill Implementation

### 3.1 Create Skill Directory Structure

```
src/skills/n8n/
  index.ts          # Main skill class
  types.ts          # TypeScript types
  queries.ts        # Database queries
```

### 3.2 Skill Implementation

**File:** `src/skills/n8n/types.ts`

```typescript
export interface N8nEvent {
  id: number;
  type: string;              // Any custom type
  category: string | null;   // Optional category grouping
  priority: string;
  timestamp: Date;
  data: Record<string, unknown>;
  metadata: Record<string, unknown>;
  tags: string[];
  sourceWorkflow: string | null;
  processed: boolean;
  processedAt: Date | null;
  createdAt: Date;
}

export interface N8nEventFilters {
  types?: string[];          // Filter by one or more types
  categories?: string[];     // Filter by categories
  tags?: string[];           // Filter by tags (AND logic)
  hoursBack?: number;
  onlyUnprocessed?: boolean;
  minPriority?: "high" | "normal" | "low";
  sourceWorkflow?: string;   // Filter by specific workflow
}

export interface N8nEventSummary {
  total: number;
  by_type: Record<string, number>;
  by_category: Record<string, number>;
  by_priority: Record<string, number>;
  by_workflow: Record<string, number>;
  recent_types: string[];    // Recently seen event types
}
```

**File:** `src/skills/n8n/queries.ts`

```typescript
import { and, desc, eq, gte, inArray, sql, arrayContains } from "drizzle-orm";
import type { Database } from "../../db/index.js";
import { n8nEvents } from "../../db/schema.js";
import type { N8nEvent, N8nEventFilters, N8nEventSummary } from "./types.js";

export class N8nQueries {
  constructor(private db: Database) {}

  async getEvents(filters: N8nEventFilters): Promise<N8nEvent[]> {
    const conditions = [];

    // Time filter
    if (filters.hoursBack) {
      const since = new Date(Date.now() - filters.hoursBack * 3600000);
      conditions.push(gte(n8nEvents.timestamp, since));
    }

    // Type filter - supports multiple types
    if (filters.types && filters.types.length > 0) {
      conditions.push(inArray(n8nEvents.type, filters.types));
    }

    // Category filter
    if (filters.categories && filters.categories.length > 0) {
      conditions.push(inArray(n8nEvents.category, filters.categories));
    }

    // Tag filter - events must have ALL specified tags
    if (filters.tags && filters.tags.length > 0) {
      for (const tag of filters.tags) {
        conditions.push(arrayContains(n8nEvents.tags, [tag]));
      }
    }

    // Source workflow filter
    if (filters.sourceWorkflow) {
      conditions.push(eq(n8nEvents.sourceWorkflow, filters.sourceWorkflow));
    }

    // Processed filter
    if (filters.onlyUnprocessed) {
      conditions.push(eq(n8nEvents.processed, false));
    }

    // Priority filter (high > normal > low)
    if (filters.minPriority === "high") {
      conditions.push(eq(n8nEvents.priority, "high"));
    } else if (filters.minPriority === "normal") {
      conditions.push(
        sql`${n8nEvents.priority} IN ('high', 'normal')`
      );
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    return this.db
      .select()
      .from(n8nEvents)
      .where(whereClause)
      .orderBy(
        // High priority first, then by timestamp descending
        sql`
          CASE ${n8nEvents.priority}
            WHEN 'high' THEN 1
            WHEN 'normal' THEN 2
            WHEN 'low' THEN 3
          END
        `,
        desc(n8nEvents.timestamp)
      );
  }

  async getSummary(filters: N8nEventFilters): Promise<N8nEventSummary> {
    const events = await this.getEvents(filters);

    const summary: N8nEventSummary = {
      total: events.length,
      by_type: {},
      by_category: {},
      by_priority: {},
      by_workflow: {},
      recent_types: [],
    };

    const seenTypes = new Set<string>();

    for (const event of events) {
      // Count by type
      summary.by_type[event.type] = (summary.by_type[event.type] || 0) + 1;
      
      // Count by category
      if (event.category) {
        summary.by_category[event.category] = 
          (summary.by_category[event.category] || 0) + 1;
      }

      // Count by priority
      summary.by_priority[event.priority] = 
        (summary.by_priority[event.priority] || 0) + 1;

      // Count by workflow
      if (event.sourceWorkflow) {
        summary.by_workflow[event.sourceWorkflow] = 
          (summary.by_workflow[event.sourceWorkflow] || 0) + 1;
      }

      // Track recent unique types (in order of appearance)
      if (!seenTypes.has(event.type)) {
        seenTypes.add(event.type);
        summary.recent_types.push(event.type);
      }
    }

    return summary;
  }

  async markProcessed(eventIds: number[]): Promise<number> {
    if (eventIds.length === 0) return 0;

    const result = await this.db
      .update(n8nEvents)
      .set({
        processed: true,
        processedAt: new Date(),
      })
      .where(inArray(n8nEvents.id, eventIds));

    return result.rowCount ?? 0;
  }

  async insertEvent(event: {
    type: string;
    category?: string;
    priority: string;
    timestamp: Date;
    data: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    tags?: string[];
    sourceWorkflow?: string;
  }): Promise<void> {
    await this.db.insert(n8nEvents).values({
      type: event.type,
      category: event.category || null,
      priority: event.priority,
      timestamp: event.timestamp,
      data: event.data,
      metadata: event.metadata || {},
      tags: event.tags || [],
      sourceWorkflow: event.sourceWorkflow || null,
    });
  }

  async getEventTypes(hoursBack: number = 168): Promise<string[]> {
    const since = new Date(Date.now() - hoursBack * 3600000);
    
    const results = await this.db
      .selectDistinct({ type: n8nEvents.type })
      .from(n8nEvents)
      .where(gte(n8nEvents.timestamp, since))
      .orderBy(n8nEvents.type);

    return results.map(r => r.type);
  }

  async getEventCount(filters: N8nEventFilters): Promise<number> {
    const events = await this.getEvents(filters);
    return events.length;
  }
}
```

**File:** `src/skills/n8n/index.ts`

```typescript
import type { Skill, SkillToolDefinition } from "../base.js";
import type { SkillContext } from "../context.js";
import { N8nQueries } from "./queries.js";
import type { N8nEvent, N8nEventFilters } from "./types.js";
import type { Database } from "../../db/index.js";
import type { EventBus } from "../../core/event-bus.js";
import type { Logger } from "../../utils/logger.js";
import { ContentSanitizer } from "../../core/sanitizer.js";

export class N8nSkill implements Skill {
  readonly name = "n8n";
  readonly description = "Access data ingested from n8n workflows including emails, calendar events, and notifications";

  private db!: Database;
  private eventBus!: EventBus;
  private logger!: Logger;
  private queries!: N8nQueries;

  getTools(): SkillToolDefinition[] {
    return [
      {
        name: "n8n_query_events",
        description: "Query events from n8n workflows with flexible filtering. Supports ANY event type sent from n8n. Use for morning briefings, checking specific event types, or searching by tags/categories.",
        input_schema: {
          type: "object",
          properties: {
            types: {
              type: "array",
              items: { type: "string" },
              description: "Filter by specific event types (e.g., ['email', 'github_pr', 'slack_message']). Leave empty for all types.",
            },
            categories: {
              type: "array",
              items: { 
                type: "string",
                enum: ["communication", "calendar", "system", "business", "development", "monitoring", "custom"]
              },
              description: "Filter by event categories",
            },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Filter by tags (events must have ALL specified tags)",
            },
            hours_back: {
              type: "number",
              description: "How many hours to look back (default: 12 for overnight)",
              minimum: 1,
              maximum: 168, // 1 week max
            },
            only_unprocessed: {
              type: "boolean",
              description: "Only show unprocessed items (default: true)",
            },
            min_priority: {
              type: "string",
              enum: ["high", "normal", "low"],
              description: "Minimum priority level to include",
            },
            source_workflow: {
              type: "string",
              description: "Filter by specific n8n workflow name/ID",
            },
          },
        },
      },
      {
        name: "n8n_get_summary",
        description: "Get a statistical summary of events including counts by type, category, priority, and workflow. Useful for quick overview or discovering what types of events are available.",
        input_schema: {
          type: "object",
          properties: {
            hours_back: {
              type: "number",
              description: "How many hours to look back (default: 24)",
              minimum: 1,
            },
            only_unprocessed: {
              type: "boolean",
              description: "Only count unprocessed events (default: true)",
            },
          },
        },
      },
      {
        name: "n8n_list_event_types",
        description: "List all unique event types seen in the last N hours. Useful for discovering what kinds of events are being sent from n8n.",
        input_schema: {
          type: "object",
          properties: {
            hours_back: {
              type: "number",
              description: "How many hours to look back (default: 168 = 1 week)",
              minimum: 1,
            },
          },
        },
      },
      {
        name: "n8n_mark_processed",
        description: "Mark specific events as processed/read. Use after user acknowledges or acts on events.",
        input_schema: {
          type: "object",
          properties: {
            event_ids: {
              type: "array",
              items: { type: "number" },
              description: "Array of event IDs to mark as processed",
              minItems: 1,
            },
          },
          required: ["event_ids"],
        },
      },
    ];
  }

  async execute(
    toolName: string,
    toolInput: Record<string, unknown>
  ): Promise<string> {
    try {
      if (toolName === "n8n_query_events") {
        return await this.queryEvents(toolInput);
      }

      if (toolName === "n8n_get_summary") {
        return await this.getSummary(toolInput);
      }

      if (toolName === "n8n_list_event_types") {
        return await this.listEventTypes(toolInput);
      }

      if (toolName === "n8n_mark_processed") {
        return await this.markProcessed(toolInput);
      }

      throw new Error(`Unknown tool: ${toolName}`);
    } catch (err) {
      this.logger.error({ error: err, tool: toolName }, "Tool execution failed");
      return `Error executing ${toolName}: ${err instanceof Error ? err.message : "Unknown error"}`;
    }
  }

  private async queryEvents(input: Record<string, unknown>): Promise<string> {
    const filters: N8nEventFilters = {
      types: input.types as string[] | undefined,
      categories: input.categories as string[] | undefined,
      tags: input.tags as string[] | undefined,
      hoursBack: (input.hours_back as number) ?? 12,
      onlyUnprocessed: (input.only_unprocessed as boolean) ?? true,
      minPriority: input.min_priority as "high" | "normal" | "low" | undefined,
      sourceWorkflow: input.source_workflow as string | undefined,
    };

    const events = await this.queries.getEvents(filters);

    if (events.length === 0) {
      const filterDesc = [];
      if (filters.types?.length) filterDesc.push(`types: ${filters.types.join(", ")}`);
      if (filters.categories?.length) filterDesc.push(`categories: ${filters.categories.join(", ")}`);
      if (filters.tags?.length) filterDesc.push(`tags: ${filters.tags.join(", ")}`);
      
      return `No events found${filterDesc.length ? ` matching ${filterDesc.join("; ")}` : ""}.`;
    }

    // Format events for LLM consumption with sanitization
    const formattedEvents = events.map((e) => this.formatEvent(e));

    return JSON.stringify(
      {
        count: events.length,
        filters_applied: {
          time_range_hours: filters.hoursBack,
          types: filters.types || "all",
          categories: filters.categories || "all",
          tags: filters.tags || "none",
          workflow: filters.sourceWorkflow || "all",
          only_unprocessed: filters.onlyUnprocessed,
        },
        events: formattedEvents,
      },
      null,
      2
    );
  }

  private async getSummary(input: Record<string, unknown>): Promise<string> {
    const hoursBack = (input.hours_back as number) ?? 24;
    const onlyUnprocessed = (input.only_unprocessed as boolean) ?? true;

    const summary = await this.queries.getSummary({
      hoursBack,
      onlyUnprocessed,
    });

    return JSON.stringify(summary, null, 2);
  }

  private async listEventTypes(input: Record<string, unknown>): Promise<string> {
    const hoursBack = (input.hours_back as number) ?? 168;
    
    const types = await this.queries.getEventTypes(hoursBack);

    if (types.length === 0) {
      return "No events found in the specified time range.";
    }

    return JSON.stringify({
      count: types.length,
      types: types,
      time_range_hours: hoursBack,
    }, null, 2);
  }

  private async markProcessed(input: Record<string, unknown>): Promise<string> {
    const eventIds = input.event_ids as number[];

    if (!Array.isArray(eventIds) || eventIds.length === 0) {
      return "No event IDs provided";
    }

    const count = await this.queries.markProcessed(eventIds);

    this.logger.info({ count, eventIds }, "Marked events as processed");

    // Publish event for audit trail
    await this.eventBus.publish("n8n.events.processed", {
      count,
      eventIds,
      timestamp: new Date().toISOString(),
    });

    return `Marked ${count} event(s) as processed`;
  }

  private formatEvent(event: N8nEvent): Record<string, unknown> {
    // Sanitize event data before returning to LLM
    const sanitizedData = this.sanitizeEventData(event.data);

    return {
      id: event.id,
      type: event.type,
      category: event.category,
      priority: event.priority,
      timestamp: event.timestamp.toISOString(),
      tags: event.tags,
      source_workflow: event.sourceWorkflow,
      data: sanitizedData,
      metadata: event.metadata,
    };
  }

  private sanitizeEventData(data: Record<string, unknown>): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(data)) {
      if (typeof value === "string") {
        // Use ContentSanitizer for string data
        sanitized[key] = ContentSanitizer.sanitizeApiResponse(value);
      } else if (typeof value === "object" && value !== null) {
        // Recursively sanitize nested objects
        sanitized[key] = Array.isArray(value)
          ? value.map((v) =>
              typeof v === "object" && v !== null
                ? this.sanitizeEventData(v as Record<string, unknown>)
                : v
            )
          : this.sanitizeEventData(value as Record<string, unknown>);
      } else {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }

  async startup(ctx: SkillContext): Promise<void> {
    this.db = ctx.db;
    this.eventBus = ctx.eventBus;
    this.logger = ctx.logger;
    this.queries = new N8nQueries(this.db);

    // Subscribe to ALL n8n events from webhook service (wildcard pattern)
    await ctx.eventBus.subscribe("n8n.*.received", async (event) => {
      try {
        this.logger.info(
          { 
            type: event.payload.type,
            category: event.payload.category,
            workflow: event.payload.source_workflow 
          }, 
          "Received n8n event from webhook"
        );

        // Store in database with all flexible fields
        await this.queries.insertEvent({
          type: event.payload.type,
          category: event.payload.category,
          priority: event.payload.priority,
          timestamp: new Date(event.payload.timestamp),
          data: event.payload.data,
          metadata: event.payload.metadata || {},
          tags: event.payload.tags || [],
          sourceWorkflow: event.payload.source_workflow,
        });

        // Smart alert routing based on priority and category
        if (event.payload.priority === "high") {
          // Publish alert events for high-priority items
          const alertChannel = `alert.n8n.${event.payload.category || 'urgent'}`;
          
          await this.eventBus.publish(alertChannel, {
            type: event.payload.type,
            summary: this.generateAlertSummary(event.payload),
            timestamp: event.payload.timestamp,
            event_id: event.payload.id,
          });
        }

        // Special handling for specific event types (extensible)
        await this.handleSpecialEventTypes(event.payload);

      } catch (err) {
        this.logger.error({ error: err }, "Failed to process n8n event");
      }
    });

    this.logger.info("n8n skill started and subscribed to event bus");
  }

  /**
   * Generate a human-readable alert summary from event data
   */
  private generateAlertSummary(payload: any): string {
    // Try to extract meaningful summary from common fields
    if (payload.data.subject) return payload.data.subject;
    if (payload.data.title) return payload.data.title;
    if (payload.data.message) return payload.data.message;
    if (payload.data.summary) return payload.data.summary;
    
    return `${payload.type} event from ${payload.source_workflow || 'n8n'}`;
  }

  /**
   * Handle special event types with custom logic (extensible)
   * Add custom handling for specific event types as needed
   */
  private async handleSpecialEventTypes(payload: any): Promise<void> {
    // Example: Auto-tag deployment events
    if (payload.type === "deployment" || payload.type === "github_deployment") {
      // Could publish to a deployment-specific channel
      // Could trigger other workflows
      // This is where you'd add custom business logic
    }

    // Example: Customer signup events
    if (payload.type === "customer_signup" || payload.tags?.includes("new_customer")) {
      // Could trigger welcome workflow
      // Could update CRM
    }

    // Example: System alerts that need immediate attention
    if (payload.category === "system" && payload.priority === "high") {
      // Could page on-call engineer
      // Could create incident ticket
    }

    // Add more custom handlers as needed for your specific event types
  }

  async shutdown(): Promise<void> {
    this.logger.info("n8n skill shutdown");
  }

  getRequiredConfig(): string[] {
    // Optional: Add config validation if you want to require webhook secret
    // return ["n8n.webhook_secret"];
    return [];
  }
}
```

### 3.3 Register the Skill

**File:** `src/skills/index.ts`

Add to skill exports:

```typescript
export { N8nSkill } from "./n8n/index.js";
```

**File:** `src/index.ts` or wherever skills are registered

Add to skill registration:

```typescript
import { N8nSkill } from "./skills/n8n/index.js";

// In the startup function
const n8nSkill = new N8nSkill();
await skillRegistry.register(n8nSkill, config);
```

---

## Phase 4: Morning Briefing Integration

### 4.1 Update Briefing Instructions

The morning briefing already exists in coda-agent. The n8n skill's tools will automatically be available to the LLM. To ensure they're used effectively, update the briefing system prompt.

**File:** `src/core/prompts.ts` (or wherever system prompts are defined)

Add to the briefing section:

```typescript
const BRIEFING_INSTRUCTIONS = `
When the user requests a morning briefing or says "morning", provide a comprehensive summary including:

1. **n8n Events Overnight** (use n8n_query_events tool):
   - Query unprocessed events from the last 12 hours
   - Group by category and type for natural presentation
   - Prioritize high-priority items
   - Example categories: communication (emails, messages), system (alerts), business (signups), development (PRs)
   - Summarize key points without overwhelming detail

2. **Today's Schedule** (use calendar_today tool if available):
   - List today's meetings and events
   - Highlight any conflicts or important deadlines

3. **Pending Tasks** (use reminder_list tool if available):
   - Show reminders due today
   - Note any overdue items

4. **Contextual Information**:
   - Weather if relevant
   - Any alerts or notifications

Present the briefing in a natural, conversational format. Be concise but thorough.

After presenting events to the user, call n8n_mark_processed with the event IDs that were 
mentioned in the briefing to mark them as processed.

For specific queries about n8n events:
- Use n8n_query_events with appropriate filters (types, categories, tags, workflows)
- Use n8n_list_event_types to discover available event types
- Use n8n_get_summary for statistical overviews
`;
```

---

## Phase 5: n8n Workflow Configuration

### 5.1 Understanding the Generic Event Model

The n8n skill now accepts **ANY event type** you define. Here's the flexible schema:

```json
{
  "type": "<any_string>",           // Required: Your custom event type
  "category": "<optional_category>", // Optional: communication, system, business, etc.
  "priority": "high|normal|low",    // Required
  "tags": ["tag1", "tag2"],         // Optional: For filtering/searching
  "source_workflow": "workflow_name", // Optional: Which n8n workflow sent this
  "metadata": {                     // Optional: Any workflow-specific data
    "workflow_id": "123",
    "execution_id": "456"
  },
  "data": {                         // Required: Your event payload
    // Any structure you want
  }
}
```

### 5.2 Example Event Types & Workflows

#### Example 1: Email Processing (Communication Category)

**Event Type:** `email`

```javascript
// n8n Function node
return {
  type: 'email',
  category: 'communication',
  priority: email.subject.toLowerCase().includes('urgent') ? 'high' : 'normal',
  tags: ['inbox', email.from.includes('boss') ? 'important' : 'general'],
  source_workflow: 'Email Monitor',
  data: {
    from: email.from,
    to: email.to,
    subject: email.subject,
    preview: email.text?.substring(0, 200),
    received_at: email.date,
    has_attachments: (email.attachments?.length || 0) > 0,
  }
};
```

#### Example 2: GitHub Pull Request (Development Category)

**Event Type:** `github_pr`

```javascript
// n8n Function node
return {
  type: 'github_pr',
  category: 'development',
  priority: pr.draft ? 'low' : 'normal',
  tags: ['github', pr.base.ref, ...pr.labels.map(l => l.name)],
  source_workflow: 'GitHub PR Monitor',
  metadata: {
    repo: pr.base.repo.full_name,
    pr_number: pr.number
  },
  data: {
    title: pr.title,
    author: pr.user.login,
    status: pr.state,
    created_at: pr.created_at,
    branch: pr.head.ref,
    target_branch: pr.base.ref,
    url: pr.html_url,
    comments_count: pr.comments
  }
};
```

#### Example 3: Server Monitoring Alert (System Category)

**Event Type:** `server_alert`

```javascript
// n8n Function node
const cpuUsage = parseFloat(metric.cpu_percent);

return {
  type: 'server_alert',
  category: 'system',
  priority: cpuUsage > 90 ? 'high' : cpuUsage > 75 ? 'normal' : 'low',
  tags: ['monitoring', 'cpu', metric.hostname],
  source_workflow: 'Server Health Monitor',
  data: {
    hostname: metric.hostname,
    cpu_percent: cpuUsage,
    memory_percent: metric.memory_percent,
    disk_usage: metric.disk_usage,
    timestamp: new Date().toISOString(),
    alert_threshold: 75
  }
};
```

#### Example 4: Customer Signup (Business Category)

**Event Type:** `customer_signup`

```javascript
// n8n Function node
return {
  type: 'customer_signup',
  category: 'business',
  priority: customer.plan === 'enterprise' ? 'high' : 'normal',
  tags: ['sales', 'new_customer', customer.plan],
  source_workflow: 'Stripe Webhook Handler',
  metadata: {
    stripe_customer_id: customer.id
  },
  data: {
    email: customer.email,
    name: customer.name,
    plan: customer.plan,
    mrr: customer.plan_amount,
    signup_date: new Date().toISOString(),
    source: customer.metadata.source || 'direct'
  }
};
```

#### Example 5: Slack Important Message (Communication Category)

**Event Type:** `slack_mention`

```javascript
// n8n Function node
return {
  type: 'slack_mention',
  category: 'communication',
  priority: message.text.includes('@channel') ? 'high' : 'normal',
  tags: ['slack', message.channel, message.user],
  source_workflow: 'Slack Monitor',
  data: {
    channel: message.channel_name,
    user: message.user_name,
    message: message.text,
    timestamp: message.ts,
    thread: message.thread_ts ? 'yes' : 'no',
    url: message.permalink
  }
};
```

#### Example 6: Backup Completion (System Category)

**Event Type:** `backup_completed`

```javascript
// n8n Function node
return {
  type: 'backup_completed',
  category: 'system',
  priority: backup.status === 'failed' ? 'high' : 'low',
  tags: ['backup', backup.server, backup.status],
  source_workflow: 'Backup Monitor',
  data: {
    server: backup.server,
    status: backup.status,
    size_gb: backup.size_bytes / (1024**3),
    duration_minutes: backup.duration_seconds / 60,
    files_count: backup.files_count,
    timestamp: backup.completed_at
  }
};
```

#### Example 7: Calendar Event (Calendar Category)

**Event Type:** `meeting_reminder`

```javascript
// n8n Function node
const startTime = new Date(event.start.dateTime);
const hoursUntil = (startTime - new Date()) / (1000 * 3600);

return {
  type: 'meeting_reminder',
  category: 'calendar',
  priority: event.attendees?.length > 5 ? 'high' : 'normal',
  tags: ['calendar', 'meeting', ...event.categories || []],
  source_workflow: 'Calendar Sync',
  data: {
    title: event.summary,
    start_time: event.start.dateTime,
    end_time: event.end.dateTime,
    location: event.location,
    attendees_count: event.attendees?.length || 0,
    hours_until: Math.round(hoursUntil),
    has_video_link: event.description?.includes('zoom') || event.description?.includes('meet')
  }
};
```

### 5.3 Generic n8n Workflow Template

Here's a reusable template for ANY event type:

**Nodes:**

1. **Trigger** (varies by source: Webhook, Schedule, IMAP, etc.)

2. **Function: Transform to Standard Format**
```javascript
// Define your event type here
const EVENT_TYPE = 'your_event_type';
const CATEGORY = 'custom'; // or communication, system, business, etc.

// Extract data from your source
const sourceData = $input.item.json;

// Determine priority based on your logic
let priority = 'normal';
if (/* your high priority condition */) {
  priority = 'high';
} else if (/* your low priority condition */) {
  priority = 'low';
}

// Build tags array
const tags = [
  'tag1',
  'tag2',
  // Add dynamic tags based on your data
];

return {
  type: EVENT_TYPE,
  category: CATEGORY,
  priority: priority,
  tags: tags,
  source_workflow: $workflow.name,
  metadata: {
    workflow_id: $workflow.id,
    execution_id: $execution.id,
    // Add any workflow-specific metadata
  },
  data: {
    // Transform sourceData into your desired structure
    // This is what the LLM will see when querying events
  }
};
```

3. **HTTP Request: Send to Webhook**
   - Method: POST
   - URL: `http://n8n-webhook:3001/n8n-ingest`
   - Headers:
     - `x-webhook-secret`: `{{ $env.N8N_WEBHOOK_SECRET }}`
     - `Content-Type`: `application/json`
   - Body: `{{ $json }}`

### 5.4 Querying Custom Event Types in coda-agent

Once events are flowing, users can query them naturally:

```
User: "What github PRs came in overnight?"
LLM: [calls n8n_query_events with types=['github_pr'], hours_back=12]

User: "Show me all high priority events from the last 24 hours"
LLM: [calls n8n_query_events with min_priority='high', hours_back=24]

User: "Any customer signups today?"
LLM: [calls n8n_query_events with types=['customer_signup'], hours_back=24]

User: "What kinds of events do I have?"
LLM: [calls n8n_list_event_types]

User: "Show me everything tagged 'urgent'"
LLM: [calls n8n_query_events with tags=['urgent']]

User: "What did the 'Server Health Monitor' workflow send?"
LLM: [calls n8n_query_events with source_workflow='Server Health Monitor']
```

### 5.5 Best Practices for Custom Event Types

1. **Naming Convention**: Use descriptive, lowercase_with_underscores
   - Good: `github_pr`, `customer_signup`, `server_alert`
   - Bad: `Event1`, `Thing`, `Notification`

2. **Categories**: Use standard categories when possible
   - `communication` - emails, messages, calls
   - `calendar` - meetings, reminders
   - `system` - alerts, metrics, logs
   - `business` - sales, signups, revenue
   - `development` - PRs, deployments, builds
   - `monitoring` - uptime, performance
   - `custom` - anything else

3. **Priority Guidelines**:
   - `high` - Requires immediate attention or action
   - `normal` - Regular information, check during daily review
   - `low` - FYI only, low urgency

4. **Tags Strategy**:
   - Include source system: `['github', ...]`, `['slack', ...]`
   - Include entity identifiers: `['server-prod-01', ...]`
   - Include status: `['open', 'closed', 'pending', ...]`
   - Include assignees/owners when relevant

5. **Data Structure**:
   - Keep flat when possible (easier for LLM to parse)
   - Use consistent field names across similar event types
   - Include timestamps in ISO 8601 format
   - Include URLs/links for drill-down

6. **Metadata Usage**:
   - Store workflow execution details
   - Store IDs for correlation with source systems
   - Don't put user-facing info here (use `data` instead)

---

## Phase 5 (continued): Morning Briefing Integration

Create this workflow in n8n:

**Workflow Name:** Email to Coda Agent

**Nodes:**

1. **Trigger: IMAP Email** (or Gmail Trigger)
   - Configure your email connection
   - Trigger on new emails in INBOX
   - Filter for unread emails

2. **Function: Process Email**
   ```javascript
   const email = $input.item.json;
   
   // Determine priority based on keywords or sender
   const highPriorityKeywords = ['urgent', 'asap', 'important', 'deadline'];
   const subject = (email.subject || '').toLowerCase();
   const isPriority = highPriorityKeywords.some(kw => subject.includes(kw));
   
   return {
     type: 'email',
     priority: isPriority ? 'high' : 'normal',
     data: {
       from: email.from?.text || email.from,
       to: email.to?.text || email.to,
       subject: email.subject,
       received_at: email.date || new Date().toISOString(),
       preview: email.text?.substring(0, 200) || '',
       has_attachments: (email.attachments?.length || 0) > 0,
       message_id: email.messageId
     }
   };
   ```

3. **HTTP Request: Send to Webhook**
   - Method: POST
   - URL: `http://n8n-webhook:3001/n8n-ingest`
   - Headers:
     - `x-webhook-secret`: `{{ $env.N8N_WEBHOOK_SECRET }}`
     - `Content-Type`: `application/json`
   - Body: `{{ $json }}`

### 5.2 Example Calendar Workflow

**Workflow Name:** Calendar Events to Coda Agent

**Nodes:**

1. **Trigger: Schedule** (run every hour)

2. **HTTP Request: Fetch Calendar** (CalDAV or Google Calendar API)

3. **Function: Process Events**
   ```javascript
   const events = $input.all();
   const now = new Date();
   const next24h = new Date(now.getTime() + 24 * 3600000);
   
   // Filter events in next 24 hours
   const upcomingEvents = events.filter(event => {
     const start = new Date(event.json.start);
     return start >= now && start <= next24h;
   });
   
   return upcomingEvents.map(event => ({
     type: 'calendar',
     priority: 'normal',
     data: {
       title: event.json.summary,
       start_time: event.json.start,
       end_time: event.json.end,
       location: event.json.location,
       description: event.json.description,
       attendees: event.json.attendees?.length || 0
     }
   }));
   ```

4. **HTTP Request: Send to Webhook** (same as email workflow)

### 5.3 Environment Variables for n8n

Add to n8n environment:

```bash
N8N_WEBHOOK_SECRET=<generate-secure-secret>
CODA_WEBHOOK_URL=http://n8n-webhook:3001/n8n-ingest
```

---

## Advanced: Custom Event Handlers

### When to Add Custom Logic

The n8n skill handles ALL event types generically by default. However, you may want to add **custom business logic** for specific event types. This is done in the `handleSpecialEventTypes()` method.

### Examples of Custom Handlers

```typescript
/**
 * Handle special event types with custom logic (extensible)
 */
private async handleSpecialEventTypes(payload: any): Promise<void> {
  
  // Example 1: Auto-escalate critical server alerts
  if (payload.type === "server_alert" && payload.data.cpu_percent > 95) {
    await this.eventBus.publish("alert.critical.server", {
      hostname: payload.data.hostname,
      cpu: payload.data.cpu_percent,
      requires_action: true
    });
  }

  // Example 2: Track deployment metrics
  if (payload.type === "deployment" || payload.type === "github_deployment") {
    // Could store in separate deployments table for analytics
    // Could update status dashboard
    // Could notify Slack channel
    await this.eventBus.publish("deployment.completed", {
      environment: payload.data.environment,
      version: payload.data.version,
      timestamp: payload.timestamp
    });
  }

  // Example 3: Customer lifecycle automation
  if (payload.type === "customer_signup") {
    if (payload.data.plan === "enterprise") {
      // Alert sales team for high-value signups
      await this.eventBus.publish("alert.sales.enterprise_signup", {
        customer_email: payload.data.email,
        plan: payload.data.plan,
        mrr: payload.data.mrr
      });
    }
  }

  // Example 4: Security event aggregation
  if (payload.category === "security" || payload.tags?.includes("security")) {
    // Could aggregate security events
    // Could trigger automated response
    // Could update security dashboard
    this.logger.warn({ event: payload }, "Security event detected");
  }

  // Example 5: Failed backup notifications
  if (payload.type === "backup_completed" && payload.data.status === "failed") {
    // Immediate alert for failed backups
    await this.eventBus.publish("alert.critical.backup_failed", {
      server: payload.data.server,
      timestamp: payload.timestamp
    });
  }

  // Example 6: SLA monitoring
  if (payload.type === "support_ticket" && payload.priority === "high") {
    const age_hours = (Date.now() - new Date(payload.data.created_at).getTime()) / 3600000;
    if (age_hours > 4) {
      await this.eventBus.publish("alert.sla.breach", {
        ticket_id: payload.data.id,
        age_hours: age_hours,
        sla_threshold: 4
      });
    }
  }
}
```

### Guidelines for Custom Handlers

1. **Keep generic handling as default** - Don't require custom handlers for every event type
2. **Use for business logic only** - Not for data transformation (do that in n8n)
3. **Publish to specific event channels** - Enable other skills to react
4. **Log important decisions** - Especially for security/compliance
5. **Fail gracefully** - Don't crash skill if custom handler fails
6. **Document event contracts** - If other systems depend on these events

### When NOT to Add Custom Handlers

- ❌ Simple data transformation → Do in n8n workflow
- ❌ Filtering events → Use tags/categories/priority
- ❌ Changing data structure → Use n8n to normalize first
- ❌ Complex calculations → Pre-compute in n8n
- ✅ **DO use for**: Cross-system orchestration, SLA monitoring, automated responses, analytics tracking

---

## Phase 7: Security Hardening

### 6.1 Webhook Secret Management

**In coda-agent `.env` file:**

```bash
# Generate with: openssl rand -base64 32
N8N_WEBHOOK_SECRET=<your-secret-here>
```

**In n8n environment variables:**

```bash
N8N_WEBHOOK_SECRET=<same-secret-as-above>
```

### 6.2 Network Security

Update `docker-compose.yml`:

```yaml
networks:
  coda-internal:
    driver: bridge
    internal: true  # No internet access

  lan-bridge:
    driver: bridge
    internal: false  # LAN access only
```

Ensure:
- n8n-webhook is on `lan-bridge` (accessible from n8n)
- n8n-webhook is on `coda-internal` (can access Redis)
- Webhook port 3001 is **not** exposed to the public internet

### 6.3 Input Validation Checklist

✅ Webhook secret validation
✅ Zod schema validation for all inputs
✅ HTML entity escaping in sanitization
✅ Rate limiting (100 req/min)
✅ Maximum event data size (handled by Fastify body limit)
✅ SQL injection prevention (parameterized queries via Drizzle)
✅ XSS prevention (ContentSanitizer wrapping)

### 6.4 Logging & Monitoring

Add structured logging for:
- All webhook requests (with auth status)
- Event bus publications
- Database insertions
- Failed validations
- Rate limit hits

**Example log entry:**

```json
{
  "level": "info",
  "time": 1234567890,
  "msg": "Event published to bus",
  "type": "email",
  "priority": "high",
  "event_channel": "n8n.email.received"
}
```

---

## Phase 8: Testing

### 7.1 Unit Tests

**File:** `src/skills/n8n/queries.test.ts`

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { N8nQueries } from "./queries";
// Mock database setup...

describe("N8nQueries", () => {
  it("should filter events by time range", async () => {
    // Test implementation
  });

  it("should filter by event type", async () => {
    // Test implementation
  });

  it("should mark events as processed", async () => {
    // Test implementation
  });
});
```

### 7.2 Integration Tests

**File:** `tests/integration/n8n-skill.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import { N8nSkill } from "../../src/skills/n8n/index";
// Integration test setup...

describe("N8n Skill Integration", () => {
  it("should receive webhook event and store in database", async () => {
    // 1. Send POST to webhook
    // 2. Verify event bus publication
    // 3. Verify database insertion
    // 4. Query via skill tool
    // 5. Verify response
  });

  it("should handle malformed webhook payloads gracefully", async () => {
    // Test error handling
  });

  it("should sanitize potentially malicious content", async () => {
    // Send payload with <script> tags, SQL injection attempts
    // Verify they are neutralized
  });
});
```

### 7.3 End-to-End Test

**Manual test procedure:**

1. Start all services: `docker compose up`
2. Send test webhook:
   ```bash
   curl -X POST http://localhost:3001/n8n-ingest \
     -H "x-webhook-secret: YOUR_SECRET" \
     -H "Content-Type: application/json" \
     -d '{
       "type": "email",
       "priority": "high",
       "data": {
         "from": "test@example.com",
         "subject": "Test Email",
         "preview": "This is a test"
       }
     }'
   ```
3. In Discord/Slack, say "morning" to coda
4. Verify the test email appears in the briefing
5. Verify event is marked as processed

---

## Phase 9: Documentation

### 8.1 User Documentation

**File:** `docs/n8n-integration.md`

Create comprehensive documentation covering:
- Overview of n8n integration
- How to configure n8n workflows
- Webhook endpoint details
- Event data schema examples
- Troubleshooting guide

### 8.2 Developer Documentation

Add to `SKILLS.md`:

```markdown
### n8n Skill

**Description:** Generic event ingestion from n8n workflows. Supports ANY custom event type without code changes.

**Supported Event Types:** Unlimited - any event type you define in n8n workflows
- Common examples: email, github_pr, slack_mention, server_alert, customer_signup, deployment, backup_status
- Create your own custom types as needed

**Tools:**
- `n8n_query_events`: Query events with flexible filtering
  - Filter by: type(s), category, tags, priority, time range, source workflow
  - Supports multiple types in one query
  - Tag-based search with AND logic
- `n8n_get_summary`: Statistical overview of events by type/category/priority/workflow
- `n8n_list_event_types`: Discover available event types in the system
- `n8n_mark_processed`: Mark events as read/processed

**Event Schema:**
```json
{
  "type": "any_custom_type",
  "category": "communication|calendar|system|business|development|monitoring|custom",
  "priority": "high|normal|low",
  "tags": ["tag1", "tag2"],
  "source_workflow": "n8n workflow name",
  "data": { /* your custom structure */ }
}
```

**Categories:**
- `communication`: Emails, messages, calls, notifications
- `calendar`: Meetings, events, reminders
- `system`: Alerts, metrics, logs, monitoring
- `business`: Sales, signups, revenue, customers
- `development`: PRs, deployments, builds, releases
- `monitoring`: Uptime, performance, health checks
- `custom`: Anything else

**Configuration:**
Optional: `n8n.webhook_secret` for webhook authentication

**Security:**
- All incoming data is sanitized with ContentSanitizer
- Rate limiting at webhook (100 req/min)
- Webhook secret authentication
- SQL injection prevention via Drizzle ORM
- Input validation with Zod schemas

**Example Queries:**
```
"What github PRs came in overnight?"
"Show me all high priority events"
"Any customer signups today?"
"What kinds of events do I have?"
"Show me everything from the Backup Monitor workflow"
```
```

---

## Deployment Checklist

### Pre-Deployment
- [ ] Database migration tested locally
- [ ] Unit tests passing
- [ ] Integration tests passing
- [ ] Docker images build successfully
- [ ] Environment variables documented
- [ ] Webhook secret generated and configured
- [ ] n8n workflows created and tested

### Deployment Steps
1. [ ] Stop coda services: `docker compose down`
2. [ ] Pull latest code
3. [ ] Run database migration: `npm run db:migrate`
4. [ ] Build images: `docker compose build`
5. [ ] Start services: `docker compose up -d`
6. [ ] Check logs: `docker compose logs -f n8n-webhook`
7. [ ] Test webhook endpoint: `curl http://localhost:3001/health`
8. [ ] Send test event from n8n
9. [ ] Verify in coda-agent: say "morning"

### Post-Deployment Monitoring
- [ ] Monitor webhook logs for errors
- [ ] Check event bus for message flow
- [ ] Verify database insertions
- [ ] Test morning briefing includes n8n data
- [ ] Monitor resource usage (memory, CPU)

---

## Maintenance & Future Enhancements

### Maintenance Tasks
- **Weekly**: Review logs for errors or anomalies
- **Monthly**: Check database size, consider archiving old processed events
- **Quarterly**: Rotate webhook secrets
- **As needed**: Update n8n workflows based on changing requirements

### Future Enhancements
1. **Event Retention Policy**: Auto-archive events older than 30 days
2. **Advanced Filtering**: Support for regex-based content filtering
3. **Two-Way Integration**: Allow coda to trigger n8n workflows
4. **Analytics Dashboard**: Visualize event volumes and types
5. **Smart Prioritization**: ML-based priority assignment
6. **Event Deduplication**: Detect and merge duplicate events

---

## Troubleshooting Guide

### Issue: Webhook Returns 401 Unauthorized
**Cause**: Webhook secret mismatch
**Solution**: Verify `N8N_WEBHOOK_SECRET` matches in both n8n and webhook service

### Issue: Events Not Appearing in Database
**Cause**: Event bus subscription not working
**Solution**: 
1. Check Redis connection
2. Verify event bus channel names match
3. Check n8n skill logs for errors

### Issue: Morning Briefing Doesn't Include n8n Data
**Cause**: LLM not calling n8n tools
**Solution**:
1. Verify skill is registered
2. Check tool definitions are correct
3. Update system prompt to explicitly mention checking n8n events

### Issue: Webhook Service Crashes
**Cause**: Unhandled errors or resource exhaustion
**Solution**:
1. Check logs for stack traces
2. Verify rate limiting is working
3. Monitor memory usage
4. Add restart policy to docker-compose

---

## Summary

This implementation provides:
✅ **Fully generic event model** - accepts ANY event type from n8n without code changes
✅ Secure webhook ingestion with authentication and rate limiting
✅ Event-driven architecture using Redis pub/sub
✅ Persistent storage in PostgreSQL with advanced indexing
✅ LLM-accessible tools for flexible querying (by type, category, tags, workflow, time)
✅ Automatic integration with morning briefing
✅ Intelligent alert routing based on priority and category
✅ Extensible custom event handlers for business logic
✅ Comprehensive security hardening (sanitization, validation, rate limiting)
✅ Extensive testing coverage (unit, integration, E2E)
✅ Production-ready deployment with Docker Compose
✅ **Future-proof** - add new event types by just updating your n8n workflows

**The Power of Generic Design:**

Traditional approach (hardcoded):
```typescript
// BAD: Need to update code for each new type
if (type === "email") { ... }
else if (type === "calendar") { ... }
else if (type === "github_pr") { ... } // New code required!
```

This implementation (generic):
```typescript
// GOOD: Works for ANY type automatically
const events = await queries.getEvents({ types: [userRequestedType] });
// Zero code changes for new event types
```

**Adding a new event type is as simple as:**
1. Create n8n workflow
2. Define your event type name (e.g., "customer_churn")
3. Send to webhook
4. Done! LLM can now query it

The architecture is extensible, allowing easy addition of new event types and n8n workflows without modifying the core coda-agent code. The LLM naturally adapts to new event types through the flexible query interface.
