/**
 * Public SDK contract for coda skills.
 * This interface must remain stable — changes require a major version bump.
 */
import type { LLMToolDefinition } from "../core/llm/provider.js";
import type { SkillContext } from "./context.js";

/** Extended tool definition with coda-specific metadata. */
export interface SkillToolDefinition extends LLMToolDefinition {
  /** If true, the skill executor requires user confirmation before executing. */
  requiresConfirmation?: boolean;
  /** If true, this tool is excluded from subagent tool lists. */
  mainAgentOnly?: boolean;
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
