import { describe, it, expect, vi, beforeEach } from "vitest";
import { SubagentSkill } from "../../../../src/skills/subagents/skill.js";
import { createMockSubagentManager, createMockSkillContext } from "../../../helpers/mocks.js";

// Mock correlation module
vi.mock("../../../../src/core/correlation.js", () => ({
  getCurrentContext: vi.fn(() => ({
    correlationId: "test-corr",
    userId: "user-123",
    channel: "discord",
  })),
}));

describe("SubagentSkill", () => {
  let skill: SubagentSkill;
  let mockManager: ReturnType<typeof createMockSubagentManager>;

  beforeEach(() => {
    mockManager = createMockSubagentManager();
    skill = new SubagentSkill(mockManager as any);
  });

  describe("getTools()", () => {
    it("returns all 7 tools", () => {
      const tools = skill.getTools();
      expect(tools).toHaveLength(7);
    });

    it("marks delegate_to_subagent as mainAgentOnly", () => {
      const tool = skill.getTools().find((t) => t.name === "delegate_to_subagent");
      expect(tool?.mainAgentOnly).toBe(true);
    });

    it("marks sessions_spawn as mainAgentOnly", () => {
      const tool = skill.getTools().find((t) => t.name === "sessions_spawn");
      expect(tool?.mainAgentOnly).toBe(true);
    });

    it("marks sessions_stop as mainAgentOnly with requiresConfirmation", () => {
      const tool = skill.getTools().find((t) => t.name === "sessions_stop");
      expect(tool?.mainAgentOnly).toBe(true);
      expect(tool?.requiresConfirmation).toBe(true);
    });

    it("sessions_list is NOT mainAgentOnly", () => {
      const tool = skill.getTools().find((t) => t.name === "sessions_list");
      expect(tool?.mainAgentOnly).toBeUndefined();
    });

    it("sessions_log is NOT mainAgentOnly", () => {
      const tool = skill.getTools().find((t) => t.name === "sessions_log");
      expect(tool?.mainAgentOnly).toBeUndefined();
    });

    it("has correct tool names", () => {
      const names = skill.getTools().map((t) => t.name);
      expect(names).toContain("delegate_to_subagent");
      expect(names).toContain("sessions_spawn");
      expect(names).toContain("sessions_list");
      expect(names).toContain("sessions_stop");
      expect(names).toContain("sessions_log");
      expect(names).toContain("sessions_info");
      expect(names).toContain("sessions_send");
    });
  });

  describe("execute()", () => {
    it("routes delegate_to_subagent to delegateSync", async () => {
      const result = await skill.execute("delegate_to_subagent", {
        task: "Search for notes",
        tools_needed: ["note_search"],
      });
      expect(mockManager.delegateSync).toHaveBeenCalledWith(
        "user-123",
        "discord",
        "Search for notes",
        expect.objectContaining({ toolsNeeded: ["note_search"] })
      );
    });

    it("routes sessions_spawn to spawn", async () => {
      const result = await skill.execute("sessions_spawn", {
        task: "Research topic",
      });
      expect(mockManager.spawn).toHaveBeenCalledWith(
        "user-123",
        "discord",
        "Research topic",
        expect.any(Object)
      );
      expect(result).toContain("accepted");
    });

    it("routes sessions_list to listRuns", async () => {
      mockManager.listRuns.mockReturnValue([]);
      const result = await skill.execute("sessions_list", {});
      expect(mockManager.listRuns).toHaveBeenCalledWith("user-123");
      expect(result).toBe("No active sub-agent runs.");
    });

    it("routes sessions_stop to stopRun", async () => {
      const result = await skill.execute("sessions_stop", {
        run_id: "test-run-id",
      });
      expect(mockManager.stopRun).toHaveBeenCalledWith("user-123", "test-run-id");
    });

    it("routes sessions_log to getRunLog", async () => {
      mockManager.getRunLog.mockReturnValue([]);
      const result = await skill.execute("sessions_log", {
        run_id: "test-run-id",
      });
      expect(mockManager.getRunLog).toHaveBeenCalledWith("user-123", "test-run-id");
    });

    it("routes sessions_info to getRunInfo", async () => {
      mockManager.getRunInfo.mockReturnValue(null);
      const result = await skill.execute("sessions_info", {
        run_id: "test-run-id",
      });
      expect(mockManager.getRunInfo).toHaveBeenCalledWith("user-123", "test-run-id");
    });

    it("returns error when manager is not initialized", async () => {
      const uninitSkill = new SubagentSkill();
      const result = await uninitSkill.execute("sessions_list", {});
      expect(result).toContain("not initialized");
    });
  });

  describe("metadata", () => {
    it("has correct name and description", () => {
      expect(skill.name).toBe("subagents");
      expect(skill.description).toContain("sub-agents");
    });

    it("requires no config", () => {
      expect(skill.getRequiredConfig()).toEqual([]);
    });
  });

  describe("setManager()", () => {
    it("allows setting manager after construction", async () => {
      const uninitSkill = new SubagentSkill();
      expect(await uninitSkill.execute("sessions_list", {})).toContain("not initialized");

      uninitSkill.setManager(mockManager as any);
      mockManager.listRuns.mockReturnValue([]);
      expect(await uninitSkill.execute("sessions_list", {})).toBe("No active sub-agent runs.");
    });
  });
});
