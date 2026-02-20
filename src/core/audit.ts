/**
 * AuditService: Persistent, queryable audit trail for every tool call
 * and significant system event.
 *
 * Design:
 * - Writes are fire-and-forget (never throw into the calling path)
 * - Sensitive tool inputs: store key names only, never values
 * - Provides read access via audit_query for agent self-introspection
 */
import type { Database } from "../db/index.js";
import type { Logger } from "../utils/logger.js";
import { auditLog } from "../db/schema.js";
import { desc, eq, gte, and, sql } from "drizzle-orm";
import { getCurrentContext } from "./correlation.js";

export type AuditEventType =
  | "tool_call"
  | "tool_call_blocked"
  | "routing_decision"
  | "confirmation_requested"
  | "confirmation_resolved"
  | "session_start"
  | "session_end"
  | "error";

export interface AuditRecord {
  eventType: AuditEventType;
  skillName?: string;
  toolName?: string;
  /** Key names only for sensitive tools; full summary for others */
  inputSummary?: string;
  durationMs?: number;
  status: "success" | "error" | "blocked" | "pending";
  tier?: string;
  model?: string;
  provider?: string;
  permissionTier?: number;
  metadata?: Record<string, unknown>;
  /** Override — if not provided, pulled from AsyncLocalStorage */
  correlationId?: string;
  userId?: string;
  channel?: string;
}

export class AuditService {
  constructor(
    private db: Database,
    private logger: Logger
  ) {}

  /** Write an audit record. Fire-and-forget — never throws. */
  async write(record: AuditRecord): Promise<void> {
    try {
      const ctx = getCurrentContext();
      await this.db.insert(auditLog).values({
        correlationId: record.correlationId ?? ctx?.correlationId,
        userId: record.userId ?? ctx?.userId,
        channel: record.channel ?? ctx?.channel,
        eventType: record.eventType,
        skillName: record.skillName,
        toolName: record.toolName,
        inputSummary: record.inputSummary,
        durationMs: record.durationMs,
        status: record.status,
        tier: record.tier,
        model: record.model,
        provider: record.provider,
        permissionTier: record.permissionTier,
        metadata: record.metadata ?? {},
      });
    } catch (err) {
      // Audit writes must never disrupt the main flow
      this.logger.warn({ error: err }, "audit.write failed (non-fatal)");
    }
  }

  /**
   * Query the audit log. Returns up to limit records, newest first.
   * Supports filtering by tool, skill, status, and time range.
   */
  async query(options: {
    toolName?: string;
    skillName?: string;
    userId?: string;
    status?: string;
    eventType?: AuditEventType;
    sinceHours?: number;
    limit?: number;
  }): Promise<Array<{
    id: number;
    correlationId: string | null;
    userId: string | null;
    channel: string | null;
    eventType: string;
    skillName: string | null;
    toolName: string | null;
    inputSummary: string | null;
    durationMs: number | null;
    status: string;
    tier: string | null;
    model: string | null;
    permissionTier: number | null;
    createdAt: Date;
  }>> {
    const limit = Math.min(options.limit ?? 50, 200);
    const conditions = [];

    if (options.toolName) {
      conditions.push(eq(auditLog.toolName, options.toolName));
    }
    if (options.skillName) {
      conditions.push(eq(auditLog.skillName, options.skillName));
    }
    if (options.userId) {
      conditions.push(eq(auditLog.userId, options.userId));
    }
    if (options.status) {
      conditions.push(eq(auditLog.status, options.status));
    }
    if (options.eventType) {
      conditions.push(eq(auditLog.eventType, options.eventType));
    }
    if (options.sinceHours) {
      const since = new Date(Date.now() - options.sinceHours * 3600 * 1000);
      conditions.push(gte(auditLog.createdAt, since));
    }

    const rows = await this.db
      .select({
        id: auditLog.id,
        correlationId: auditLog.correlationId,
        userId: auditLog.userId,
        channel: auditLog.channel,
        eventType: auditLog.eventType,
        skillName: auditLog.skillName,
        toolName: auditLog.toolName,
        inputSummary: auditLog.inputSummary,
        durationMs: auditLog.durationMs,
        status: auditLog.status,
        tier: auditLog.tier,
        model: auditLog.model,
        permissionTier: auditLog.permissionTier,
        createdAt: auditLog.createdAt,
      })
      .from(auditLog)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(auditLog.createdAt))
      .limit(limit);

    return rows;
  }

  /** Get tool call statistics over a time window. */
  async getStats(sinceHours: number = 24): Promise<{
    totalCalls: number;
    successRate: number;
    topTools: Array<{ toolName: string; count: number }>;
    errorsByTool: Array<{ toolName: string; count: number }>;
  }> {
    const since = new Date(Date.now() - sinceHours * 3600 * 1000);

    const [totals] = await this.db
      .select({
        total: sql<number>`count(*)::int`,
        success: sql<number>`count(*) filter (where status = 'success')::int`,
      })
      .from(auditLog)
      .where(and(eq(auditLog.eventType, "tool_call"), gte(auditLog.createdAt, since)));

    const topTools = await this.db
      .select({
        toolName: auditLog.toolName,
        count: sql<number>`count(*)::int`,
      })
      .from(auditLog)
      .where(and(eq(auditLog.eventType, "tool_call"), gte(auditLog.createdAt, since)))
      .groupBy(auditLog.toolName)
      .orderBy(desc(sql`count(*)`))
      .limit(10);

    const errorsByTool = await this.db
      .select({
        toolName: auditLog.toolName,
        count: sql<number>`count(*)::int`,
      })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.eventType, "tool_call"),
          eq(auditLog.status, "error"),
          gte(auditLog.createdAt, since)
        )
      )
      .groupBy(auditLog.toolName)
      .orderBy(desc(sql`count(*)`))
      .limit(10);

    const total = totals?.total ?? 0;
    const success = totals?.success ?? 0;

    return {
      totalCalls: total,
      successRate: total > 0 ? success / total : 0,
      topTools: topTools
        .filter((r) => r.toolName)
        .map((r) => ({ toolName: r.toolName!, count: r.count })),
      errorsByTool: errorsByTool
        .filter((r) => r.toolName)
        .map((r) => ({ toolName: r.toolName!, count: r.count })),
    };
  }
}
