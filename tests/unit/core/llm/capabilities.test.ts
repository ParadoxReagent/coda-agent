import { describe, it, expect } from "vitest";
import {
  DEFAULT_ANTHROPIC_CAPABILITIES,
  DEFAULT_GOOGLE_CAPABILITIES,
  DEFAULT_OPENAI_COMPAT_CAPABILITIES,
  mergeCapabilities,
} from "../../../../src/core/llm/capabilities.js";

describe("Provider Capabilities", () => {
  describe("default capabilities", () => {
    it("Anthropic has correct defaults", () => {
      expect(DEFAULT_ANTHROPIC_CAPABILITIES).toEqual({
        tools: true,
        parallelToolCalls: true,
        usageMetrics: true,
        jsonMode: true,
        streaming: true,
      });
    });

    it("Google has correct defaults (parallelToolCalls false)", () => {
      expect(DEFAULT_GOOGLE_CAPABILITIES).toEqual({
        tools: true,
        parallelToolCalls: false,
        usageMetrics: true,
        jsonMode: true,
        streaming: true,
      });
    });

    it("OpenAI-compat has correct defaults", () => {
      expect(DEFAULT_OPENAI_COMPAT_CAPABILITIES).toEqual({
        tools: true,
        parallelToolCalls: true,
        usageMetrics: true,
        jsonMode: true,
        streaming: true,
      });
    });
  });

  describe("mergeCapabilities", () => {
    it("returns defaults when no overrides", () => {
      const result = mergeCapabilities(DEFAULT_ANTHROPIC_CAPABILITIES);
      expect(result).toEqual(DEFAULT_ANTHROPIC_CAPABILITIES);
    });

    it("overrides specific capabilities from config", () => {
      const result = mergeCapabilities(DEFAULT_OPENAI_COMPAT_CAPABILITIES, {
        tools: "model_dependent",
        usage_metrics: false,
      });
      expect(result.tools).toBe("model_dependent");
      expect(result.usageMetrics).toBe(false);
      // Unoverridden fields stay at defaults
      expect(result.parallelToolCalls).toBe(true);
      expect(result.jsonMode).toBe(true);
    });

    it("handles empty overrides object", () => {
      const result = mergeCapabilities(DEFAULT_GOOGLE_CAPABILITIES, {});
      expect(result).toEqual(DEFAULT_GOOGLE_CAPABILITIES);
    });
  });
});
