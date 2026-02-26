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
  real,
} from "drizzle-orm/pg-core";

/** Custom tsvector type for PostgreSQL full-text search. */
const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

/** Custom vector type for pgvector embeddings. */
const vector = customType<{ data: string }>({
  dataType() {
    return "vector(384)";
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

/** User preferences for DND, quiet hours, alerts. */
export const userPreferences = pgTable(
  "user_preferences",
  {
    id: serial("id").primaryKey(),
    userId: varchar("user_id", { length: 255 }).notNull().unique(),
    dndEnabled: boolean("dnd_enabled").default(false).notNull(),
    alertsOnly: boolean("alerts_only").default(false).notNull(),
    quietHoursStart: varchar("quiet_hours_start", { length: 5 }),
    quietHoursEnd: varchar("quiet_hours_end", { length: 5 }),
    timezone: varchar("timezone", { length: 100 }).default("America/New_York").notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("user_prefs_user_id_idx").on(table.userId),
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

/** Subagent run records for tracking lifecycle and audit. */
export const subagentRuns = pgTable(
  "subagent_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: varchar("user_id", { length: 255 }).notNull(),
    channel: varchar("channel", { length: 50 }).notNull(),
    parentRunId: uuid("parent_run_id"),
    task: text("task").notNull(),
    status: varchar("status", { length: 20 }).default("accepted").notNull(),
    mode: varchar("mode", { length: 10 }).default("async").notNull(),
    model: varchar("model", { length: 255 }),
    provider: varchar("provider", { length: 100 }),
    result: text("result"),
    error: text("error"),
    inputTokens: integer("input_tokens").default(0).notNull(),
    outputTokens: integer("output_tokens").default(0).notNull(),
    toolCallCount: integer("tool_call_count").default(0).notNull(),
    timeoutMs: integer("timeout_ms").notNull(),
    transcript: jsonb("transcript").default([]).notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    allowedTools: text("allowed_tools").array(),
    blockedTools: text("blocked_tools").array(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => [
    index("subagent_runs_user_status_idx").on(table.userId, table.status),
    index("subagent_runs_created_at_idx").on(table.createdAt),
    index("subagent_runs_status_idx").on(table.status),
    index("subagent_runs_parent_run_id_idx").on(table.parentRunId),
  ]
);

/** Structured audit trail for every tool call and significant system event. */
export const auditLog = pgTable(
  "audit_log",
  {
    id: serial("id").primaryKey(),
    correlationId: varchar("correlation_id", { length: 36 }),
    userId: varchar("user_id", { length: 255 }),
    channel: varchar("channel", { length: 50 }),
    eventType: varchar("event_type", { length: 100 }).notNull(),
    skillName: varchar("skill_name", { length: 100 }),
    toolName: varchar("tool_name", { length: 255 }),
    /** JSON key names only — never values — for sensitive tools. */
    inputSummary: text("input_summary"),
    durationMs: integer("duration_ms"),
    status: varchar("status", { length: 20 }).notNull(),
    tier: varchar("tier", { length: 20 }),
    model: varchar("model", { length: 255 }),
    provider: varchar("provider", { length: 100 }),
    permissionTier: integer("permission_tier"),
    metadata: jsonb("metadata").default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("audit_log_correlation_id_idx").on(table.correlationId),
    index("audit_log_user_id_idx").on(table.userId),
    index("audit_log_event_type_idx").on(table.eventType),
    index("audit_log_tool_name_idx").on(table.toolName),
    index("audit_log_created_at_idx").on(table.createdAt),
    index("audit_log_status_idx").on(table.status),
  ]
);

/** Multi-step successful resolutions for few-shot retrieval. */
export const solutionPatterns = pgTable(
  "solution_patterns",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    title: varchar("title", { length: 500 }).notNull(),
    taskType: varchar("task_type", { length: 100 }),
    problemDescription: text("problem_description").notNull(),
    resolutionSteps: jsonb("resolution_steps").notNull(),
    toolsUsed: text("tools_used").array().default([]).notNull(),
    outcome: varchar("outcome", { length: 50 }).default("success").notNull(),
    sourceMemoryId: uuid("source_memory_id"),
    embedding: vector("embedding"),
    tags: text("tags").array().default([]).notNull(),
    retrievalCount: integer("retrieval_count").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("solution_patterns_task_type_idx").on(table.taskType),
    index("solution_patterns_tags_idx").on(table.tags),
    index("solution_patterns_created_at_idx").on(table.createdAt),
  ]
);

/** Routing decision log for observability and future self-improvement. */
export const routingDecisions = pgTable(
  "routing_decisions",
  {
    id: serial("id").primaryKey(),
    sessionId: varchar("session_id", { length: 36 }),
    correlationId: varchar("correlation_id", { length: 36 }),
    userId: varchar("user_id", { length: 255 }),
    channel: varchar("channel", { length: 50 }),
    taskType: varchar("task_type", { length: 100 }),
    modelChosen: varchar("model_chosen", { length: 255 }).notNull(),
    provider: varchar("provider", { length: 100 }),
    tier: varchar("tier", { length: 20 }).notNull(),
    rationale: text("rationale"),
    inputComplexityScore: real("input_complexity_score"),
    latencyMs: integer("latency_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("routing_decisions_user_id_idx").on(table.userId),
    index("routing_decisions_tier_idx").on(table.tier),
    index("routing_decisions_created_at_idx").on(table.createdAt),
    index("routing_decisions_correlation_id_idx").on(table.correlationId),
  ]
);

/** Self-assessment scores for agent turns. Populated after each tool-using turn. */
export const selfAssessments = pgTable(
  "self_assessments",
  {
    id: serial("id").primaryKey(),
    correlationId: varchar("correlation_id", { length: 36 }),
    userId: varchar("user_id", { length: 255 }),
    channel: varchar("channel", { length: 50 }),
    taskCompleted: boolean("task_completed"),
    toolFailureCount: integer("tool_failure_count").default(0),
    fallbackUsed: boolean("fallback_used").default(false),
    tierUsed: varchar("tier_used", { length: 20 }),
    modelUsed: varchar("model_used", { length: 255 }),
    toolCallCount: integer("tool_call_count").default(0),
    selfScore: real("self_score"),
    assessmentSummary: text("assessment_summary"),
    failureModes: jsonb("failure_modes").default([]),
    metadata: jsonb("metadata").default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("self_assessments_correlation_id_idx").on(table.correlationId),
    index("self_assessments_user_id_idx").on(table.userId),
    index("self_assessments_created_at_idx").on(table.createdAt),
    index("self_assessments_self_score_idx").on(table.selfScore),
  ]
);

/** Improvement proposals generated by weekly Opus reflection cycles. */
export const improvementProposals = pgTable(
  "improvement_proposals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    cycleId: uuid("cycle_id"),
    category: varchar("category", { length: 50 }).notNull(),
    title: varchar("title", { length: 500 }).notNull(),
    description: text("description").notNull(),
    proposedDiff: text("proposed_diff"),
    targetSection: varchar("target_section", { length: 100 }),
    priority: integer("priority").default(5),
    status: varchar("status", { length: 20 }).default("pending").notNull(),
    userDecision: varchar("user_decision", { length: 20 }),
    userFeedback: text("user_feedback"),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    metadata: jsonb("metadata").default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("improvement_proposals_status_idx").on(table.status),
    index("improvement_proposals_created_at_idx").on(table.createdAt),
    index("improvement_proposals_cycle_id_idx").on(table.cycleId),
  ]
);

/** Version-controlled prompt sections with A/B testing support. */
export const promptVersions = pgTable(
  "prompt_versions",
  {
    id: serial("id").primaryKey(),
    sectionName: varchar("section_name", { length: 100 }).notNull(),
    content: text("content").notNull(),
    version: integer("version").notNull(),
    isActive: boolean("is_active").default(false).notNull(),
    isAbVariant: boolean("is_ab_variant").default(false).notNull(),
    abWeight: real("ab_weight").default(0.5),
    sourceProposalId: uuid("source_proposal_id"),
    performanceScore: real("performance_score"),
    sampleCount: integer("sample_count").default(0),
    createdBy: varchar("created_by", { length: 50 }).default("system"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("prompt_versions_section_version_idx").on(table.sectionName, table.version),
    index("prompt_versions_section_active_idx").on(table.sectionName, table.isActive),
  ]
);

/** Persistent multi-day task state with checkpointing. */
export const taskState = pgTable(
  "task_state",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: varchar("user_id", { length: 255 }).notNull(),
    channel: varchar("channel", { length: 50 }).notNull(),
    workspaceId: varchar("workspace_id", { length: 255 }),
    goal: text("goal").notNull(),
    steps: jsonb("steps").default([]).notNull(),
    currentStep: integer("current_step").default(0),
    status: varchar("status", { length: 20 }).default("active").notNull(),
    blockers: jsonb("blockers").default([]),
    nextActionAt: timestamp("next_action_at", { withTimezone: true }),
    result: text("result"),
    metadata: jsonb("metadata").default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("task_state_user_status_idx").on(table.userId, table.status),
    index("task_state_status_next_action_idx").on(table.status, table.nextActionAt),
    index("task_state_created_at_idx").on(table.createdAt),
  ]
);

/** Self-improvement execution run records. */
export const selfImprovementRuns = pgTable(
  "self_improvement_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    proposalId: uuid("proposal_id").references(() => improvementProposals.id),
    outcome: varchar("outcome", { length: 20 }).notNull(),
    branchName: varchar("branch_name", { length: 255 }),
    prUrl: varchar("pr_url", { length: 500 }),
    targetFiles: jsonb("target_files").default([]),
    steps: jsonb("steps").default([]),
    blastRadius: jsonb("blast_radius").default({}),
    narrative: text("narrative"),
    error: text("error"),
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_sir_proposal").on(table.proposalId),
    index("idx_sir_outcome").on(table.outcome),
    index("idx_sir_created").on(table.createdAt),
  ]
);

/** Semantic memory store with vector embeddings for similarity search. */
export const memories = pgTable(
  "memories",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    content: text("content").notNull(),
    contentType: varchar("content_type", { length: 50 }).notNull(),
    embedding: vector("embedding"),
    sourceType: varchar("source_type", { length: 50 }).default("manual"),
    sourceId: varchar("source_id", { length: 255 }),
    importance: real("importance").default(0.5),
    tags: text("tags").array().default([]).notNull(),
    metadata: jsonb("metadata").default({}),
    contentHash: varchar("content_hash", { length: 64 }),
    accessCount: integer("access_count").default(0),
    accessedAt: timestamp("accessed_at", { withTimezone: true }),
    isArchived: boolean("is_archived").default(false).notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    searchVector: tsvector("search_vector"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("memories_content_type_idx").on(table.contentType),
    index("memories_created_at_idx").on(table.createdAt),
    index("memories_importance_idx").on(table.importance),
    index("memories_tags_idx").on(table.tags),
    index("memories_source_type_idx").on(table.sourceType),
  ]
);
