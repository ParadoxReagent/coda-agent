import type { Skill, SkillToolDefinition } from "./base.js";
import type { SkillContext } from "./context.js";
import type { LLMToolDefinition } from "../core/llm/provider.js";
import type { Logger } from "../utils/logger.js";
import { ToolInputValidator } from "../core/tool-validator.js";
import type { SkillHealthTracker } from "../core/skill-health.js";
import type { RateLimiter } from "../core/rate-limiter.js";
import { ContentSanitizer } from "../core/sanitizer.js";

interface RegisteredSkill {
  skill: Skill;
  tools: Map<string, SkillToolDefinition>;
}

const DEFAULT_SKILL_RATE_LIMITS: Record<string, { maxRequests: number; windowSeconds: number }> = {
  notes: { maxRequests: 100, windowSeconds: 3600 },
  reminders: { maxRequests: 50, windowSeconds: 3600 },
  n8n: { maxRequests: 100, windowSeconds: 3600 },
  memory: { maxRequests: 100, windowSeconds: 3600 },
  firecrawl: { maxRequests: 30, windowSeconds: 60 },
  weather: { maxRequests: 60, windowSeconds: 3600 },
};

export class SkillRegistry {
  private skills: Map<string, RegisteredSkill> = new Map();
  private toolToSkill: Map<string, string> = new Map();
  private logger: Logger;
  private healthTracker?: SkillHealthTracker;
  private rateLimiter?: RateLimiter;

  constructor(
    logger: Logger,
    healthTracker?: SkillHealthTracker,
    rateLimiter?: RateLimiter
  ) {
    this.logger = logger;
    this.healthTracker = healthTracker;
    this.rateLimiter = rateLimiter;
  }

  /** Register a skill — validates config requirements and indexes tools. */
  register(
    skill: Skill,
    availableConfig: Record<string, unknown> = {}
  ): void {
    // Validate required config
    const missing = skill.getRequiredConfig().filter(
      (key) => !(key in availableConfig)
    );
    if (missing.length > 0) {
      this.logger.error(
        { skill: skill.name, missingConfig: missing },
        "Skill missing required config, skipping"
      );
      throw new Error(
        `Skill "${skill.name}" missing required config: ${missing.join(", ")}`
      );
    }

    // Index tools — reject collisions
    const tools = new Map<string, SkillToolDefinition>();
    for (const tool of skill.getTools()) {
      if (this.toolToSkill.has(tool.name)) {
        const existingSkill = this.toolToSkill.get(tool.name)!;
        throw new Error(
          `Skill "${skill.name}" tool "${tool.name}" collides with existing tool from skill "${existingSkill}"`
        );
      }
      tools.set(tool.name, tool);
      this.toolToSkill.set(tool.name, skill.name);
    }

    this.skills.set(skill.name, { skill, tools });
    this.logger.info(
      { skill: skill.name, toolCount: tools.size },
      "Skill registered"
    );
  }

  /** Get all tool definitions across all registered skills, with optional filtering. */
  getToolDefinitions(options?: {
    allowedSkills?: string[];
    blockedTools?: string[];
    excludeMainAgentOnly?: boolean;
  }): LLMToolDefinition[] {
    const definitions: LLMToolDefinition[] = [];
    for (const [skillName, { tools }] of this.skills) {
      // Filter by allowed skills if specified
      if (options?.allowedSkills && !options.allowedSkills.includes(skillName)) {
        continue;
      }

      for (const tool of tools.values()) {
        // Filter out blocked tools
        if (options?.blockedTools?.includes(tool.name)) {
          continue;
        }

        // Filter out mainAgentOnly tools when requested
        if (options?.excludeMainAgentOnly && tool.mainAgentOnly) {
          continue;
        }

        definitions.push({
          name: tool.name,
          description: tool.description,
          input_schema: tool.input_schema,
        });
      }
    }
    return definitions;
  }

  /** Find which skill owns a tool. */
  getSkillForTool(toolName: string): Skill | undefined {
    const skillName = this.toolToSkill.get(toolName);
    if (!skillName) return undefined;
    return this.skills.get(skillName)?.skill;
  }

