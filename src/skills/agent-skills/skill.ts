import type { Skill, SkillToolDefinition } from "../base.js";
import type { SkillContext } from "../context.js";
import type { AgentSkillDiscovery } from "../agent-skill-discovery.js";

export class AgentSkillsSkill implements Skill {
  readonly name = "agent-skills";
  readonly description =
    "Activate and read resources from instruction-based agent skills";

  private discovery: AgentSkillDiscovery;

  constructor(discovery: AgentSkillDiscovery) {
    this.discovery = discovery;
  }

  getTools(): SkillToolDefinition[] {
    return [
      {
        name: "skill_activate",
        description:
          "Activate an agent skill by name. Returns the full SKILL.md instructions and a list of available supplementary resources.",
        input_schema: {
          type: "object",
          properties: {
            skill_name: {
              type: "string",
              description: "Name of the agent skill to activate",
            },
          },
          required: ["skill_name"],
        },
      },
      {
        name: "skill_rescan",
        description:
          "Re-scan agent skill directories to discover new or removed skills without restarting. Use when the user says /rescan-skills or asks to reload skills.",
        mainAgentOnly: true,
        input_schema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        name: "skill_read_resource",
        description:
          "Read a supplementary resource file from an activated agent skill (scripts/, references/, or assets/).",
        input_schema: {
          type: "object",
          properties: {
            skill_name: {
              type: "string",
              description: "Name of the activated agent skill",
            },
            resource_path: {
              type: "string",
              description:
                'Path to the resource file (e.g., "scripts/setup.sh", "references/api.md")',
            },
          },
          required: ["skill_name", "resource_path"],
        },
      },
    ];
  }

  async execute(
    toolName: string,
    toolInput: Record<string, unknown>
  ): Promise<string> {
    switch (toolName) {
      case "skill_activate":
        return this.activateSkill(toolInput);
      case "skill_rescan":
        return this.rescanSkills();
      case "skill_read_resource":
        return this.readResource(toolInput);
      default:
        return `Unknown tool: ${toolName}`;
    }
  }

  getRequiredConfig(): string[] {
    return [];
  }

  async startup(_ctx: SkillContext): Promise<void> {
    // No-op — discovery is done before registration
  }

  async shutdown(): Promise<void> {
    // No-op
  }

  private activateSkill(input: Record<string, unknown>): string {
    const skillName = input.skill_name as string;

    try {
      const instructions = this.discovery.activateSkill(skillName);
      const resources = this.discovery.listResources(skillName);

      return JSON.stringify({
        success: true,
        skill: skillName,
        instructions,
        resources: resources.length > 0 ? resources : undefined,
        message:
          resources.length > 0
            ? `Skill "${skillName}" activated. ${resources.length} resource(s) available — use skill_read_resource to access them.`
            : `Skill "${skillName}" activated.`,
      });
    } catch (err) {
      return JSON.stringify({
        success: false,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private rescanSkills(): string {
    try {
      const { added, removed } = this.discovery.rescan();
      const total = this.discovery.getSkillMetadataList().length;
      return JSON.stringify({
        success: true,
        total,
        added: added.length > 0 ? added : undefined,
        removed: removed.length > 0 ? removed : undefined,
        message:
          added.length === 0 && removed.length === 0
            ? `Rescan complete. ${total} skill(s) found, no changes.`
            : `Rescan complete. ${total} skill(s) found. Added: ${added.length}, Removed: ${removed.length}.`,
      });
    } catch (err) {
      return JSON.stringify({
        success: false,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private readResource(input: Record<string, unknown>): string {
    const skillName = input.skill_name as string;
    const resourcePath = input.resource_path as string;

    try {
      const content = this.discovery.readResource(skillName, resourcePath);
      return JSON.stringify({
        success: true,
        skill: skillName,
        path: resourcePath,
        content,
      });
    } catch (err) {
      return JSON.stringify({
        success: false,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
