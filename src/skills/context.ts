/**
 * Public SDK contract: the stable API through which skills access coda services.
 * External skills never import coda internals directly.
 */
import type { Logger } from "../utils/logger.js";
import type { EventBus } from "../core/events.js";
import type { Database } from "../db/index.js";
import type { MessageSender } from "../core/message-sender.js";

/**
 * A Redis-like client interface that auto-prefixes keys with the skill name.
 * Provided to skills so they can cache data without key collisions.
 */
export interface SkillRedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttl?: number): Promise<void>;
  del(key: string): Promise<void>;
}

/**
 * Client interface for registering scheduled tasks from a skill.
 * Task names are auto-prefixed with the skill name (e.g., "poll" → "email.poll").
 */
export interface TaskSchedulerClient {
  registerTask(task: ScheduledTaskDef): void;
  removeTask(taskName: string): void;
}

export interface ScheduledTaskDef {
  name: string;
  cronExpression: string;
  handler: () => Promise<void>;
  enabled?: boolean;
  description?: string;
}

/**
 * Context injected into every skill at startup.
 * This is the stable API through which skills access coda services.
 */
export interface SkillContext {
  /** Skill-specific config section from config.yaml. */
  config: Record<string, unknown>;

  /** Namespaced pino child logger (e.g., "coda:email"). */
  logger: Logger;

  /** Redis client with auto-prefixed keys. */
  redis: SkillRedisClient;

  /** Event bus for publishing and subscribing to events. */
  eventBus: EventBus;

  /** Database access for persistent storage (e.g. OAuth tokens). */
  db: Database;

  /** Optional scheduler client for registering cron-based tasks. */
  scheduler?: TaskSchedulerClient;

  /** Optional LLM access for skills that need to call the LLM directly. */
  llm?: {
    chat(params: {
      system: string;
      messages: Array<{ role: "user" | "assistant"; content: string }>;
      maxTokens?: number;
    }): Promise<{ text: string | null }>;
  };

  /**
   * Optional Opus-tier LLM access — only injected for privileged skills
   * (e.g., self-improvement weekly reflection). Uses the same chat() interface.
   * Falls back to regular llm if not injected.
   */
  opusLlm?: {
    chat(params: {
      system: string;
      messages: Array<{ role: "user" | "assistant"; content: string }>;
      maxTokens?: number;
    }): Promise<{ text: string | null }>;
  };

  /** Optional conversation history access for summarization and analysis. */
  conversations?: {
    getHistory(userId: string): Promise<Array<{ role: string; content: string; timestamp: number }>>;
    getAllHistories(): Map<string, Array<{ role: string; content: string; channel: string; timestamp: number }>>;
  };

  /**
   * Optional proactive message sender — lets skills push messages without
   * waiting for a user request. Rate-limited (10/hr per channel by default).
   * Only channels registered at startup are eligible.
   */
  messageSender?: MessageSender;
}