  /** Route and execute a tool call. */
  async executeToolCall(
    toolName: string,
    toolInput: Record<string, unknown>,
    context?: { isSubagent?: boolean; userId?: string }
  ): Promise<string> {
    const skillName = this.toolToSkill.get(toolName);
    if (!skillName) {
      throw new Error(`Unknown tool: ${toolName}`);
    }

    const registered = this.skills.get(skillName);
    if (!registered) {
      throw new Error(`Skill "${skillName}" not found`);
    }

    // Check skill health
    if (this.healthTracker && !this.healthTracker.isAvailable(skillName)) {
      return `The ${skillName} skill is temporarily unavailable. Please try again later.`;
    }

    // Check rate limit
    if (this.rateLimiter) {
      const rateConfig = DEFAULT_SKILL_RATE_LIMITS[skillName] ?? {
        maxRequests: 60,
        windowSeconds: 3600,
      };
      const limitResult = await this.rateLimiter.check(
        "skill",
        skillName,
        rateConfig
      );
      if (!limitResult.allowed) {
        return `The ${skillName} skill has reached its rate limit. Please try again in ${limitResult.retryAfterSeconds} seconds.`;
      }
    }

    // Validate tool input against schema
    const toolDef = registered.tools.get(toolName);
    if (toolDef) {
      // Security: enforce mainAgentOnly restriction at runtime
      if (toolDef.mainAgentOnly && context?.isSubagent) {
        this.logger.warn(
          { tool: toolName, skill: skillName, isSubagent: true },
          "Subagent attempted to call mainAgentOnly tool"
        );
        return `Tool "${toolName}" is restricted to the main agent only.`;
      }

      const validation = ToolInputValidator.validate(
        toolName,
        toolDef.input_schema,
        toolInput
      );
      if (!validation.valid) {
        this.logger.warn(
          { tool: toolName, errors: validation.errors },
          "Tool input validation failed"
        );
        return `Invalid input for ${toolName}: ${validation.errors!.join("; ")}`;
      }
    }

    // Log sensitive tool access at info level
    if (toolDef?.sensitive) {
      this.logger.info(
        {
          skill: skillName,
          tool: toolName,
          inputSummary: Object.keys(toolInput).join(", "),
          userId: context?.userId,
        },
        "Sensitive tool accessed"
      );
    }

    // Execute with health tracking
    const startMs = Date.now();
    try {
      const result = await registered.skill.execute(toolName, toolInput);
      this.healthTracker?.recordSuccess(skillName);

      // Audit log
      this.logger.debug(
        {
          skill: skillName,
          tool: toolName,
          inputKeys: Object.keys(toolInput),
          durationMs: Date.now() - startMs,
          status: "success",
          external: !this.isInternalSkill(skillName),
        },
        "Tool call executed"
      );

      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.healthTracker?.recordFailure(skillName, error);

      this.logger.debug(
        {
          skill: skillName,
          tool: toolName,
          inputKeys: Object.keys(toolInput),
          durationMs: Date.now() - startMs,
          status: "error",
          external: !this.isInternalSkill(skillName),
        },
        "Tool call failed"
      );

      // Return user-friendly error with sanitized message
      const sanitized = ContentSanitizer.sanitizeErrorMessage(error.message);
      return `Error executing ${toolName}: ${sanitized}`;
    }
  }

  /** Get all registered tool names (for collision detection). */
  getRegisteredToolNames(): Set<string> {
    return new Set(this.toolToSkill.keys());
  }

  private isInternalSkill(skillName: string): boolean {
    const internalSkills = new Set([
      "notes", "reminders", "scheduler", "n8n", "memory", "firecrawl", "weather",
    ]);
    return internalSkills.has(skillName);
  }

  /** Check if a tool requires confirmation. */
  toolRequiresConfirmation(toolName: string): boolean {
    const skillName = this.toolToSkill.get(toolName);
    if (!skillName) return false;

    const registered = this.skills.get(skillName);
    if (!registered) return false;

    const tool = registered.tools.get(toolName);
    return tool?.requiresConfirmation === true;
  }

  /** Check if a tool is marked as sensitive (accesses private data). */
  isSensitiveTool(toolName: string): boolean {
    const skillName = this.toolToSkill.get(toolName);
    if (!skillName) return false;

    const registered = this.skills.get(skillName);
    if (!registered) return false;

    const tool = registered.tools.get(toolName);
    return tool?.sensitive === true;
  }

  /** Get a registered skill by name. */
  getSkillByName(name: string): Skill | undefined {
    return this.skills.get(name)?.skill;
  }

  /** List all registered skills with their descriptions. */
  listSkills(): Array<{ name: string; description: string; kind: string; tools: string[] }> {
    return Array.from(this.skills.values()).map(({ skill, tools }) => ({
      name: skill.name,
      description: skill.description,
      kind: skill.kind ?? "skill",
      tools: Array.from(tools.keys()),
    }));
  }

  /** Start all registered skills. */
  async startupAll(
    contextFactory: (skillName: string) => SkillContext
  ): Promise<void> {
    for (const [name, { skill }] of this.skills) {
      try {
        const ctx = contextFactory(name);
        await skill.startup(ctx);
        this.logger.info({ skill: name }, "Skill started");
      } catch (err) {
        this.logger.error(
          { skill: name, error: err },
          "Skill startup failed — skill will be unavailable"
        );
      }
    }
  }

  /** Shut down all registered skills. */
  async shutdownAll(): Promise<void> {
    for (const [name, { skill }] of this.skills) {
      try {
        await skill.shutdown();
        this.logger.info({ skill: name }, "Skill stopped");
      } catch (err) {
        this.logger.error(
          { skill: name, error: err },
          "Skill shutdown error"
        );
      }
    }
  }
}
