import { describe, it, expect, beforeEach } from "vitest";
import { SkillRegistry } from "../../../src/skills/registry.js";
import { SkillHealthTracker } from "../../../src/core/skill-health.js";
import {
  createMockLogger,
  createMockSkill,
} from "../../helpers/mocks.js";

describe("Skill Hardening", () => {
  let registry: SkillRegistry;
  let healthTracker: SkillHealthTracker;

  beforeEach(() => {
    healthTracker = new SkillHealthTracker({
      degradedThreshold: 2,
      unavailableThreshold: 4,
      recoveryWindowMs: 100,
    });
    registry = new SkillRegistry(createMockLogger(), healthTracker);
  });

  describe("Tool name collision", () => {
    it("rejects skill with tool name that collides with internal skill", () => {
      const skill1 = createMockSkill({
        name: "internal",
        tools: [
          {
            name: "shared_tool",
            description: "First tool",
            input_schema: { type: "object", properties: {} },
          },
        ],
      });
      const skill2 = createMockSkill({
        name: "external",
        tools: [
          {
            name: "shared_tool",
            description: "Duplicate tool",
            input_schema: { type: "object", properties: {} },
          },
        ],
      });

      registry.register(skill1);
      expect(() => registry.register(skill2)).toThrow(
        'tool "shared_tool" collides'
      );
    });
  });

  describe("getRegisteredToolNames", () => {
    it("returns all registered tool names", () => {
      const skill = createMockSkill({
        name: "test",
        tools: [
          {
            name: "test_action",
            description: "A test action",
            input_schema: { type: "object", properties: {} },
          },
          {
            name: "test_query",
            description: "A test query",
            input_schema: { type: "object", properties: {} },
          },
        ],
      });
      registry.register(skill);

      const names = registry.getRegisteredToolNames();
      expect(names.has("test_action")).toBe(true);
      expect(names.has("test_query")).toBe(true);
      expect(names.size).toBe(2);
    });
  });

  describe("Skill execution crash handling", () => {
    it("catches skill execution crash and returns error message", async () => {
      const skill = createMockSkill({
        name: "crashy",
        executeFn: async () => {
          throw new Error("Unexpected crash!");
        },
      });
      registry.register(skill);

      const result = await registry.executeToolCall("crashy_action", {});
      expect(result).toContain("Error executing crashy_action");
      expect(result).toContain("Unexpected crash!");
    });

    it("does not propagate stack traces to user", async () => {
      const skill = createMockSkill({
        name: "crashy",
        executeFn: async () => {
          throw new Error("DB connection failed");
        },
      });
      registry.register(skill);

      const result = await registry.executeToolCall("crashy_action", {});
      expect(result).not.toContain("at ");
      expect(result).toContain("DB connection failed");
    });
  });

  describe("Skill degraded after consecutive failures", () => {
    it("marks skill degraded after threshold failures", async () => {
      const skill = createMockSkill({
        name: "failing",
        executeFn: async () => {
          throw new Error("Service unavailable");
        },
      });
      registry.register(skill);

      for (let i = 0; i < 2; i++) {
        await registry.executeToolCall("failing_action", {});
      }

      expect(healthTracker.getHealth("failing").status).toBe("degraded");
    });

    it("marks skill unavailable after more failures", async () => {
      const skill = createMockSkill({
        name: "broken",
        executeFn: async () => {
          throw new Error("Service unavailable");
        },
      });
      registry.register(skill);

      for (let i = 0; i < 4; i++) {
        await registry.executeToolCall("broken_action", {});
      }

      expect(healthTracker.getHealth("broken").status).toBe("unavailable");
    });

    it("returns unavailable message when skill is down", async () => {
      const skill = createMockSkill({
        name: "down",
        executeFn: async () => {
          throw new Error("Service unavailable");
        },
      });
      registry.register(skill);

      // Exhaust health
      for (let i = 0; i < 4; i++) {
        await registry.executeToolCall("down_action", {});
      }

      const result = await registry.executeToolCall("down_action", {});
      expect(result).toContain("temporarily unavailable");
    });
  });

  describe("Skill recovery", () => {
    it("recovers after cooldown and success", async () => {
      let shouldFail = true;
      const skill = createMockSkill({
        name: "recoverable",
        executeFn: async () => {
          if (shouldFail) throw new Error("fail");
          return "ok";
        },
      });
      registry.register(skill);

      // Break it
      for (let i = 0; i < 4; i++) {
        await registry.executeToolCall("recoverable_action", {});
      }
      expect(healthTracker.getHealth("recoverable").status).toBe("unavailable");

      // Wait for recovery window
      await new Promise((r) => setTimeout(r, 150));

      // Fix it and retry
      shouldFail = false;
      const result = await registry.executeToolCall("recoverable_action", {});
      expect(result).toBe("ok");
      expect(healthTracker.getHealth("recoverable").status).toBe("healthy");
    });
  });
});
