import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentSkillsSkill } from "../../../../src/skills/agent-skills/skill.js";
import { createMockAgentSkillDiscovery } from "../../../helpers/mocks.js";

describe("AgentSkillsSkill", () => {
  let skill: AgentSkillsSkill;
  let mockDiscovery: ReturnType<typeof createMockAgentSkillDiscovery>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDiscovery = createMockAgentSkillDiscovery();
    skill = new AgentSkillsSkill(mockDiscovery as never);
  });

  it("has correct metadata", () => {
    expect(skill.name).toBe("agent-skills");
    expect(skill.getRequiredConfig()).toEqual([]);
  });

  it("registers 2 tools", () => {
    const tools = skill.getTools();
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name)).toEqual([
      "skill_activate",
      "skill_read_resource",
    ]);
  });

  describe("skill_activate", () => {
    it("returns instructions and resource list", async () => {
      mockDiscovery.activateSkill.mockReturnValue("# PDF\n\nExtract text from PDFs.");
      mockDiscovery.listResources.mockReturnValue(["scripts/extract.sh", "references/api.md"]);

      const result = await skill.execute("skill_activate", {
        skill_name: "pdf",
      });

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.skill).toBe("pdf");
      expect(parsed.instructions).toContain("Extract text from PDFs");
      expect(parsed.resources).toHaveLength(2);
      expect(mockDiscovery.activateSkill).toHaveBeenCalledWith("pdf");
    });

    it("returns error for unknown skill", async () => {
      mockDiscovery.activateSkill.mockImplementation(() => {
        throw new Error('Unknown agent skill: "nonexistent"');
      });

      const result = await skill.execute("skill_activate", {
        skill_name: "nonexistent",
      });

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.message).toContain("Unknown agent skill");
    });

    it("omits resources array when none available", async () => {
      mockDiscovery.activateSkill.mockReturnValue("# Simple\n\nNo resources.");
      mockDiscovery.listResources.mockReturnValue([]);

      const result = await skill.execute("skill_activate", {
        skill_name: "simple",
      });

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.resources).toBeUndefined();
    });
  });

  describe("skill_read_resource", () => {
    it("reads resource content from activated skill", async () => {
      mockDiscovery.readResource.mockReturnValue("#!/bin/bash\necho hello");

      const result = await skill.execute("skill_read_resource", {
        skill_name: "pdf",
        resource_path: "scripts/extract.sh",
      });

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.content).toContain("#!/bin/bash");
      expect(mockDiscovery.readResource).toHaveBeenCalledWith("pdf", "scripts/extract.sh");
    });

    it("returns error when skill not activated", async () => {
      mockDiscovery.readResource.mockImplementation(() => {
        throw new Error('Skill "locked" must be activated before reading resources');
      });

      const result = await skill.execute("skill_read_resource", {
        skill_name: "locked",
        resource_path: "scripts/test.sh",
      });

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.message).toContain("must be activated");
    });

    it("returns error for path traversal attempts", async () => {
      mockDiscovery.readResource.mockImplementation(() => {
        throw new Error("Path traversal not allowed");
      });

      const result = await skill.execute("skill_read_resource", {
        skill_name: "evil",
        resource_path: "../../../etc/passwd",
      });

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.message).toContain("Path traversal");
    });
  });

  it("returns unknown tool message for invalid tool", async () => {
    const result = await skill.execute("skill_invalid", {});
    expect(result).toContain("Unknown tool");
  });
});
