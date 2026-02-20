/**
 * SubagentEnvelope: typed contract for orchestrator → worker task delegation.
 * Provides structured metadata, output schema validation, and result tracking.
 */

export type SubagentTaskType =
  | "research"
  | "code_execution"
  | "data_extraction"
  | "summarization"
  | "analysis"
  | "general";

export interface SubagentEnvelope {
  taskId: string;
  taskType: SubagentTaskType;
  input: {
    task: string;
    context?: string;
  };
  /** Optional JSON Schema to validate the output against. */
  expectedOutputSchema?: object;
  metadata: {
    requesterId: string;
    requesterChannel: string;
    timestamp: string;
    priority: "low" | "normal" | "high";
    parentTaskId?: string;
    specialistPreset?: string;
    tags?: string[];
  };
}

export interface SubagentResult {
  taskId: string;
  taskType: SubagentTaskType;
  status: "completed" | "failed" | "timeout";
  output?: unknown;
  rawText: string;
  error?: string;
  metrics: {
    durationMs: number;
    inputTokens: number;
    outputTokens: number;
    toolCallCount: number;
  };
}

/** Create a new envelope with defaults filled in. */
export function createEnvelope(
  taskId: string,
  taskType: SubagentTaskType,
  task: string,
  options: {
    context?: string;
    requesterId: string;
    requesterChannel: string;
    priority?: "low" | "normal" | "high";
    parentTaskId?: string;
    specialistPreset?: string;
    tags?: string[];
    expectedOutputSchema?: object;
  }
): SubagentEnvelope {
  return {
    taskId,
    taskType,
    input: {
      task,
      context: options.context,
    },
    expectedOutputSchema: options.expectedOutputSchema,
    metadata: {
      requesterId: options.requesterId,
      requesterChannel: options.requesterChannel,
      timestamp: new Date().toISOString(),
      priority: options.priority ?? "normal",
      parentTaskId: options.parentTaskId,
      specialistPreset: options.specialistPreset,
      tags: options.tags,
    },
  };
}

/** Wrap a raw result string into a SubagentResult. */
export function wrapResult(
  envelope: SubagentEnvelope,
  rawText: string,
  status: SubagentResult["status"],
  metrics: SubagentResult["metrics"],
  error?: string
): SubagentResult {
  let output: unknown;

  if (status === "completed" && envelope.expectedOutputSchema) {
    const validated = validateOutput(rawText, envelope.expectedOutputSchema);
    output = validated.valid ? validated.parsed : undefined;
  } else if (status === "completed") {
    // Try to parse as JSON anyway; fall back to raw text
    try {
      output = JSON.parse(rawText);
    } catch {
      output = rawText;
    }
  }

  return {
    taskId: envelope.taskId,
    taskType: envelope.taskType,
    status,
    output,
    rawText,
    error,
    metrics,
  };
}

/** Attempt to parse and validate output against a JSON Schema (basic). */
export function validateOutput(
  rawText: string,
  _schema: object
): { valid: boolean; parsed?: unknown; error?: string } {
  // Strip markdown fences if present
  const cleaned = rawText
    .replace(/^```(?:json)?\n?/m, "")
    .replace(/\n?```$/m, "")
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    // For now, just validate that it parses as valid JSON.
    // Full JSON Schema validation can be wired in if ajv is added.
    return { valid: true, parsed };
  } catch (err) {
    return {
      valid: false,
      error: `JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
