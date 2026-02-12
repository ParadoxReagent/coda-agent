import { describe, it, expect, vi, beforeEach } from "vitest";
import { SkillRegistry } from "../../../src/skills/registry.js";
import { createMockSkill, createMockLogger, createMockSkillContext } from "../../helpers/mocks.js";

describe("SkillRegistry", () => {
  let registry: SkillRegistry;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
    registry = new SkillRegistry(logger);
  });

  it("registers a skill and includes its tools in getToolDefinitions", () => {
    const skill = createMockSkill({
      name: "email",
      tools: [
        {
          name: "email_check",
          description: "Check emails",
          input_schema: { type: "object", properties: {} },
        },
      ],
    });

    registry.register(skill);

    const tools = registry.getToolDefinitions();
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("email_check");
  });

  it("routeToolCall returns the correct skill for a given tool name", () => {
    const skill = createMockSkill({ name: "plex" });
    registry.register(skill);

    const found = registry.getSkillForTool("plex_action");
    expect(found).toBeDefined();
    expect(found!.name).toBe("plex");
  });

  it("getSkillForTool returns undefined for unknown tool names", () => {
    const found = registry.getSkillForTool("nonexistent_tool");
    expect(found).toBeUndefined();
  });

  it("executeToolCall throws for unknown tool names", async () => {
    await expect(
      registry.executeToolCall("nonexistent_tool", {})
    ).rejects.toThrow("Unknown tool");
  });

  it("rejects skills with missing required config", () => {
    const skill = createMockSkill({
      name: "secured",
      requiredConfig: ["api_key", "secret"],
    });

    expect(() => registry.register(skill, {})).toThrow("missing required config");
  });

  it("accepts skills when all required config is present", () => {
    const skill = createMockSkill({
      name: "secured",
      requiredConfig: ["api_key"],
    });

    expect(() =>
      registry.register(skill, { api_key: "test" })
    ).not.toThrow();
  });

  it("calls startup with SkillContext on all skills during startupAll", async () => {
    const skill1 = createMockSkill({ name: "skill1" });
    const skill2 = createMockSkill({ name: "skill2" });

    registry.register(skill1);
    registry.register(skill2);

    await registry.startupAll((name) => createMockSkillContext(name));

    expect(skill1.startup).toHaveBeenCalledOnce();
    expect(skill2.startup).toHaveBeenCalledOnce();
  });

  it("calls shutdown on all skills during shutdownAll", async () => {
    const skill = createMockSkill({ name: "test" });
    registry.register(skill);

    await registry.shutdownAll();

    expect(skill.shutdown).toHaveBeenCalledOnce();
  });

  it("skill crash during startup logs error but does not prevent others", async () => {
    const badSkill = createMockSkill({ name: "bad" });
    (badSkill.startup as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("Startup crash")
    );
    const goodSkill = createMockSkill({ name: "good" });

    registry.register(badSkill);
    registry.register(goodSkill);

    await registry.startupAll((name) => createMockSkillContext(name));

    expect(logger.error).toHaveBeenCalled();
    expect(goodSkill.startup).toHaveBeenCalledOnce();
  });

  it("tools with requiresConfirmation are flagged correctly", () => {
    const skill = createMockSkill({
      name: "dangerous",
      tools: [
        {
          name: "danger_action",
          description: "Destructive",
          input_schema: { type: "object", properties: {} },
          requiresConfirmation: true,
        },
        {
          name: "safe_action",
          description: "Safe",
          input_schema: { type: "object", properties: {} },
        },
      ],
    });

    registry.register(skill);

    expect(registry.toolRequiresConfirmation("danger_action")).toBe(true);
    expect(registry.toolRequiresConfirmation("safe_action")).toBe(false);
  });

  describe("getToolDefinitions filtering", () => {
    it("filters by allowedSkills", () => {
      const emailSkill = createMockSkill({
        name: "email",
        tools: [{ name: "email_check", description: "Check", input_schema: { type: "object", properties: {} } }],
      });
      const notesSkill = createMockSkill({
        name: "notes",
        tools: [{ name: "note_search", description: "Search", input_schema: { type: "object", properties: {} } }],
      });
      registry.register(emailSkill);
      registry.register(notesSkill);

      const tools = registry.getToolDefinitions({ allowedSkills: ["notes"] });
      expect(tools.map((t) => t.name)).toContain("note_search");
      expect(tools.map((t) => t.name)).not.toContain("email_check");
    });

    it("filters by blockedTools", () => {
      const skill = createMockSkill({
        name: "notes",
        tools: [
          { name: "note_search", description: "Search", input_schema: { type: "object", properties: {} } },
          { name: "note_save", description: "Save", input_schema: { type: "object", properties: {} } },
        ],
      });
      registry.register(skill);

      const tools = registry.getToolDefinitions({ blockedTools: ["note_save"] });
      expect(tools.map((t) => t.name)).toContain("note_search");
      expect(tools.map((t) => t.name)).not.toContain("note_save");
    });

    it("excludes mainAgentOnly tools when excludeMainAgentOnly is true", () => {
      const skill = createMockSkill({
        name: "subagents",
        tools: [
          { name: "sessions_spawn", description: "Spawn", input_schema: { type: "object", properties: {} }, mainAgentOnly: true },
          { name: "sessions_list", description: "List", input_schema: { type: "object", properties: {} } },
        ],
      });
      registry.register(skill);

      const tools = registry.getToolDefinitions({ excludeMainAgentOnly: true });
      expect(tools.map((t) => t.name)).not.toContain("sessions_spawn");
      expect(tools.map((t) => t.name)).toContain("sessions_list");
    });

    it("includes all tools when no filtering options are provided", () => {
      const skill = createMockSkill({
        name: "test",
        tools: [
          { name: "tool_a", description: "A", input_schema: { type: "object", properties: {} }, mainAgentOnly: true },
          { name: "tool_b", description: "B", input_schema: { type: "object", properties: {} } },
        ],
      });
      registry.register(skill);

      const tools = registry.getToolDefinitions();
      expect(tools).toHaveLength(2);
    });
  });

  it("listSkills returns all registered skills", () => {
    registry.register(createMockSkill({ name: "email", description: "Email skill" }));
    registry.register(createMockSkill({ name: "plex", description: "Plex skill" }));

    const list = registry.listSkills();
    expect(list).toHaveLength(2);
    expect(list.map((s) => s.name)).toContain("email");
    expect(list.map((s) => s.name)).toContain("plex");
  });
});
