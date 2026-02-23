/**
 * Audit skill — read-only agent self-introspection into the audit log.
 * Allows the agent to query its own tool call history, identify patterns,
 * and surface failure modes without direct DB access.
 */
import type { Skill, SkillToolDefinition } from "../base.js";
import type { SkillContext } from "../context.js";
import type { AuditService } from "../../core/audit.js";

export class AuditSkill implements Skill {
  readonly name = "audit";
  readonly description = "Read-only access to the agent audit log for self-introspection";

  constructor(private auditService: AuditService) {}

  getTools(): SkillToolDefinition[] {
    return [
      {
        name: "audit_query",
        description:
          "Query the audit log to review recent tool calls, identify failures, or understand usage patterns. " +
          "Returns tool call records with status, duration, and skill information.",
        mainAgentOnly: true,
        input_schema: {
          type: "object" as const,
          properties: {
            tool_name: {
              type: "string",
              description: "Filter by specific tool name",
            },
            skill_name: {
              type: "string",
              description: "Filter by skill name (e.g. 'memory', 'notes', 'firecrawl')",
            },
            status: {
              type: "string",
              enum: ["success", "error", "blocked"],
              description: "Filter by call status",
            },
            since_hours: {
              type: "number",
              description: "Only return records from the last N hours (default: 24, max: 168)",
            },
            limit: {
              type: "number",
              description: "Max records to return (default: 20, max: 100)",
            },
          },
          required: [],
        },
      },
      {
        name: "audit_stats",
        description:
          "Get aggregate statistics from the audit log: total calls, success rate, top tools, and error breakdown.",
        mainAgentOnly: true,
        input_schema: {
          type: "object" as const,
          properties: {
            since_hours: {
              type: "number",
              description: "Stats window in hours (default: 24, max: 168)",
            },
          },
          required: [],
        },
      },
    ];
  }

  async execute(toolName: string, input: Record<string, unknown>): Promise<string> {
    if (toolName === "audit_query") {
      return this.handleQuery(input);
    }
    if (toolName === "audit_stats") {
      return this.handleStats(input);
    }
    throw new Error(`Unknown tool: ${toolName}`);
  }

  private async handleQuery(input: Record<string, unknown>): Promise<string> {
    const sinceHours = Math.min(Number(input.since_hours ?? 24), 168);
    const limit = Math.min(Number(input.limit ?? 20), 100);

    const records = await this.auditService.query({
      toolName: input.tool_name as string | undefined,
      skillName: input.skill_name as string | undefined,
      status: input.status as string | undefined,
      sinceHours,
      limit,
    });

    if (records.length === 0) {
      return "No audit records found matching the specified filters.";
    }

    const lines = records.map((r) => {
      const ts = r.createdAt.toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
      const duration = r.durationMs != null ? `${r.durationMs}ms` : "—";
      const parts = [
        `[${ts}]`,
        `${r.status.toUpperCase()}`,
        r.toolName ? `tool=${r.toolName}` : `event=${r.eventType}`,
        r.skillName ? `skill=${r.skillName}` : null,
        `duration=${duration}`,
        r.tier ? `tier=${r.tier}` : null,
        r.inputSummary ? `input=${r.inputSummary}` : null,
      ].filter(Boolean);
      return parts.join(" | ");
    });

    return `Audit log (${records.length} records, last ${sinceHours}h):\n\n${lines.join("\n")}`;
  }

  private async handleStats(input: Record<string, unknown>): Promise<string> {
    const sinceHours = Math.min(Number(input.since_hours ?? 24), 168);
    const stats = await this.auditService.getStats(sinceHours);

    const lines = [
      `Audit Statistics (last ${sinceHours}h):`,
      `Total tool calls: ${stats.totalCalls}`,
      `Success rate: ${(stats.successRate * 100).toFixed(1)}%`,
      "",
      "Top tools by call count:",
      ...stats.topTools.map((t) => `  ${t.toolName}: ${t.count}`),
    ];

    if (stats.errorsByTool.length > 0) {
      lines.push("", "Tools with errors:");
      for (const e of stats.errorsByTool) {
        lines.push(`  ${e.toolName}: ${e.count} errors`);
      }
    }

    return lines.join("\n");
  }

  getRequiredConfig(): string[] {
    return [];
  }

  async startup(_ctx: SkillContext): Promise<void> {}

  async shutdown(): Promise<void> {}
}
