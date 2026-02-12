/**
 * Retention TTL constants used across all schema definitions and Redis operations.
 * All values are in seconds unless otherwise noted.
 * Centralizes retention policy for auditability.
 */
export const RETENTION = {
  /** Conversation message history in Redis (24 hours) */
  CONVERSATION_HISTORY: 24 * 60 * 60,

  /** Conversation daily summaries in Redis (30 days) */
  CONVERSATION_SUMMARY: 30 * 24 * 60 * 60,

  /** Email cache in Redis (24 hours) */
  EMAIL_CACHE: 24 * 60 * 60,

  /** Context facts in Postgres — default 1 year, configurable per fact */
  CONTEXT_FACTS: 365 * 24 * 60 * 60,

  /** LLM usage records in Postgres (90 days) */
  LLM_USAGE: 90 * 24 * 60 * 60,

  /** Alert cooldown in Redis (5 minutes) */
  ALERT_COOLDOWN: 5 * 60,

  /** Confirmation token TTL in Redis (5 minutes) */
  CONFIRMATION_TOKEN: 5 * 60,

  /** Max conversation messages per user in Redis */
  MAX_CONVERSATION_MESSAGES: 50,

  /** Reminder check interval in seconds (1 minute) */
  REMINDER_CHECK_INTERVAL: 60,

  /** Morning briefing cache TTL in seconds (1 hour) */
  BRIEFING_CACHE: 3600,

  /** Calendar event cache TTL in seconds (15 minutes) */
  CALENDAR_CACHE: 900,

  /** Max length of the Redis event stream (MAXLEN ~) */
  EVENT_STREAM_MAX_LEN: 10_000,

  /** Idempotency key TTL in seconds (24 hours) */
  IDEMPOTENCY_KEY_TTL: 86_400,

  /** Alert history retention in seconds (90 days) */
  ALERT_HISTORY_RETENTION: 7_776_000,

  /** Traffic baseline window in seconds (24 hours) */
  TRAFFIC_BASELINE_WINDOW: 86_400,

  /** Traffic baseline data retention in seconds (7 days) */
  TRAFFIC_BASELINE_DATA: 604_800,

  /** Memory context cache TTL in seconds (5 minutes) */
  MEMORY_CONTEXT_CACHE: 300,

  /** Subagent archive TTL in seconds (60 minutes) — after completion, result stays in-memory */
  SUBAGENT_ARCHIVE_TTL: 3_600,

  /** Max transcript entries stored per subagent run */
  SUBAGENT_MAX_TRANSCRIPT_ENTRIES: 100,

  /** Subagent run DB row retention in seconds (30 days) */
  SUBAGENT_RUN_RETENTION: 30 * 24 * 60 * 60,
} as const;
