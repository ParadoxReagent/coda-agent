/**
 * RoutingDecisionLogger: Logs every LLM routing decision to Postgres
 * for observability and future self-improvement analysis.
 *
 * Data is queried by Phase 4's routing intelligence upgrade after
 * 6+ weeks of accumulation.
 */
import type { Database } from "../db/index.js";
import type { Logger } from "../utils/logger.js";
import { routingDecisions } from "../db/schema.js";
import { getCurrentContext } from "./correlation.js";

export interface RoutingDecisionRecord {
  modelChosen: string;
  provider: string;
  tier: "light" | "heavy";
  rationale?: string;
  inputComplexityScore?: number;
  latencyMs?: number;
  sessionId?: string;
  userId?: string;
  channel?: string;
}

export class RoutingDecisionLogger {
  constructor(
    private db: Database,
    private logger: Logger
  ) {}

  /** Log a routing decision. Fire-and-forget — never throws. */
  async log(record: RoutingDecisionRecord): Promise<void> {
    try {
      const ctx = getCurrentContext();
      await this.db.insert(routingDecisions).values({
        sessionId: record.sessionId ?? ctx?.correlationId,
        correlationId: ctx?.correlationId,
        userId: record.userId ?? ctx?.userId,
        channel: record.channel ?? ctx?.channel,
        modelChosen: record.modelChosen,
        provider: record.provider,
        tier: record.tier,
        rationale: record.rationale,
        inputComplexityScore: record.inputComplexityScore,
        latencyMs: record.latencyMs,
      });
    } catch (err) {
      this.logger.warn({ error: err }, "routing-logger.log failed (non-fatal)");
    }
  }
}
