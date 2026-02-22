/**
 * LearnedTierClassifier: Learns routing patterns from routing_decisions + self_assessments.
 *
 * Retrains weekly (after Opus reflection). Classifies messages based on learned
 * keyword patterns. Returns null if not confident, allowing fallthrough to
 * static TierClassifier heuristics.
 */
import type { Database } from "../db/index.js";
import type { Logger } from "../utils/logger.js";
import { routingDecisions, selfAssessments } from "../db/schema.js";
import { gte, desc } from "drizzle-orm";

export interface LearnedClassification {
  tier: "light" | "heavy";
  confidence: number;
  reason: string;
}

interface LearnedPattern {
  keyword: string;
  tier: "light" | "heavy";
  confidence: number;
  sampleCount: number;
}

export class LearnedTierClassifier {
  private patterns: LearnedPattern[] = [];
  private lastTrainedAt: Date | null = null;

  constructor(
    private db: Database,
    private logger: Logger
  ) {}

  /**
   * Classify a message using learned patterns.
   * Returns null if confidence < threshold (caller falls through to static heuristics).
   */
  classify(message: string, confidenceThreshold = 0.7): LearnedClassification | null {
    if (this.patterns.length === 0) return null;

    const lower = message.toLowerCase();
    const matches: LearnedPattern[] = [];

    for (const pattern of this.patterns) {
      if (lower.includes(pattern.keyword)) {
        matches.push(pattern);
      }
    }

    if (matches.length === 0) return null;

    // Weighted vote: sum confidence scores by tier
    let lightScore = 0;
    let heavyScore = 0;

    for (const m of matches) {
      if (m.tier === "light") lightScore += m.confidence * m.sampleCount;
      else heavyScore += m.confidence * m.sampleCount;
    }

    const total = lightScore + heavyScore;
    if (total === 0) return null;

    const winningTier = lightScore > heavyScore ? "light" : "heavy";
    const confidence = Math.max(lightScore, heavyScore) / total;

    if (confidence < confidenceThreshold) return null;

    const topMatch = matches.sort((a, b) => b.confidence - a.confidence)[0]!;

    return {
      tier: winningTier,
      confidence,
      reason: `Learned pattern "${topMatch.keyword}" (confidence: ${(confidence * 100).toFixed(0)}%)`,
    };
  }

  /**
   * Retrain from routing_decisions joined with self_assessments.
   * Identifies misrouted tasks and builds keyword patterns.
   *
   * Misrouting signals:
   * - light tier + low self_score (≤2) → should have been heavy
   * - heavy tier + high self_score (≥4) on short message → could be light
   */
  async retrain(lookbackDays = 30): Promise<void> {
    try {
      const since = new Date(Date.now() - lookbackDays * 24 * 3600 * 1000);

      // Fetch routing decisions with associated self-assessment scores
      const rows = await this.db
        .select({
          correlationId: routingDecisions.correlationId,
          tier: routingDecisions.tier,
          rationale: routingDecisions.rationale,
          inputComplexityScore: routingDecisions.inputComplexityScore,
        })
        .from(routingDecisions)
        .where(gte(routingDecisions.createdAt, since))
        .orderBy(desc(routingDecisions.createdAt))
        .limit(500);

      // Get self-assessment scores keyed by correlation_id
      const assessmentMap = new Map<string, number>();
      if (rows.length > 0) {
        const correlationIds = rows
          .map(r => r.correlationId)
          .filter((id): id is string => !!id);

        if (correlationIds.length > 0) {
          const assessments = await this.db
            .select({
              correlationId: selfAssessments.correlationId,
              selfScore: selfAssessments.selfScore,
            })
            .from(selfAssessments)
            .where(gte(selfAssessments.createdAt, since));

          for (const a of assessments) {
            if (a.correlationId && a.selfScore !== null) {
              assessmentMap.set(a.correlationId, a.selfScore);
            }
          }
        }
      }

      // Extract keyword patterns from misrouted decisions
      const keywordStats = new Map<string, { tier: "light" | "heavy"; correct: number; total: number }>();

      for (const row of rows) {
        if (!row.rationale || !row.correlationId) continue;
        const score = assessmentMap.get(row.correlationId);
        if (score === undefined) continue;

        // Determine if this routing was correct
        const isLightTier = row.tier === "light";
        const isLowScore = score <= 2;
        const isHighScore = score >= 4;

        // Extract keywords from the rationale (simplified: split into words)
        const words = row.rationale
          .toLowerCase()
          .replace(/[^a-z0-9\s]/g, " ")
          .split(/\s+/)
          .filter(w => w.length >= 4 && w.length <= 20);

        const targetTier: "light" | "heavy" | null =
          (isLightTier && isLowScore) ? "heavy" :
          (!isLightTier && isHighScore) ? "light" :
          (isLightTier && isHighScore) ? "light" :
          (!isLightTier && isLowScore) ? "heavy" : null;

        if (!targetTier) continue;

        for (const word of words.slice(0, 5)) { // Top 5 words per rationale
          const key = `${word}:${targetTier}`;
          const existing = keywordStats.get(key) ?? { tier: targetTier, correct: 0, total: 0 };
          existing.total += 1;
          existing.correct += 1;
          keywordStats.set(key, existing);
        }
      }

      // Build patterns with confidence ≥ 0.6 and ≥ 3 samples
      const newPatterns: LearnedPattern[] = [];
      for (const [key, stats] of keywordStats) {
        if (stats.total < 3) continue;
        const confidence = stats.correct / stats.total;
        if (confidence < 0.6) continue;

        const [keyword] = key.split(":");
        if (!keyword) continue;

        newPatterns.push({
          keyword,
          tier: stats.tier,
          confidence,
          sampleCount: stats.total,
        });
      }

      // Sort by confidence * sampleCount, keep top 50
      newPatterns.sort((a, b) => (b.confidence * b.sampleCount) - (a.confidence * a.sampleCount));
      this.patterns = newPatterns.slice(0, 50);
      this.lastTrainedAt = new Date();

      this.logger.info(
        { patternsLearned: this.patterns.length, rowsAnalyzed: rows.length },
        "LearnedTierClassifier retrained"
      );
    } catch (err) {
      this.logger.warn({ error: err }, "LearnedTierClassifier retrain failed");
    }
  }

  getStats(): { patternCount: number; lastTrainedAt: Date | null } {
    return { patternCount: this.patterns.length, lastTrainedAt: this.lastTrainedAt };
  }
}
