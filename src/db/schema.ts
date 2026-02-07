import {
  pgTable,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  serial,
  varchar,
  index,
  uuid,
  uniqueIndex,
  customType,
} from "drizzle-orm/pg-core";

/** Custom tsvector type for PostgreSQL full-text search. */
const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

/** Conversation history for medium/long-term storage. */
export const conversations = pgTable(
  "conversations",
  {
    id: serial("id").primaryKey(),
    userId: varchar("user_id", { length: 255 }).notNull(),
    channel: varchar("channel", { length: 50 }).notNull(),
    role: varchar("role", { length: 20 }).notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("conv_user_channel_idx").on(table.userId, table.channel),
    index("conv_created_at_idx").on(table.createdAt),
  ]
);

/** Long-term extracted facts per user. */
export const contextFacts = pgTable(
  "context_facts",
  {
    id: serial("id").primaryKey(),
    userId: varchar("user_id", { length: 255 }).notNull(),
    key: varchar("key", { length: 255 }).notNull(),
    value: text("value").notNull(),
    category: varchar("category", { length: 100 }).default("general").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("facts_user_idx").on(table.userId),
    index("facts_user_key_idx").on(table.userId, table.key),
  ]
);

/** Per-skill configuration and runtime state. */
export const skillsConfig = pgTable("skills_config", {
  id: serial("id").primaryKey(),
  skillName: varchar("skill_name", { length: 100 }).notNull().unique(),
  config: jsonb("config").default({}).notNull(),
  state: jsonb("state").default({}).notNull(),
  enabled: integer("enabled").default(1).notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/** LLM token usage tracking per provider/model/day. */
export const llmUsage = pgTable(
  "llm_usage",
  {
    id: serial("id").primaryKey(),
    provider: varchar("provider", { length: 100 }).notNull(),
    model: varchar("model", { length: 255 }).notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    estimatedCost: integer("estimated_cost_microcents"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("usage_provider_model_idx").on(table.provider, table.model),
    index("usage_created_at_idx").on(table.createdAt),
  ]
);

/** Reminders for the user. */
export const reminders = pgTable(
  "reminders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: varchar("user_id", { length: 255 }).notNull(),
    title: varchar("title", { length: 500 }).notNull(),
    description: text("description"),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    recurring: varchar("recurring", { length: 100 }),
    status: varchar("status", { length: 20 }).default("pending").notNull(),
    channel: varchar("channel", { length: 50 }),
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    completedAt: timestamp("completed_at"),
  },
  (table) => [
    index("reminders_user_status_due_idx").on(
      table.userId,
      table.status,
      table.dueAt
    ),
  ]
);

/** User notes with full-text search support. */
export const notes = pgTable(
  "notes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: varchar("user_id", { length: 255 }).notNull(),
    title: varchar("title", { length: 500 }),
    content: text("content").notNull(),
    tags: text("tags").array().default([]).notNull(),
    searchVector: tsvector("search_vector"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("notes_user_idx").on(table.userId),
    index("notes_tags_idx").on(table.tags),
  ]
);

/** Known network clients (for UniFi monitoring). */
export const knownClients = pgTable(
  "known_clients",
  {
    mac: varchar("mac", { length: 17 }).primaryKey(),
    hostname: varchar("hostname", { length: 255 }),
    friendlyName: varchar("friendly_name", { length: 255 }),
    ipAddress: varchar("ip_address", { length: 45 }),
    firstSeen: timestamp("first_seen").defaultNow().notNull(),
    lastSeen: timestamp("last_seen").defaultNow().notNull(),
    isKnown: integer("is_known").default(0).notNull(),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("known_clients_is_known_idx").on(table.isKnown),
    index("known_clients_last_seen_idx").on(table.lastSeen),
  ]
);

/** Alert history for tracking delivered and suppressed alerts. */
export const alertHistory = pgTable(
  "alert_history",
  {
    id: serial("id").primaryKey(),
    eventId: varchar("event_id", { length: 36 }).notNull(),
    eventType: varchar("event_type", { length: 255 }).notNull(),
    severity: varchar("severity", { length: 20 }).notNull(),
    sourceSkill: varchar("source_skill", { length: 100 }).notNull(),
    channel: varchar("channel", { length: 50 }),
    payload: jsonb("payload"),
    formattedMessage: text("formatted_message"),
    delivered: integer("delivered").default(0).notNull(),
    suppressed: integer("suppressed").default(0).notNull(),
    suppressionReason: varchar("suppression_reason", { length: 255 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("alert_history_event_type_idx").on(table.eventType),
    index("alert_history_created_at_idx").on(table.createdAt),
    index("alert_history_event_id_idx").on(table.eventId),
  ]
);

/** OAuth tokens for external service authentication. */
export const oauthTokens = pgTable(
  "oauth_tokens",
  {
    id: serial("id").primaryKey(),
    service: varchar("service", { length: 50 }).notNull(),
    userId: varchar("user_id", { length: 255 }).notNull(),
    accessToken: text("access_token").notNull(),
    refreshToken: text("refresh_token").notNull(),
    tokenType: varchar("token_type", { length: 50 }).default("Bearer").notNull(),
    expiryDate: timestamp("expiry_date", { withTimezone: true }).notNull(),
    scope: text("scope").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("oauth_tokens_service_user_idx").on(table.service, table.userId),
  ]
);

/** n8n workflow events ingested via webhook — supports any event type. */
export const n8nEvents = pgTable(
  "n8n_events",
  {
    id: serial("id").primaryKey(),
    type: varchar("type", { length: 100 }).notNull(),
    category: varchar("category", { length: 50 }),
    priority: varchar("priority", { length: 20 }).notNull(),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
    data: jsonb("data").notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    tags: text("tags").array().default([]).notNull(),
    sourceWorkflow: varchar("source_workflow", { length: 255 }),
    processed: boolean("processed").default(false).notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("n8n_events_type_idx").on(table.type),
    index("n8n_events_category_idx").on(table.category),
    index("n8n_events_timestamp_idx").on(table.timestamp),
    index("n8n_events_processed_idx").on(table.processed),
    index("n8n_events_priority_timestamp_idx").on(table.priority, table.timestamp),
    index("n8n_events_tags_idx").on(table.tags),
  ]
);
