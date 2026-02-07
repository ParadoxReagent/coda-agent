import type { Logger } from "../../utils/logger.js";

export interface UsageRecord {
  provider: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  timestamp: Date;
  estimatedCost: number | null;
}

export interface DailyUsageSummary {
  provider: string;
  model: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  requestCount: number;
  estimatedCost: number | null;
  usageTracked: boolean;
}

/**
 * Tracks LLM token usage and estimated costs.
 * In-memory for Phase 1; Postgres persistence added in Phase 2.
 */
export class UsageTracker {
  private records: UsageRecord[] = [];
  private costRates: Record<string, { input: number; output: number }>;
  private dailyAlertThreshold: number | undefined;
  private alertFired = false;
  private logger: Logger;

  constructor(
    costRates?: Record<string, { input: number; output: number }>,
    dailyAlertThreshold?: number,
    logger?: Logger
  ) {
    this.costRates = costRates ?? {};
    this.dailyAlertThreshold = dailyAlertThreshold;
    this.logger = logger ?? ({ warn: () => {}, info: () => {}, error: () => {} } as unknown as Logger);
  }

  /** Track a single LLM request's usage. */
  async track(
    provider: string,
    model: string,
    usage: { inputTokens: number | null; outputTokens: number | null }
  ): Promise<void> {
    const cost = this.calculateCost(model, usage);

    this.records.push({
      provider,
      model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      timestamp: new Date(),
      estimatedCost: cost,
    });

    // Check daily spend alert
    if (this.dailyAlertThreshold && !this.alertFired) {
      const dailyCost = this.getTodayTotalCost();
      if (dailyCost !== null && dailyCost > this.dailyAlertThreshold) {
        this.alertFired = true;
        this.logger.warn(
          { dailyCost, threshold: this.dailyAlertThreshold },
          "Daily LLM spend threshold exceeded"
        );
      }
    }
  }

  /** Get aggregated usage for today, grouped by provider+model. */
  getDailyUsage(): DailyUsageSummary[] {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const todayRecords = this.records.filter((r) => r.timestamp >= today);
    const groups = new Map<string, DailyUsageSummary>();

    for (const record of todayRecords) {
      const key = `${record.provider}:${record.model}`;
      const existing = groups.get(key);

      if (existing) {
        existing.totalInputTokens += record.inputTokens ?? 0;
        existing.totalOutputTokens += record.outputTokens ?? 0;
        existing.requestCount++;
        if (record.estimatedCost !== null && existing.estimatedCost !== null) {
          existing.estimatedCost += record.estimatedCost;
        }
        if (record.inputTokens === null && record.outputTokens === null) {
          existing.usageTracked = false;
        }
      } else {
        groups.set(key, {
          provider: record.provider,
          model: record.model,
          totalInputTokens: record.inputTokens ?? 0,
          totalOutputTokens: record.outputTokens ?? 0,
          requestCount: 1,
          estimatedCost: record.estimatedCost,
          usageTracked:
            record.inputTokens !== null || record.outputTokens !== null,
        });
      }
    }

    return Array.from(groups.values());
  }

  /** Get total estimated cost for today. */
  getTodayTotalCost(): number | null {
    const summaries = this.getDailyUsage();
    let total = 0;
    let hasTracked = false;

    for (const s of summaries) {
      if (s.estimatedCost !== null) {
        total += s.estimatedCost;
        hasTracked = true;
      }
    }

    return hasTracked ? total : null;
  }

  private calculateCost(
    model: string,
    usage: { inputTokens: number | null; outputTokens: number | null }
  ): number | null {
    if (usage.inputTokens === null && usage.outputTokens === null) {
      return null;
    }

    const rates = this.costRates[model];
    if (!rates) {
      return null;
    }

    const inputCost =
      ((usage.inputTokens ?? 0) / 1_000_000) * rates.input;
    const outputCost =
      ((usage.outputTokens ?? 0) / 1_000_000) * rates.output;

    return inputCost + outputCost;
  }
}
