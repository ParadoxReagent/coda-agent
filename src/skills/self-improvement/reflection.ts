/**
 * Reflection module: assembles the weekly Opus reflection input
 * and parses the response into structured improvement proposals.
 */
import type { Database } from "../../db/index.js";
import type { Logger } from "../../utils/logger.js";
import type { AuditService } from "../../core/audit.js";
import { selfAssessments, routingDecisions } from "../../db/schema.js";
import { gte, sql } from "drizzle-orm";
import type { ReflectionInput, RawProposal } from "./types.js";

const REFLECTION_SYSTEM_PROMPT = `You are a senior AI systems architect performing a weekly self-improvement analysis of an AI agent system called "coda".

Your job is to analyze the agent's performance data for the past week and identify actionable improvements.

Return a JSON array of improvement proposals. Each proposal must have:
{
  "category": one of: "prompt" | "routing" | "memory" | "capability_gap" | "failure_mode" | "tool_usage",
  "title": "Short title (max 100 chars)",
  "description": "Detailed explanation of the issue and recommended fix (2-4 sentences)",
  "priority": integer 1-10 (10 = most urgent),
  "proposed_diff": "Optional: for 'prompt' category, the exact replacement text for the target section",
  "target_section": "Optional: for 'prompt' category, the section name to update"
}

Focus on:
1. Recurring failure patterns in tool usage
2. Routing misclassifications (light tier used for complex tasks or vice versa)
3. Prompt clarity issues causing repeated misunderstandings
4. Missing capabilities that users frequently request but the agent lacks
5. Memory usage patterns — is the agent proactively saving useful information?

Be concrete and actionable. Return ONLY a valid JSON array, no markdown.`;

export async function assembleReflectionInput(
  db: Database,
  auditService: AuditService,
  systemPromptSnapshot: string,
  toolList: string[],
  logger: Logger
): Promise<ReflectionInput> {
  const cycleId = crypto.randomUUID();
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000);

  // 1. Audit stats
  const auditStats = await auditService.getStats(7 * 24);

  // 2. Low-scoring self-assessments (score ≤ 2)
  let lowScoringAssessments: ReflectionInput["lowScoringAssessments"] = [];
  try {
    const rows = await db
      .select({
        correlationId: selfAssessments.correlationId,
        selfScore: selfAssessments.selfScore,
        assessmentSummary: selfAssessments.assessmentSummary,
        failureModes: selfAssessments.failureModes,
        tierUsed: selfAssessments.tierUsed,
      })
      .from(selfAssessments)
      .where(gte(selfAssessments.createdAt, since))
      .orderBy(selfAssessments.selfScore)
      .limit(20);

    lowScoringAssessments = rows
      .filter(r => (r.selfScore ?? 5) <= 2)
      .map(r => ({
        correlationId: r.correlationId ?? undefined,
        selfScore: r.selfScore ?? 0,
        assessmentSummary: r.assessmentSummary ?? undefined,
        failureModes: r.failureModes,
        tierUsed: r.tierUsed ?? undefined,
      }));
  } catch (err) {
    logger.debug({ error: err }, "reflection: failed to query self_assessments");
  }

  // 3. Routing patterns
  let routingPatterns: ReflectionInput["routingPatterns"] = [];
  try {
    const rows = await db
      .select({
        tier: routingDecisions.tier,
        count: sql<number>`count(*)::int`,
        avgComplexity: sql<number>`avg(input_complexity_score)::float`,
      })
      .from(routingDecisions)
      .where(gte(routingDecisions.createdAt, since))
      .groupBy(routingDecisions.tier);

    routingPatterns = rows.map(r => ({
      tier: r.tier,
      count: r.count,
      avgComplexity: r.avgComplexity ?? 0,
    }));
  } catch (err) {
    logger.debug({ error: err }, "reflection: failed to query routing_decisions");
  }

  return {
    cycleId,
    auditStats,
    lowScoringAssessments,
    routingPatterns,
    systemPromptSnapshot: systemPromptSnapshot.slice(0, 3000),
    toolList,
  };
}

export async function runReflection(
  input: ReflectionInput,
  opusLlm: {
    chat(params: {
      system: string;
      messages: Array<{ role: "user" | "assistant"; content: string }>;
      maxTokens?: number;
    }): Promise<{ text: string | null }>;
  },
  logger: Logger
): Promise<RawProposal[]> {
  const userContent = buildReflectionPrompt(input);

  try {
    const response = await opusLlm.chat({
      system: REFLECTION_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
      maxTokens: 3000,
    });

    if (!response.text) {
      logger.warn("Opus reflection returned no text");
      return [];
    }

    // Strip markdown fences
    const cleaned = response.text
      .replace(/^```(?:json)?\n?/m, "")
      .replace(/\n?```$/m, "")
      .trim();

    const parsed = JSON.parse(cleaned) as unknown;
    if (!Array.isArray(parsed)) {
      logger.warn("Opus reflection response was not an array");
      return [];
    }

    return parsed.filter(isRawProposal).slice(0, 10);
  } catch (err) {
    logger.warn({ error: err }, "Reflection failed to parse Opus response");
    return [];
  }
}

function buildReflectionPrompt(input: ReflectionInput): string {
  const lines: string[] = [
    `## Weekly Performance Report (Cycle: ${input.cycleId})`,
    "",
    "### Audit Statistics (Last 7 Days)",
    `- Total tool calls: ${input.auditStats.totalCalls}`,
    `- Success rate: ${(input.auditStats.successRate * 100).toFixed(1)}%`,
    `- Top tools: ${input.auditStats.topTools.slice(0, 5).map(t => `${t.toolName}(${t.count})`).join(", ")}`,
    `- Tools with errors: ${input.auditStats.errorsByTool.slice(0, 5).map(t => `${t.toolName}(${t.count})`).join(", ") || "none"}`,
    "",
    "### Routing Patterns",
    ...input.routingPatterns.map(r => `- ${r.tier}: ${r.count} requests, avg complexity ${r.avgComplexity.toFixed(2)}`),
    "",
    `### Low-Scoring Interactions (${input.lowScoringAssessments.length} in past week)`,
    ...input.lowScoringAssessments.slice(0, 5).map(a =>
      `- Score ${a.selfScore}/5 [${a.tierUsed ?? "?"}]: ${a.assessmentSummary ?? "no summary"} | Failures: ${JSON.stringify(a.failureModes)}`
    ),
    "",
    "### Current System Prompt (excerpt)",
    input.systemPromptSnapshot,
    "",
    "### Available Tools",
    input.toolList.slice(0, 30).join(", "),
    "",
    "Based on this data, identify the top improvements the agent should make this week.",
  ];

  return lines.join("\n");
}

function isRawProposal(v: unknown): v is RawProposal {
  if (!v || typeof v !== "object") return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj.category === "string" &&
    typeof obj.title === "string" &&
    typeof obj.description === "string" &&
    typeof obj.priority === "number"
  );
}
