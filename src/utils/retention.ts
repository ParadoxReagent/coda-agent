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
} as const;
