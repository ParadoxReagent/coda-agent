import { generateConfirmationToken } from "../utils/crypto.js";
import { RETENTION } from "../utils/retention.js";
import type { Logger } from "../utils/logger.js";

interface PendingAction {
  token: string;
  userId: string;
  skillName: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  description: string;
  expiresAt: number;
}

/**
 * Manages confirmation tokens for destructive actions.
 * Phase 1: in-memory storage. Phase 2+: Redis-backed with TTL.
 */
export class ConfirmationManager {
  private pendingActions: Map<string, PendingAction> = new Map();
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
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
    const action = this.pendingActions.get(token);

    if (!action) {
      this.logger.debug({ token: token.slice(0, 4) + "..." }, "Invalid confirmation token");
      return null;
    }

    // Check expiry
    if (Date.now() > action.expiresAt) {
      this.pendingActions.delete(token);
      this.logger.debug(
        { userId, toolName: action.toolName },
        "Confirmation token expired"
      );
      return null;
    }

    // Check user scope
    if (action.userId !== userId) {
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
