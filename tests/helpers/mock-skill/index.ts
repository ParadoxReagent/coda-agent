import type { Skill, SkillToolDefinition } from "../../../src/skills/base.js";
import type { SkillContext } from "../../../src/skills/context.js";

export default class TestSkill implements Skill {
  readonly name = "test-skill";
  readonly description = "A test skill for integration testing";

  getTools(): SkillToolDefinition[] {
    return [
      {
        name: "test_echo",
        description: "Echoes the input back",
        input_schema: {
          type: "object",
          properties: {
            message: { type: "string", description: "Message to echo" },
          },
          required: ["message"],
        },
      },
      {
        name: "test_confirm",
        description: "A destructive action that requires confirmation",
        input_schema: {
          type: "object",
          properties: {
            target: { type: "string", description: "Target to destroy" },
          },
        },
        requiresConfirmation: true,
      },
    ];
  }

  async execute(
    toolName: string,
    toolInput: Record<string, unknown>
  ): Promise<string> {
    switch (toolName) {
      case "test_echo":
        return `Echo: ${toolInput.message}`;
      case "test_confirm":
        return `Confirmed destruction of ${toolInput.target}`;
      default:
        return `Unknown tool: ${toolName}`;
    }
  }

  getRequiredConfig(): string[] {
    return [];
  }

  async startup(_ctx: SkillContext): Promise<void> {}
  async shutdown(): Promise<void> {}
}
