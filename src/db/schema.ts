import {
  pgTable,
  text,
  timestamp,
  integer,
  jsonb,
  serial,
  varchar,
  index,
} from "drizzle-orm/pg-core";

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
