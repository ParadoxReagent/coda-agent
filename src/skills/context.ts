/**
 * Public SDK contract: the stable API through which skills access coda services.
 * External skills never import coda internals directly.
 */
import type { Logger } from "../utils/logger.js";
import type { EventBus } from "../core/events.js";

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
}
