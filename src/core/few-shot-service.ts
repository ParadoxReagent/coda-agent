/**
 * FewShotService: harvests high-scoring interactions into solution_patterns
 * and retrieves relevant patterns at query time for system prompt injection.
 *
 * Harvest: monthly job extracting patterns from self_assessments (score >= 4)
 * Retrieval: cosine similarity search on solution_patterns at turn start
 */
import type { Database } from "../db/index.js";
import type { Logger } from "../utils/logger.js";
import { solutionPatterns, selfAssessments, auditLog } from "../db/schema.js";
import { gte, sql, and, inArray, eq } from "drizzle-orm";

type OpusLlm = {
  chat(params: {
    system: string;
    messages: Array<{ role: "user" | "assistant"; content: string }>;
    maxTokens?: number;
  }): Promise<{ text: string | null }>;
};

export interface PatternRecord {
  title: string;
  task_type: string;
  problem_description: string;
  resolution_steps: string[];
  tools_used: string[];
  tags: string[];
}

const HARVEST_SYSTEM_PROMPT = `You are a solution pattern extractor for an AI assistant system called "coda".

Given a set of high-scoring agent interactions (tool call sequences that solved user tasks well), extract reusable solution patterns.

Return a JSON array of patterns. Each pattern must have:
{
  "title": "Short, descriptive title (max 80 chars)",
  "task_type": "Category of task (e.g. 'research', 'data_analysis', 'reminder_management')",
  "problem_description": "What kind of user problem this pattern solves",
  "resolution_steps": ["Step 1: ...", "Step 2: ...", "..."],
  "tools_used": ["tool_name_1", "tool_name_2"],
  "tags": ["tag1", "tag2"]
}

Extract 1-3 patterns from the provided interactions. Focus on:
- Multi-step sequences that are non-obvious
- Patterns that combine multiple tools effectively
- Solutions to recurring problem types

Return ONLY a valid JSON array, no markdown.`;

export class FewShotService {
  private opusLlm?: OpusLlm;
  private minScore: number;
  private minToolCalls: number;

  constructor(
    private db: Database,
    private logger: Logger,
    options?: { minScore?: number; minToolCalls?: number }
  ) {
    this.minScore = options?.minScore ?? 4;
    this.minToolCalls = options?.minToolCalls ?? 2;
  }

  setOpusLlm(llm: OpusLlm): void {
    this.opusLlm = llm;
  }

  /**
   * Harvest high-scoring interactions into solution_patterns.
   * Returns the number of patterns stored.
   */
  async harvest(): Promise<number> {
    if (!this.opusLlm) {
      this.logger.warn("FewShotService: no Opus LLM configured for harvest");
      return 0;
    }

    const since30d = new Date(Date.now() - 30 * 24 * 3600 * 1000);

    // 1. Find high-scoring assessments
    let assessmentRows: Array<{
      correlationId: string | null;
      selfScore: number | null;
      assessmentSummary: string | null;
      toolCallCount: number | null;
      metadata: unknown;
    }> = [];

    try {
      assessmentRows = await this.db
        .select({
          correlationId: selfAssessments.correlationId,
          selfScore: selfAssessments.selfScore,
          assessmentSummary: selfAssessments.assessmentSummary,
          toolCallCount: selfAssessments.toolCallCount,
          metadata: selfAssessments.metadata,
        })
        .from(selfAssessments)
        .where(
          and(
            gte(selfAssessments.createdAt, since30d),
            sql`self_score >= ${this.minScore}`,
            sql`tool_call_count >= ${this.minToolCalls}`
          )
        )
        .orderBy(sql`self_score desc`)
        .limit(20);
    } catch (err) {
      this.logger.warn({ error: err }, "FewShotService: failed to query self_assessments");
      return 0;
    }

    if (assessmentRows.length === 0) {
      this.logger.info("FewShotService: no qualifying assessments found for harvest");
      return 0;
    }

    // Filter out already-harvested assessments
    const qualifying = assessmentRows.filter(r => {
      const meta = r.metadata as Record<string, unknown> | null;
      return !meta?.few_shot_harvested;
    });

    if (qualifying.length === 0) {
      this.logger.info("FewShotService: all qualifying assessments already harvested");
      return 0;
    }

    // 2. Fetch tool call sequences for each assessment
    const interactions: string[] = [];
    for (const assessment of qualifying.slice(0, 10)) {
      if (!assessment.correlationId) continue;

      try {
        const toolCalls = await this.db
          .select({
            toolName: auditLog.toolName,
            inputSummary: auditLog.inputSummary,
            status: auditLog.status,
            durationMs: auditLog.durationMs,
          })
          .from(auditLog)
          .where(
            and(
              eq(auditLog.correlationId, assessment.correlationId),
              eq(auditLog.eventType, "tool_call")
            )
          )
          .orderBy(auditLog.id)
          .limit(15);

        if (toolCalls.length === 0) continue;

        const toolSequence = toolCalls
          .map(tc => `  - ${tc.toolName}(${tc.inputSummary?.slice(0, 100) ?? ""}): ${tc.status}`)
          .join("\n");

        interactions.push(
          `### Interaction (score: ${assessment.selfScore}/5, tools: ${assessment.toolCallCount})\n` +
          `Summary: ${assessment.assessmentSummary?.slice(0, 200) ?? "n/a"}\n` +
          `Tool sequence:\n${toolSequence}`
        );
      } catch (err) {
        this.logger.debug({ error: err, correlationId: assessment.correlationId }, "FewShotService: failed to fetch tool calls");
      }
    }

    if (interactions.length === 0) {
      this.logger.info("FewShotService: no tool call data found for qualifying assessments");
      return 0;
    }

    // 3. Batch into groups of 5 and extract patterns
    let totalStored = 0;
    const batchSize = 5;

    for (let i = 0; i < interactions.length; i += batchSize) {
      const batch = interactions.slice(i, i + batchSize);
      const batchContent = batch.join("\n\n---\n\n");

      try {
        const response = await this.opusLlm.chat({
          system: HARVEST_SYSTEM_PROMPT,
          messages: [{
            role: "user",
            content: `Extract solution patterns from these high-scoring agent interactions:\n\n${batchContent}`,
          }],
          maxTokens: 2000,
        });

        if (!response.text) continue;

        const patterns = this.parsePatterns(response.text);
        const stored = await this.storePatterns(patterns);
        totalStored += stored;
      } catch (err) {
        this.logger.warn({ error: err }, "FewShotService: batch harvest failed");
      }
    }

    // 4. Mark harvested assessments
    const harvestedIds = qualifying
      .filter(r => r.correlationId)
      .map(r => r.correlationId!);

    if (harvestedIds.length > 0) {
      try {
        // Update metadata to mark as harvested (best-effort)
        for (const correlationId of harvestedIds) {
          await this.db
            .update(selfAssessments)
            .set({
              metadata: sql`metadata || '{"few_shot_harvested": true}'::jsonb`,
            })
            .where(eq(selfAssessments.correlationId, correlationId));
        }
      } catch (err) {
        this.logger.debug({ error: err }, "FewShotService: failed to mark assessments as harvested");
      }
    }

    this.logger.info({ totalStored, interactions: interactions.length }, "FewShotService: harvest complete");
    return totalStored;
  }

