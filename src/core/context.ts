import type { LLMMessage } from "./llm/provider.js";
import type { Logger } from "../utils/logger.js";
import { RETENTION } from "../utils/retention.js";

interface StoredMessage {
  role: "user" | "assistant";
  content: string;
  channel: string;
  timestamp: number;
}

interface ContextFact {
  key: string;
  value: string;
  category: string;
  updatedAt: number;
}

/**
 * Manages conversation context: short-term history (in-memory for Phase 1)
 * and long-term facts.
 *
 * Phase 2+ replaces in-memory storage with Redis (history) and Postgres (facts).
 */
export class ContextStore {
  private history: Map<string, StoredMessage[]> = new Map();
  private facts: Map<string, ContextFact[]> = new Map();
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /** Get conversation history for a user, optionally filtered by channel. */
  async getHistory(
    userId: string,
    channel?: string
  ): Promise<LLMMessage[]> {
    const messages = this.history.get(userId) ?? [];

    // Optionally filter by channel
    const filtered = channel
      ? messages.filter((m) => m.channel === channel)
      : messages;

    // Prune expired messages (older than 24h)
    const now = Date.now();
    const cutoff = now - RETENTION.CONVERSATION_HISTORY * 1000;
    const valid = filtered.filter((m) => m.timestamp > cutoff);

    return valid.map((m) => ({
      role: m.role,
      content: m.content,
    }));
  }

  /** Save a message exchange to conversation history. */
  async save(
    userId: string,
    channel: string,
    userMessage: string,
    assistantResponse: { text: string | null }
  ): Promise<void> {
    const messages = this.history.get(userId) ?? [];
    const now = Date.now();

    messages.push({
      role: "user",
      content: userMessage,
      channel,
      timestamp: now,
    });

    if (assistantResponse.text) {
      messages.push({
        role: "assistant",
        content: assistantResponse.text,
        channel,
        timestamp: now,
      });
    }

    // Keep only the latest N messages
    const trimmed = messages.slice(-RETENTION.MAX_CONVERSATION_MESSAGES);
    this.history.set(userId, trimmed);

    this.logger.debug(
      { userId, channel, messageCount: trimmed.length },
      "Context saved"
    );
  }

  /** Get long-term facts for a user. */
  async getFacts(userId: string): Promise<ContextFact[]> {
    return this.facts.get(userId) ?? [];
  }

  /** Save a long-term fact for a user. */
  async saveFact(
    userId: string,
    key: string,
    value: string,
    category: string = "general"
  ): Promise<void> {
    const userFacts = this.facts.get(userId) ?? [];
    const existing = userFacts.findIndex((f) => f.key === key);

    const fact: ContextFact = {
      key,
      value,
      category,
      updatedAt: Date.now(),
    };

    if (existing >= 0) {
      userFacts[existing] = fact;
    } else {
      userFacts.push(fact);
    }

    this.facts.set(userId, userFacts);
  }

  /** Delete a specific fact for a user. */
  async deleteFact(userId: string, key: string): Promise<boolean> {
    const userFacts = this.facts.get(userId) ?? [];
    const index = userFacts.findIndex((f) => f.key === key);
    if (index >= 0) {
      userFacts.splice(index, 1);
      this.facts.set(userId, userFacts);
      return true;
    }
    return false;
  }

  /** Export all data for a user (privacy compliance). */
  async exportUserData(
    userId: string
  ): Promise<{ history: StoredMessage[]; facts: ContextFact[] }> {
    return {
      history: this.history.get(userId) ?? [],
      facts: this.facts.get(userId) ?? [],
    };
  }

  /** Delete all data for a user (privacy compliance). */
  async deleteUserData(userId: string): Promise<void> {
    this.history.delete(userId);
    this.facts.delete(userId);
  }
}
