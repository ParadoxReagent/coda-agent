/**
 * SelfAssessmentService: Lightweight post-task self-scoring using Haiku.
 *
 * After each tool-using orchestrator turn, this service sends a truncated
 * summary of the interaction to Haiku with a structured scoring prompt.
 * The result is written to self_assessments table. Fire-and-forget.
 */
import type { Database } from "../db/index.js";
import type { Logger } from "../utils/logger.js";
import { selfAssessments } from "../db/schema.js";

export interface SelfAssessmentInput {
  correlationId?: string;
  userId: string;
  channel: string;
  userMessage: string;
  agentResponse: string;
  toolCallCount: number;
  toolErrors: string[];
  tierUsed?: string;
  modelUsed?: string;
  fallbackUsed?: boolean;
  llm: {
    chat(params: {
      system: string;
      messages: Array<{ role: "user" | "assistant"; content: string }>;
      maxTokens?: number;
    }): Promise<{ text: string | null }>;
  };
}

interface AssessmentResult {
  score: number;
  taskCompleted: boolean;
  failureModes: string[];
  summary: string;
}

const ASSESSMENT_SYSTEM_PROMPT = `You are an AI quality assessor. Evaluate the agent's performance on the task described.

Return a JSON object with EXACTLY this structure:
{
  "score": <number 1-5>,
  "task_completed": <boolean>,
  "failure_modes": <array of short strings describing failures, empty if none>,
  "summary": <one sentence summary of performance>
}

Scoring guide:
5 = Task fully completed, no errors, efficient tool use
4 = Task completed with minor issues or suboptimal tool use
3 = Task partially completed or required multiple retries
2 = Task failed but agent recognized the failure
1 = Task failed and agent did not recognize or handle the failure

Return ONLY valid JSON, no markdown, no explanation.`;

export class SelfAssessmentService {
  constructor(
    private db: Database,
    private logger: Logger
  ) {}

  /**
   * Assess a completed turn. Fire-and-forget — never throws into calling code.
   */
  async assess(input: SelfAssessmentInput): Promise<void> {
    try {
      const result = await this.runAssessment(input);
      await this.db.insert(selfAssessments).values({
        correlationId: input.correlationId,
        userId: input.userId,
        channel: input.channel,
        taskCompleted: result.taskCompleted,
        toolFailureCount: input.toolErrors.length,
        fallbackUsed: input.fallbackUsed ?? false,
        tierUsed: input.tierUsed,
        modelUsed: input.modelUsed,
        toolCallCount: input.toolCallCount,
        selfScore: result.score,
        assessmentSummary: result.summary,
        failureModes: result.failureModes,
        metadata: {
          toolErrorSamples: input.toolErrors.slice(0, 3),
        },
      });
    } catch (err) {
      // Self-assessment must never disrupt the main flow
      this.logger.debug({ error: err }, "self-assessment failed (non-critical)");
    }
  }

  private async runAssessment(input: SelfAssessmentInput): Promise<AssessmentResult> {
    const truncatedMessage = input.userMessage.slice(0, 400);
    const truncatedResponse = input.agentResponse.slice(0, 600);
    const errorSummary = input.toolErrors.length > 0
      ? `Tool errors (${input.toolErrors.length}): ${input.toolErrors.slice(0, 2).join("; ")}`
      : "No tool errors";

    const userContent = `User request: ${truncatedMessage}

Agent response (excerpt): ${truncatedResponse}

Tools called: ${input.toolCallCount}
${errorSummary}
Tier: ${input.tierUsed ?? "unknown"}`;

    const response = await input.llm.chat({
      system: ASSESSMENT_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
      maxTokens: 200,
    });

    if (!response.text) {
      return { score: 3, taskCompleted: false, failureModes: ["no_assessment_response"], summary: "Assessment unavailable" };
    }

    try {
      // Strip markdown code fences if present
      const cleaned = response.text.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
      const parsed = JSON.parse(cleaned) as {
        score?: unknown;
        task_completed?: unknown;
        failure_modes?: unknown;
        summary?: unknown;
      };

      return {
        score: typeof parsed.score === "number" ? Math.min(5, Math.max(1, parsed.score)) : 3,
        taskCompleted: typeof parsed.task_completed === "boolean" ? parsed.task_completed : false,
        failureModes: Array.isArray(parsed.failure_modes) ? parsed.failure_modes.filter((f): f is string => typeof f === "string") : [],
        summary: typeof parsed.summary === "string" ? parsed.summary.slice(0, 500) : "No summary",
      };
    } catch {
      return { score: 3, taskCompleted: false, failureModes: ["parse_error"], summary: "Assessment parse failed" };
    }
  }
}
