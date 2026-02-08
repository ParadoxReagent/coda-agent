/**
 * Sliding window rate limiter using Redis sorted sets.
 * Falls back to in-memory Map when Redis is unavailable.
 */
import type Redis from "ioredis";
import type { Logger } from "../utils/logger.js";

export interface RateLimitConfig {
  maxRequests: number;
  windowSeconds: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds?: number;
}

export class RateLimiter {
  private redis: Redis | null;
  private logger: Logger;
  private inMemory: Map<string, number[]> = new Map();

  constructor(redis: Redis | null, logger: Logger) {
    this.redis = redis;
    this.logger = logger;
  }

  async check(
    scope: string,
    identifier: string,
    config: RateLimitConfig
  ): Promise<RateLimitResult> {
    const key = `ratelimit:${scope}:${identifier}`;
    const now = Date.now();
    const windowStart = now - config.windowSeconds * 1000;

    if (this.redis) {
      try {
        return await this.checkRedis(key, now, windowStart, config);
      } catch (err) {
        this.logger.debug(
          { error: err },
          "Redis rate limit check failed, falling back to in-memory"
        );
      }
    }

    return this.checkInMemory(key, now, windowStart, config);
  }

  private async checkRedis(
    key: string,
    now: number,
    windowStart: number,
    config: RateLimitConfig
  ): Promise<RateLimitResult> {
    const redis = this.redis!;
    const pipeline = redis.pipeline();

    // Remove entries outside the window
    pipeline.zremrangebyscore(key, 0, windowStart);
    // Add current request
    pipeline.zadd(key, now.toString(), `${now}:${Math.random()}`);
    // Count entries in window
    pipeline.zcard(key);
    // Set TTL for cleanup
    pipeline.expire(key, config.windowSeconds);

    const results = await pipeline.exec();
    const count = (results?.[2]?.[1] as number) ?? 0;

    if (count > config.maxRequests) {
      // Get the oldest entry to calculate retry-after
      const oldest = await redis.zrange(key, 0, 0, "WITHSCORES");
      const oldestTime = oldest[1] ? parseInt(oldest[1], 10) : now;
      const retryAfterSeconds = Math.ceil(
        (oldestTime + config.windowSeconds * 1000 - now) / 1000
      );

      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, retryAfterSeconds),
      };
    }

    return {
      allowed: true,
      remaining: config.maxRequests - count,
    };
  }

  private checkInMemory(
    key: string,
    now: number,
    windowStart: number,
    config: RateLimitConfig
  ): RateLimitResult {
    let timestamps = this.inMemory.get(key) ?? [];

    // Purge old entries
    timestamps = timestamps.filter((t) => t > windowStart);
    timestamps.push(now);
    this.inMemory.set(key, timestamps);

    if (timestamps.length > config.maxRequests) {
      const oldest = timestamps[0] ?? now;
      const retryAfterSeconds = Math.ceil(
        (oldest + config.windowSeconds * 1000 - now) / 1000
      );

      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, retryAfterSeconds),
      };
    }

    return {
      allowed: true,
      remaining: config.maxRequests - timestamps.length,
    };
  }
}
