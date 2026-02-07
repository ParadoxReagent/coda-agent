import { describe, it, expect } from "vitest";
import { createProvider } from "../../../../src/core/llm/factory.js";
import { AnthropicProvider } from "../../../../src/core/llm/anthropic.js";
import { GoogleProvider } from "../../../../src/core/llm/google.js";
import { OpenAICompatProvider } from "../../../../src/core/llm/openai-compat.js";

describe("createProvider", () => {
  it('creates AnthropicProvider for type "anthropic"', () => {
    const provider = createProvider("anthropic", {
      type: "anthropic",
      api_key: "test-key",
      models: ["claude-sonnet-4-5-20250514"],
    });
    expect(provider).toBeInstanceOf(AnthropicProvider);
    expect(provider.name).toBe("anthropic");
  });

  it('creates GoogleProvider for type "google"', () => {
    const provider = createProvider("google", {
      type: "google",
      api_key: "test-key",
      models: ["gemini-2.0-flash"],
    });
    expect(provider).toBeInstanceOf(GoogleProvider);
    expect(provider.name).toBe("google");
  });

  it('creates OpenAICompatProvider for type "openai_compat"', () => {
    const provider = createProvider("openai", {
      type: "openai_compat",
      api_key: "test-key",
      base_url: "https://api.openai.com/v1",
      models: ["gpt-4o"],
    });
    expect(provider).toBeInstanceOf(OpenAICompatProvider);
    expect(provider.name).toBe("openai");
  });

  it("passes defaultHeaders to OpenAI-compat provider", () => {
    const provider = createProvider("openrouter", {
      type: "openai_compat",
      api_key: "test-key",
      base_url: "https://openrouter.ai/api/v1",
      models: ["anthropic/claude-sonnet-4-5"],
      default_headers: { "HTTP-Referer": "https://coda.local" },
    });
    expect(provider).toBeInstanceOf(OpenAICompatProvider);
    expect(provider.name).toBe("openrouter");
  });

  it("passes capability overrides from config", () => {
    const provider = createProvider("ollama", {
      type: "openai_compat",
      api_key: "ollama",
      base_url: "http://localhost:11434/v1",
      models: ["llama3.1:8b"],
      capabilities: {
        tools: "model_dependent",
        usage_metrics: false,
      },
    });
    expect(provider.capabilities.tools).toBe("model_dependent");
    expect(provider.capabilities.usageMetrics).toBe(false);
  });

  it("throws for unknown provider type", () => {
    expect(() =>
      createProvider("unknown", {
        type: "magic" as "anthropic",
        api_key: "key",
        models: [],
      })
    ).toThrow("Unknown provider type");
  });
});
