/**
 * Two-tier output repair for malformed structured output.
 * Tier 1: Quick fixes (no LLM call)
 * Tier 2: LLM re-prompt (if quick fix fails and enabled)
 */
import type { ProviderManager } from "../llm/manager.js";
import type { Logger } from "../../utils/logger.js";

export interface OutputRepairConfig {
  enabled: boolean;
  maxAttempts: number;
  quickFixOnly: boolean;
}

const DEFAULT_CONFIG: OutputRepairConfig = {
  enabled: true,
  maxAttempts: 2,
  quickFixOnly: false,
};

const MAX_REPAIRS_PER_MINUTE = 10;
const REPAIR_WINDOW_MS = 60_000;

export class OutputRepair {
  private config: OutputRepairConfig;
  private providerManager?: ProviderManager;
  private logger: Logger;
  private repairAttempts: Map<string, number[]> = new Map();

  constructor(logger: Logger, config?: Partial<OutputRepairConfig>, providerManager?: ProviderManager) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.providerManager = providerManager;
    this.logger = logger;
  }

  /**
   * Try to parse JSON, applying repairs if needed.
   * Returns the parsed object or null if all repairs fail.
   */
  async tryParseJson(raw: string, toolName?: string): Promise<Record<string, unknown> | null> {
    if (!this.config.enabled) {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    }

    // Rate limit repair attempts per tool to prevent DoS
    if (toolName) {
      const attempts = this.repairAttempts.get(toolName) ?? [];
      const now = Date.now();
      const recent = attempts.filter(t => now - t < REPAIR_WINDOW_MS);

      if (recent.length >= MAX_REPAIRS_PER_MINUTE) {
        this.logger.warn({ toolName, attempts: recent.length }, "Repair rate limit exceeded");
        return null;
      }

      recent.push(now);
      this.repairAttempts.set(toolName, recent);
    }

    // Direct parse first
    try {
      return JSON.parse(raw);
    } catch {
      // Continue to repair
    }

    // Tier 1: Quick fixes
    const quickFixed = this.quickFix(raw);
    try {
      const result = JSON.parse(quickFixed);
      this.logger.debug("Output repaired via quick fix");
      return result;
    } catch {
      // Continue to tier 2
    }

    // Tier 2: LLM re-prompt
    if (!this.config.quickFixOnly && this.providerManager) {
      return this.llmRepair(raw);
    }

    return null;
  }

  /**
   * Quick-fix a raw string that should be JSON.
   * Applies common fixes without an LLM call.
   */
  quickFix(raw: string): string {
    let fixed = raw.trim();

    // Strip markdown code fences
    fixed = fixed.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/, "");

    // Strip leading/trailing whitespace again after fence removal
    fixed = fixed.trim();

    // Remove trailing commas before } or ]
    fixed = fixed.replace(/,\s*([}\]])/g, "$1");

    // Fix single quotes to double quotes (simple heuristic for JSON-like strings)
    // Only apply if there are no double quotes (to avoid breaking valid strings)
    if (!fixed.includes('"') && fixed.includes("'")) {
      fixed = fixed.replace(/'/g, '"');
    }

    // Add missing closing braces/brackets for simple truncation
    const opens = (fixed.match(/{/g) || []).length;
    const closes = (fixed.match(/}/g) || []).length;
    if (opens > closes) {
      fixed += "}".repeat(opens - closes);
    }

    const openBrackets = (fixed.match(/\[/g) || []).length;
    const closeBrackets = (fixed.match(/]/g) || []).length;
    if (openBrackets > closeBrackets) {
      fixed += "]".repeat(openBrackets - closeBrackets);
    }

    return fixed;
  }

  private async llmRepair(raw: string): Promise<Record<string, unknown> | null> {
    if (!this.providerManager) return null;

    for (let attempt = 0; attempt < this.config.maxAttempts; attempt++) {
      try {
        const { provider, model } = await this.providerManager.getForUser("system");

        const response = await provider.chat({
          model,
          system: "You fix malformed JSON. Return ONLY the corrected JSON with no explanation or markdown.",
          messages: [
            {
              role: "user",
              content: `The following was supposed to be valid JSON but has errors. Return only the corrected JSON:\n\n${raw.substring(0, 2000)}`,
            },
          ],
          maxTokens: 1024,
        });

        if (response.text) {
          // Apply quick fix to the LLM output too (it might add fences)
          const cleaned = this.quickFix(response.text);
          const parsed = JSON.parse(cleaned);
          this.logger.debug({ attempt: attempt + 1 }, "Output repaired via LLM re-prompt");
          return parsed;
        }
      } catch (err) {
        this.logger.debug(
          { attempt: attempt + 1, error: err instanceof Error ? err.message : String(err) },
          "LLM repair attempt failed"
        );
      }
    }

    return null;
  }
}