  /**
   * Retrieve 2-3 relevant patterns for a user message using text search.
   * Returns formatted <example> blocks or null if no patterns found.
   */
  async getRelevantPatterns(userMessage: string, maxPatterns = 3): Promise<string | null> {
    try {
      // Use keyword-based search from the solution_patterns table
      // (Full vector similarity requires embedding endpoint — fall back to recency + tags)
      const patterns = await this.db
        .select({
          id: solutionPatterns.id,
          title: solutionPatterns.title,
          taskType: solutionPatterns.taskType,
          problemDescription: solutionPatterns.problemDescription,
          resolutionSteps: solutionPatterns.resolutionSteps,
          toolsUsed: solutionPatterns.toolsUsed,
          tags: solutionPatterns.tags,
        })
        .from(solutionPatterns)
        .orderBy(sql`retrieval_count asc, created_at desc`)
        .limit(maxPatterns * 3); // Fetch extra to filter by keyword match

      if (patterns.length === 0) return null;

      // Simple keyword relevance scoring
      const msgLower = userMessage.toLowerCase();
      const scored = patterns.map(p => {
        let score = 0;
        const text = `${p.title} ${p.problemDescription} ${p.tags?.join(" ")} ${p.taskType}`.toLowerCase();
        // Count word overlaps
        const words = msgLower.split(/\s+/).filter(w => w.length > 3);
        for (const word of words) {
          if (text.includes(word)) score++;
        }
        return { pattern: p, score };
      });

      const relevant = scored
        .filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, maxPatterns)
        .map(s => s.pattern);

      if (relevant.length === 0) return null;

      // Increment retrieval counts (best-effort)
      const ids = relevant.map(p => p.id);
      this.db
        .update(solutionPatterns)
        .set({ retrievalCount: sql`retrieval_count + 1` })
        .where(inArray(solutionPatterns.id, ids))
        .catch(() => {});

      // Format as example blocks
      const examples = relevant.map(p => {
        const steps = Array.isArray(p.resolutionSteps)
          ? (p.resolutionSteps as string[]).join("\n  ")
          : String(p.resolutionSteps);
        return `<example title="${p.title}" type="${p.taskType ?? "general"}">
Problem: ${p.problemDescription}
Steps:
  ${steps}
Tools: ${p.toolsUsed?.join(", ") ?? "n/a"}
</example>`;
      });

      return examples.join("\n\n");
    } catch (err) {
      this.logger.debug({ error: err }, "FewShotService: failed to retrieve patterns");
      return null;
    }
  }

  private parsePatterns(text: string): PatternRecord[] {
    const cleaned = text
      .replace(/^```(?:json)?\n?/m, "")
      .replace(/\n?```$/m, "")
      .trim();

    try {
      const parsed = JSON.parse(cleaned) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isPatternRecord).slice(0, 5);
    } catch (err) {
      this.logger.debug({ error: err }, "FewShotService: failed to parse pattern response");
      return [];
    }
  }

  private async storePatterns(patterns: PatternRecord[]): Promise<number> {
    if (patterns.length === 0) return 0;

    let stored = 0;
    for (const p of patterns) {
      try {
        await this.db.insert(solutionPatterns).values({
          title: p.title.slice(0, 500),
          taskType: p.task_type.slice(0, 100),
          problemDescription: p.problem_description,
          resolutionSteps: p.resolution_steps,
          toolsUsed: p.tools_used,
          tags: p.tags,
          outcome: "success",
        });
        stored++;
      } catch (err) {
        this.logger.debug({ error: err, title: p.title }, "FewShotService: failed to store pattern");
      }
    }
    return stored;
  }
}

function isPatternRecord(v: unknown): v is PatternRecord {
  if (!v || typeof v !== "object") return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj.title === "string" &&
    typeof obj.problem_description === "string" &&
    Array.isArray(obj.resolution_steps) &&
    Array.isArray(obj.tools_used)
  );
}
