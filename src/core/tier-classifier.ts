import type { TierConfig } from "../utils/config.js";
import type { LearnedTierClassifier } from "./learned-classifier.js";

export interface TierClassification {
  tier: "light" | "heavy";
  reason: string;
}

/**
 * TierClassifier: Determines which LLM tier (light or heavy) to use.
 *
 * - Light tier: fast/cheap models for simple requests (notes, reminders, lookups)
 * - Heavy tier: capable models for complex tasks (research, analysis, subagent spawning)
 *
 * Approach:
 * 1. Check learned classifier first (if confidence > 0.7, use it)
 * 2. Heuristic pre-filter catches obvious complex requests (keywords, message length)
 * 3. If light model calls a "heavy" tool, system escalates to heavy tier mid-turn
 */
export class TierClassifier {
  private heavyTools: Set<string>;
  private heavyPatterns: RegExp[];
  private heavyMessageLength: number;
  private learnedClassifier?: LearnedTierClassifier;

  constructor(config: TierConfig) {
    this.heavyTools = new Set(config.heavy_tools);
    this.heavyPatterns = config.heavy_patterns.map(
      (pattern) => new RegExp(pattern, "i")
    );
    this.heavyMessageLength = config.heavy_message_length;
  }

  /** Wire in the learned classifier (called after retrain). */
  setLearnedClassifier(lc: LearnedTierClassifier): void {
    this.learnedClassifier = lc;
  }

  /**
   * Classify a message to determine initial tier.
   * Returns "heavy" if the message matches heavy patterns or exceeds length threshold.
   * Otherwise returns "light".
   */
  classifyMessage(message: string): TierClassification {
    // 1. Check learned classifier first (confidence threshold: 0.7)
    if (this.learnedClassifier) {
      const learned = this.learnedClassifier.classify(message);
      if (learned) {
        return { tier: learned.tier, reason: learned.reason };
      }
    }

    // 2. Check message length
    if (message.length > this.heavyMessageLength) {
      return {
        tier: "heavy",
        reason: `Message length (${message.length} chars) exceeds threshold (${this.heavyMessageLength})`,
      };
    }

    // 3. Check for heavy patterns
    for (const pattern of this.heavyPatterns) {
      if (pattern.test(message)) {
        return {
          tier: "heavy",
          reason: `Message matches heavy pattern: ${pattern.source}`,
        };
      }
    }

    // Default to light
    return {
      tier: "light",
      reason: "Simple request, using light tier",
    };
  }

  /**
   * Check if a tool call should trigger escalation from light to heavy tier.
   */
  shouldEscalate(toolName: string): boolean {
    return this.heavyTools.has(toolName);
  }
}
