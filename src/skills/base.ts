/**
 * Public SDK contract for coda skills.
 * This interface must remain stable — changes require a major version bump.
 */
import type { LLMToolDefinition } from "../core/llm/provider.js";
import type { SkillContext } from "./context.js";

/**
 * Permission tier for a tool — controls confirmation and audit behaviour.
 *
 * | Tier | Scope | Behaviour |
 * |------|-------|-----------|
 * | 0 | Read-only | Always allowed; no confirmation |
 * | 1 | Write personal data | Auto-approved; audit logged |
 * | 2 | External read | Logged, allowed (default for unannotated tools) |
 * | 3 | External action / destructive | Requires user confirmation |
 * | 4 | Irreversible | Requires confirmation + enforced delay |
 */
export type PermissionTier = 0 | 1 | 2 | 3 | 4;

/** Extended tool definition with coda-specific metadata. */
export interface SkillToolDefinition extends LLMToolDefinition {
  /** If true, the skill executor requires user confirmation before executing. */
  requiresConfirmation?: boolean;
  /** If true, this tool is excluded from subagent tool lists. */
  mainAgentOnly?: boolean;
  /** If set to "heavy", this tool triggers escalation from light to heavy tier. */
  tierHint?: "heavy";
  /** If true, tool accesses private data. Logged at info level; confirmation enforced per sensitive_tool_policy. */
  sensitive?: boolean;
  /**
   * Permission tier (0–4). Controls confirmation requirements and audit behaviour.
   * Defaults to 2 if not set. Tier ≥3 requires user confirmation.
   * Tools with requiresConfirmation=true are treated as tier 3 if permissionTier is unset.
   */
  permissionTier?: PermissionTier;
  /**
   * If true, this tool will be critiqued by CritiqueService even if its tier
   * is below critique_min_tier. Useful for lower-tier tools that have external side effects.
   */
  requiresCritique?: boolean;
}

/** The contract every skill must implement. */
export interface Skill {
  readonly name: string;
  readonly description: string;
  readonly kind?: "skill" | "integration";

  /** Return provider-agnostic tool definitions. */
  getTools(): SkillToolDefinition[];

  /** Execute a tool call and return results as a string. */
  execute(
    toolName: string,
    toolInput: Record<string, unknown>
  ): Promise<string>;

  /** Config keys this skill needs (validated at startup). */
  getRequiredConfig(): string[];

  /** Called during skill startup with access to coda services. */
  startup(ctx: SkillContext): Promise<void>;

  /** Called during graceful shutdown. */
  shutdown(): Promise<void>;
}
