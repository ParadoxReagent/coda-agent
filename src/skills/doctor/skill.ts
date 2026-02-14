import type { Skill, SkillToolDefinition } from "../base.js";
import type { SkillContext } from "../context.js";
import type { Logger } from "../../utils/logger.js";
import type { DoctorService } from "../../core/doctor/doctor-service.js";
import type { SkillHealthTracker } from "../../core/skill-health.js";

export class DoctorSkill implements Skill {
  readonly name = "doctor";
  readonly description = "System diagnostics and self-healing — check health, reset degraded skills";

  private logger!: Logger;
  private doctorService: DoctorService;
  private skillHealthTracker: SkillHealthTracker;

  constructor(doctorService: DoctorService, skillHealthTracker: SkillHealthTracker) {
    this.doctorService = doctorService;
    this.skillHealthTracker = skillHealthTracker;
  }

  getTools(): SkillToolDefinition[] {
    return [
      {
        name: "doctor_diagnose",
        description:
          "Run a system diagnostic. Returns health status for skills, providers, recent errors, and detected patterns.",
        input_schema: {
          type: "object",
          properties: {
            focus: {
              type: "string",
              enum: ["all", "skills", "providers", "errors", "patterns"],
              description:
                "What to focus the diagnostic on. Defaults to 'all'.",
            },
          },
        },
        mainAgentOnly: true,
      },
      {
        name: "doctor_reset_skill",
        description:
          "Reset a degraded or unavailable skill back to healthy status. Use after fixing the underlying issue.",
        input_schema: {
          type: "object",
          properties: {
            skill_name: {
              type: "string",
              description: "The name of the skill to reset",
            },
          },
          required: ["skill_name"],
        },
        requiresConfirmation: true,
        mainAgentOnly: true,
      },
    ];
  }

  async execute(
    toolName: string,
    toolInput: Record<string, unknown>
  ): Promise<string> {
    switch (toolName) {
      case "doctor_diagnose":
        return this.diagnose(toolInput);
      case "doctor_reset_skill":
        return this.resetSkill(toolInput);
      default:
        return `Unknown tool: ${toolName}`;
    }
  }

  getRequiredConfig(): string[] {
    return [];
  }

  async startup(ctx: SkillContext): Promise<void> {
    this.logger = ctx.logger;
    this.logger.info("Doctor skill started");
  }

  async shutdown(): Promise<void> {
    this.logger?.info("Doctor skill stopped");
  }

  private diagnose(input: Record<string, unknown>): string {
    const focus = (input.focus as string) ?? "all";
    const report = this.doctorService.getDiagnostics(
      focus as "all" | "skills" | "providers" | "errors" | "patterns"
    );

    return JSON.stringify(report, null, 2);
  }

  private resetSkill(input: Record<string, unknown>): string {
    const skillName = input.skill_name as string;
    if (!skillName) {
      return JSON.stringify({ success: false, message: "skill_name is required" });
    }

    const health = this.skillHealthTracker.getHealth(skillName);
    const previousStatus = health.status;

    this.skillHealthTracker.resetSkill(skillName);

    this.logger.info(
      { skill: skillName, previousStatus },
      "Skill reset by doctor"
    );

    return JSON.stringify({
      success: true,
      skill: skillName,
      previousStatus,
      currentStatus: "healthy",
      message: `Skill "${skillName}" has been reset from "${previousStatus}" to "healthy".`,
    });
  }
}
