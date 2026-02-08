import { generateConfirmationToken } from "../utils/crypto.js";
import { RETENTION } from "../utils/retention.js";
import type { Logger } from "../utils/logger.js";
import type { EventBus } from "./events.js";

interface PendingAction {
  token: string;
  userId: string;
  skillName: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  description: string;
  expiresAt: number;
}

const ABUSE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const ABUSE_THRESHOLD = 10;

/**
 * Manages confirmation tokens for destructive actions.
 * Phase 1: in-memory storage. Phase 2+: Redis-backed with TTL.
 * Includes abuse detection for repeated invalid attempts.
 */
export class ConfirmationManager {
  private pendingActions: Map<string, PendingAction> = new Map();
  private logger: Logger;
  private eventBus?: EventBus;
  private invalidAttempts: Map<string, number[]> = new Map();

  constructor(logger: Logger, eventBus?: EventBus) {
    this.logger = logger;
    this.eventBus = eventBus;
  }

  /** Create a confirmation token for a pending destructive action. */
  createConfirmation(
    userId: string,
    skillName: string,
    toolName: string,
    toolInput: Record<string, unknown>,
    description: string
  ): string {
    const token = generateConfirmationToken();
    const expiresAt =
      Date.now() + RETENTION.CONFIRMATION_TOKEN * 1000;

    this.pendingActions.set(token, {
      token,
      userId,
      skillName,
      toolName,
      toolInput,
      description,
      expiresAt,
    });

    this.logger.debug(
      { userId, skillName, toolName },
      "Confirmation token created"
    );

    return token;
  }

  /** Validate and consume a confirmation token. Returns the pending action if valid. */
  consumeConfirmation(
    token: string,
    userId: string
  ): PendingAction | null {
    // Check abuse rate limit
    if (this.isAbusive(userId)) {
      this.logger.warn({ userId }, "Confirmation abuse threshold exceeded");
      return null;
    }

    const action = this.pendingActions.get(token);

    if (!action) {
      this.recordInvalidAttempt(userId);
      this.logger.debug({ token: token.slice(0, 4) + "..." }, "Invalid confirmation token");
      return null;
    }

    // Check expiry
    if (Date.now() > action.expiresAt) {
      this.pendingActions.delete(token);
      this.recordInvalidAttempt(userId);
      this.logger.debug(
        { userId, toolName: action.toolName },
        "Confirmation token expired"
      );
      return null;
    }

    // Check user scope
    if (action.userId !== userId) {
      this.recordInvalidAttempt(userId);
      this.logger.warn(
        { requestedBy: userId, ownedBy: action.userId },
        "Confirmation token user mismatch"
      );
      return null;
    }

    // Single-use: delete immediately
    this.pendingActions.delete(token);

    this.logger.debug(
      { userId, toolName: action.toolName },
      "Confirmation token consumed"
    );

    return action;
  }

  private recordInvalidAttempt(userId: string): void {
    const now = Date.now();
    let attempts = this.invalidAttempts.get(userId) ?? [];
    attempts = attempts.filter((t) => now - t < ABUSE_WINDOW_MS);
    attempts.push(now);
    this.invalidAttempts.set(userId, attempts);

    if (attempts.length >= ABUSE_THRESHOLD && this.eventBus) {
      this.eventBus.publish({
        eventType: "alert.system.abuse",
        timestamp: new Date().toISOString(),
        sourceSkill: "confirmation",
        payload: {
          userId,
          attempts: attempts.length,
          windowMinutes: ABUSE_WINDOW_MS / 60000,
        },
        severity: "high",
      }).catch((e) => {
        this.logger.error({ error: e }, "Failed to publish abuse alert");
      });
    }
  }

  private isAbusive(userId: string): boolean {
    const now = Date.now();
    const attempts = this.invalidAttempts.get(userId) ?? [];
    const recentAttempts = attempts.filter((t) => now - t < ABUSE_WINDOW_MS);
    return recentAttempts.length >= ABUSE_THRESHOLD;
  }

  /** Check if a message is a confirmation attempt. */
  isConfirmationMessage(message: string): string | null {
    const match = message.trim().match(/^confirm\s+([A-Z2-7]+)$/i);
    return match?.[1] ?? null;
  }

  /** Clean up expired tokens (called periodically). */
  cleanup(): void {
    const now = Date.now();
    for (const [token, action] of this.pendingActions) {
      if (now > action.expiresAt) {
        this.pendingActions.delete(token);
      }
    }
  }
}
