/**
 * Gap Detection: monthly capability gap analysis using 30 days of audit data.
 * Identifies missing or inadequate tools that recurring failures point to.
 */
import type { Database } from "../../db/index.js";
import type { Logger } from "../../utils/logger.js";
import type { AuditService } from "../../core/audit.js";
import { selfAssessments, auditLog } from "../../db/schema.js";
import { gte, sql, eq, and } from "drizzle-orm";
import type { RawProposal } from "./types.js";

export interface GapDetectionInput {
  cycleId: string;
  auditStats30d: {
    totalCalls: number;
    successRate: number;
    topTools: Array<{ toolName: string; count: number }>;
    errorsByTool: Array<{ toolName: string; count: number }>;
  };
  failedToolCalls: Array<{
    toolName: string;
    count: number;
    sampleErrors: string[];
  }>;
  lowScoringAssessments: Array<{
    summary: string;
    failureModes: unknown;
    count: number;
  }>;
  currentSkills: string[];
  currentTools: string[];
}

const GAP_DETECTION_SYSTEM_PROMPT = `You are a capability gap analyst for an AI assistant system called "coda".

Your task is to analyze 30 days of operational data and identify MISSING or INADEQUATE capabilities — tools or skills that would have prevented failures or enabled new user value.

Return a JSON array (max 3 items) of capability gap proposals. Each must have:
{
  "category": "capability_gap",
  "title": "Short title describing the missing capability (max 100 chars)",
  "description": "Specific description: what capability is missing, what failures it caused, and what implementing it would achieve (2-4 sentences)",
  "priority": integer 1-10 (10 = most urgent)
}

Focus on:
1. Tools that failed repeatedly with the same error type (infrastructure gap)
2. User requests that couldn't be handled with current tools (feature gap)
3. Recurring patterns in low-scoring assessments pointing to missing functionality
4. High-value tools used by many users with error rates above 20%

Do NOT propose improvements to existing tools — only genuinely missing capabilities.
Return ONLY a valid JSON array, no markdown.`;

export async function assembleGapDetectionInput(
  db: Database,
  auditService: AuditService,
  skillList: string[],
  toolList: string[],
  logger: Logger
): Promise<GapDetectionInput> {
  const cycleId = crypto.randomUUID();
  const since30d = new Date(Date.now() - 30 * 24 * 3600 * 1000);

  // 1. Audit stats for 30 days
  const auditStats30d = await auditService.getStats(30 * 24);

  // 2. Failed tool calls grouped by tool name (30 days)
  let failedToolCalls: GapDetectionInput["failedToolCalls"] = [];
  try {
    const errorRows = await db
      .select({
        toolName: auditLog.toolName,
        count: sql<number>`count(*)::int`,
        sampleError: sql<string>`max(input_summary)`,
      })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.eventType, "tool_call"),
          eq(auditLog.status, "error"),
          gte(auditLog.createdAt, since30d)
        )
      )
      .groupBy(auditLog.toolName)
      .orderBy(sql`count(*) desc`)
      .limit(10);

    failedToolCalls = errorRows
      .filter(r => r.toolName && r.count >= 2)
      .map(r => ({
        toolName: r.toolName!,
        count: r.count,
        sampleErrors: r.sampleError ? [r.sampleError.slice(0, 200)] : [],
      }));
  } catch (err) {
    logger.debug({ error: err }, "gap-detection: failed to query audit_log");
  }

  // 3. Low-scoring assessments (score ≤ 2, 30 days)
  let lowScoringAssessments: GapDetectionInput["lowScoringAssessments"] = [];
  try {
    const rows = await db
      .select({
        assessmentSummary: selfAssessments.assessmentSummary,
        failureModes: selfAssessments.failureModes,
        count: sql<number>`count(*)::int`,
      })
      .from(selfAssessments)
      .where(
        and(
          gte(selfAssessments.createdAt, since30d),
          sql`self_score <= 2`
        )
      )
      .groupBy(selfAssessments.assessmentSummary, selfAssessments.failureModes)
      .orderBy(sql`count(*) desc`)
      .limit(10);

    lowScoringAssessments = rows.map(r => ({
      summary: (r.assessmentSummary ?? "no summary").slice(0, 300),
      failureModes: r.failureModes,
      count: r.count,
    }));
  } catch (err) {
    logger.debug({ error: err }, "gap-detection: failed to query self_assessments");
  }

  return {
    cycleId,
    auditStats30d,
    failedToolCalls,
    lowScoringAssessments,
    currentSkills: skillList,
    currentTools: toolList,
  };
}

export async function runGapDetection(
  input: GapDetectionInput,
  opusLlm: {
    chat(params: {
      system: string;
      messages: Array<{ role: "user" | "assistant"; content: string }>;
      maxTokens?: number;
    }): Promise<{ text: string | null }>;
  },
  logger: Logger
): Promise<RawProposal[]> {
  const userContent = buildGapPrompt(input);

  try {
    const response = await opusLlm.chat({
      system: GAP_DETECTION_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
      maxTokens: 2000,
    });

    if (!response.text) {
      logger.warn("Gap detection LLM returned no text");
      return [];
    }

    const cleaned = response.text
      .replace(/^```(?:json)?\n?/m, "")
      .replace(/\n?```$/m, "")
      .trim();

    const parsed = JSON.parse(cleaned) as unknown;
    if (!Array.isArray(parsed)) {
      logger.warn("Gap detection response was not an array");
      return [];
    }

    return parsed
      .filter(isGapProposal)
      .map(p => ({ ...p, category: "capability_gap" as const }))
      .slice(0, 3);
  } catch (err) {
    logger.warn({ error: err }, "Gap detection failed to parse LLM response");
    return [];
  }
}

function buildGapPrompt(input: GapDetectionInput): string {
  const lines = [
    `## Monthly Gap Detection Report (Cycle: ${input.cycleId})`,
    "",
    "### 30-Day Audit Statistics",
    `- Total tool calls: ${input.auditStats30d.totalCalls}`,
    `- Success rate: ${(input.auditStats30d.successRate * 100).toFixed(1)}%`,
    `- Top tools: ${input.auditStats30d.topTools.slice(0, 8).map(t => `${t.toolName}(${t.count})`).join(", ")}`,
    "",
    "### Failed Tool Calls (30 days)",
    ...input.failedToolCalls.map(f =>
      `- ${f.toolName}: ${f.count} errors | Sample: ${f.sampleErrors[0] ?? "n/a"}`
    ),
    "",
    `### Low-Scoring Assessment Patterns (${input.lowScoringAssessments.length} patterns)`,
    ...input.lowScoringAssessments.slice(0, 5).map(a =>
      `- (${a.count}x) ${a.summary} | Failures: ${JSON.stringify(a.failureModes)}`
    ),
    "",
    "### Currently Available Skills",
    input.currentSkills.join(", "),
    "",
    "### Currently Available Tools",
    input.currentTools.slice(0, 40).join(", "),
    "",
    "Based on the failure data above, identify the top 3 missing capabilities that would most reduce failures and improve user value.",
  ];

  return lines.join("\n");
}

function isGapProposal(v: unknown): v is RawProposal {
  if (!v || typeof v !== "object") return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj.title === "string" &&
    typeof obj.description === "string" &&
    typeof obj.priority === "number"
  );
}
