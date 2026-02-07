import { describe, it, expect, beforeEach } from "vitest";
import { ProviderManager } from "../../../../src/core/llm/manager.js";
import { createMockLogger } from "../../../helpers/mocks.js";

function createManagerConfig(providerOverrides?: Record<string, unknown>) {
  return {
    default_provider: "anthropic",
    default_model: "claude-sonnet-4-5-20250514",
    providers: {
      anthropic: {
        type: "anthropic" as const,
        api_key: "test-key",
        models: ["claude-sonnet-4-5-20250514", "claude-haiku-3-5-20241022"],
      },
      openai: {
        type: "openai_compat" as const,
        api_key: "test-key",
        base_url: "https://api.openai.com/v1",
        models: ["gpt-4o", "gpt-4o-mini"],
      },
      ...providerOverrides,
    },
  };
}

describe("ProviderManager", () => {
  let manager: ProviderManager;

  beforeEach(() => {
    manager = new ProviderManager(createManagerConfig(), createMockLogger());
  });

  it("returns default provider/model when user has no preference", async () => {
    const { provider, model } = await manager.getForUser("new-user");
    expect(provider.name).toBe("anthropic");
    expect(model).toBe("claude-sonnet-4-5-20250514");
  });

  it("returns user's preferred provider/model when set", async () => {
    manager.setUserPreference("user1", "openai", "gpt-4o");
    const { provider, model } = await manager.getForUser("user1");
    expect(provider.name).toBe("openai");
    expect(model).toBe("gpt-4o");
  });

  it("setUserPreference persists and getForUser retrieves", async () => {
    manager.setUserPreference("user1", "openai", "gpt-4o-mini");
    const result = await manager.getForUser("user1");
    expect(result.model).toBe("gpt-4o-mini");
  });

  it("falls back to default if user's preferred provider is unavailable", async () => {
    // Set a preference
    manager.setUserPreference("user1", "openai", "gpt-4o");

    // Create a new manager without OpenAI
    const newManager = new ProviderManager(
      {
        default_provider: "anthropic",
        default_model: "claude-sonnet-4-5-20250514",
        providers: {
          anthropic: {
            type: "anthropic",
            api_key: "test",
            models: ["claude-sonnet-4-5-20250514"],
          },
        },
      },
      createMockLogger()
    );

    // New manager doesn't have the user's preference stored
    const { provider } = await newManager.getForUser("user1");
    expect(provider.name).toBe("anthropic");
  });

  it("lists all available providers and their models", () => {
    const providers = manager.listProviders();
    expect(providers).toHaveLength(2);

    const anthropic = providers.find((p) => p.name === "anthropic");
    expect(anthropic).toBeDefined();
    expect(anthropic!.models).toContain("claude-sonnet-4-5-20250514");

    const openai = providers.find((p) => p.name === "openai");
    expect(openai).toBeDefined();
    expect(openai!.models).toContain("gpt-4o");
  });

  it("throws when setting preference for unconfigured provider", () => {
    expect(() =>
      manager.setUserPreference("user1", "nonexistent", "model")
    ).toThrow('Provider "nonexistent" is not configured');
  });

  it("throws when setting preference for unavailable model", () => {
    expect(() =>
      manager.setUserPreference("user1", "anthropic", "nonexistent-model")
    ).toThrow("not available for provider");
  });
});
