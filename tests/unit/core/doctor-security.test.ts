import { describe, it, expect, beforeEach } from "vitest";
import { ErrorStore } from "../../../src/core/doctor/error-store.js";
import { SkillRegistry } from "../../../src/skills/registry.js";
import { SkillHealthTracker } from "../../../src/core/skill-health.js";
import { createMockLogger, createMockSkill } from "../../helpers/mocks.js";

describe("Doctor Security", () => {
  describe("Error Message Sanitization", () => {
    let store: ErrorStore;

    beforeEach(() => {
      store = new ErrorStore(500);
    });

    it("redacts long tokens from error messages", () => {
      store.push({
        category: "transient",
        strategy: "retry",
        source: "test",
        signature: "test:sig",
        message: "Authentication failed with token sk-ant-api03-1234567890abcdef1234567890abcdef",
      });

      const recent = store.getRecent(10000);
      expect(recent[0]!.message).not.toContain("sk-ant-api03-1234567890abcdef1234567890abcdef");
      expect(recent[0]!.message).toContain("<REDACTED_TOKEN>");
    });

    it("redacts credentials from database URLs", () => {
      store.push({
        category: "transient",
        strategy: "retry",
        source: "test",
        signature: "test:sig",
        message: "Failed to connect to postgres://admin:secret123@db.prod:5432/app",
      });

      const recent = store.getRecent(10000);
      expect(recent[0]!.message).not.toContain("secret123");
      expect(recent[0]!.message).toContain("<REDACTED_CREDENTIAL>");
    });

    it("redacts standalone credentials", () => {
      store.push({
        category: "transient",
        strategy: "retry",
        source: "test",
        signature: "test:sig",
        message: "Login failed for user:password@database",
      });

      const recent = store.getRecent(10000);
      expect(recent[0]!.message).toContain("<REDACTED_CREDENTIAL>@");
    });

    it("redacts IP addresses", () => {
      store.push({
        category: "transient",
        strategy: "retry",
        source: "test",
        signature: "test:sig",
        message: "Connection refused from 192.168.1.100",
      });

      const recent = store.getRecent(10000);
      expect(recent[0]!.message).not.toContain("192.168.1.100");
      expect(recent[0]!.message).toContain("<IP>");
    });

    it("redacts API key patterns", () => {
      store.push({
        category: "transient",
        strategy: "retry",
        source: "test",
        signature: "test:sig",
        message: "Invalid api_key=abc123def456 provided",
      });

      const recent = store.getRecent(10000);
      expect(recent[0]!.message).not.toContain("abc123def456");
      expect(recent[0]!.message).toContain("api_key=<REDACTED>");
    });

    it("truncates messages to 200 characters", () => {
      const longMessage = "a".repeat(500);
      store.push({
        category: "transient",
        strategy: "retry",
        source: "test",
        signature: "test:sig",
        message: longMessage,
      });

      const recent = store.getRecent(10000);
      expect(recent[0]!.message.length).toBeLessThanOrEqual(200);
    });
  });

  describe("mainAgentOnly Runtime Enforcement", () => {
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

    it("allows main agent to call mainAgentOnly tools", async () => {
      const skill = createMockSkill({
        name: "restricted",
        tools: [
          {
            name: "admin_tool",
            description: "Admin only tool",
            input_schema: { type: "object", properties: {} },
            mainAgentOnly: true,
          },
        ],
        executeFn: async () => "success",
      });
      registry.register(skill);

      const result = await registry.executeToolCall(
        "admin_tool",
        {},
        { isSubagent: false }
      );
      expect(result).toBe("success");
    });

    it("blocks subagent from calling mainAgentOnly tools", async () => {
      const skill = createMockSkill({
        name: "restricted",
        tools: [
          {
            name: "admin_tool",
            description: "Admin only tool",
            input_schema: { type: "object", properties: {} },
            mainAgentOnly: true,
          },
        ],
        executeFn: async () => "success",
      });
      registry.register(skill);

      const result = await registry.executeToolCall(
        "admin_tool",
        {},
        { isSubagent: true }
      );
      expect(result).toContain("restricted to the main agent only");
      expect(result).not.toBe("success");
    });

    it("allows subagent to call non-restricted tools", async () => {
      const skill = createMockSkill({
        name: "unrestricted",
        tools: [
          {
            name: "normal_tool",
            description: "Normal tool",
            input_schema: { type: "object", properties: {} },
            mainAgentOnly: false,
          },
        ],
        executeFn: async () => "success",
      });
      registry.register(skill);

      const result = await registry.executeToolCall(
        "normal_tool",
        {},
        { isSubagent: true }
      );
      expect(result).toBe("success");
    });

    it("allows both when mainAgentOnly is undefined", async () => {
      const skill = createMockSkill({
        name: "unrestricted",
        tools: [
          {
            name: "normal_tool",
            description: "Normal tool",
            input_schema: { type: "object", properties: {} },
          },
        ],
        executeFn: async () => "success",
      });
      registry.register(skill);

      // Main agent
      const mainResult = await registry.executeToolCall(
        "normal_tool",
        {},
        { isSubagent: false }
      );
      expect(mainResult).toBe("success");

      // Subagent
      const subResult = await registry.executeToolCall(
        "normal_tool",
        {},
        { isSubagent: true }
      );
      expect(subResult).toBe("success");
    });
  });

  describe("Error Deduplication", () => {
    let store: ErrorStore;

    beforeEach(() => {
      store = new ErrorStore(500);
    });

    it("stores first few occurrences of same error signature", () => {
      for (let i = 0; i < 5; i++) {
        store.push({
          category: "transient",
          strategy: "retry",
          source: "test",
          signature: "test:repeated",
          message: "same error",
        });
      }

      expect(store.getSize()).toBe(5);
    });

    it("stops storing after deduplication threshold", () => {
      for (let i = 0; i < 20; i++) {
        store.push({
          category: "transient",
          strategy: "retry",
          source: "test",
          signature: "test:spam",
          message: "spam error",
        });
      }

      // Should stop at 10 (DEDUP_THRESHOLD)
      expect(store.getSize()).toBeLessThanOrEqual(10);
    });

    it("allows different signatures through deduplication", () => {
      for (let i = 0; i < 15; i++) {
        store.push({
          category: "transient",
          strategy: "retry",
          source: "test",
          signature: `test:sig${i}`,
          message: `error ${i}`,
        });
      }

      // All 15 should be stored (different signatures)
      expect(store.getSize()).toBe(15);
    });
  });
});
