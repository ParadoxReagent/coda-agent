import type { Skill, SkillToolDefinition } from "./base.js";
import type { SkillContext } from "./context.js";
import type { LLMToolDefinition } from "../core/llm/provider.js";
import type { Logger } from "../utils/logger.js";

interface RegisteredSkill {
  skill: Skill;
  tools: Map<string, SkillToolDefinition>;
}

export class SkillRegistry {
  private skills: Map<string, RegisteredSkill> = new Map();
  private toolToSkill: Map<string, string> = new Map();
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
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

    // Index tools
    const tools = new Map<string, SkillToolDefinition>();
    for (const tool of skill.getTools()) {
      if (this.toolToSkill.has(tool.name)) {
        this.logger.warn(
          {
            tool: tool.name,
            existingSkill: this.toolToSkill.get(tool.name),
            newSkill: skill.name,
          },
          "Duplicate tool name, overwriting"
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

  /** Get all tool definitions across all registered skills. */
  getToolDefinitions(): LLMToolDefinition[] {
    const definitions: LLMToolDefinition[] = [];
    for (const { tools } of this.skills.values()) {
      for (const tool of tools.values()) {
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
    toolInput: Record<string, unknown>
  ): Promise<string> {
    const skillName = this.toolToSkill.get(toolName);
    if (!skillName) {
      throw new Error(`Unknown tool: ${toolName}`);
    }

    const registered = this.skills.get(skillName);
    if (!registered) {
      throw new Error(`Skill "${skillName}" not found`);
    }

    return registered.skill.execute(toolName, toolInput);
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

  /** Get a registered skill by name. */
  getSkillByName(name: string): Skill | undefined {
    return this.skills.get(name)?.skill;
  }

  /** List all registered skills with their descriptions. */
  listSkills(): Array<{ name: string; description: string; tools: string[] }> {
    return Array.from(this.skills.values()).map(({ skill, tools }) => ({
      name: skill.name,
      description: skill.description,
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
