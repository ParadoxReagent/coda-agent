import type { LLMProvider } from "./provider.js";
import type { AppConfig, ProviderConfig } from "../../utils/config.js";
import { createProvider } from "./factory.js";
import { UsageTracker } from "./usage.js";
import type { Logger } from "../../utils/logger.js";

export interface ProviderSelection {
  provider: LLMProvider;
  model: string;
}

export interface ProviderInfo {
  name: string;
  models: string[];
  capabilities: LLMProvider["capabilities"];
}

/**
 * Manages multiple LLM providers, per-user preferences, and usage tracking.
 */
export class ProviderManager {
  private providers: Map<string, LLMProvider> = new Map();
  private providerModels: Map<string, string[]> = new Map();
  private userPreferences: Map<string, { provider: string; model: string }> =
    new Map();
  private defaultProvider: string;
  private defaultModel: string;
  readonly usage: UsageTracker;
  private logger: Logger;

  constructor(config: AppConfig["llm"], logger: Logger) {
    this.defaultProvider = config.default_provider;
    this.defaultModel = config.default_model;
    this.usage = new UsageTracker(
      config.cost_per_million_tokens,
      config.daily_spend_alert_threshold,
      logger
    );
    this.logger = logger;

    // Initialize all configured providers
    for (const [name, providerConfig] of Object.entries(config.providers)) {
      try {
        const provider = createProvider(name, providerConfig as ProviderConfig);
        this.providers.set(name, provider);
        this.providerModels.set(name, (providerConfig as ProviderConfig).models);
        this.logger.info({ provider: name }, "LLM provider initialized");
      } catch (err) {
        this.logger.error(
          { provider: name, error: err },
          "Failed to initialize LLM provider"
        );
      }
    }
  }

  /** Get the provider and model for a user (falls back to defaults). */
  async getForUser(userId: string): Promise<ProviderSelection> {
    const pref = this.userPreferences.get(userId);

    if (pref) {
      const provider = this.providers.get(pref.provider);
      if (provider) {
        return { provider, model: pref.model };
      }
      this.logger.warn(
        { userId, provider: pref.provider },
        "User preferred provider not available, falling back to default"
      );
    }

    const provider = this.providers.get(this.defaultProvider);
    if (!provider) {
      throw new Error(
        `Default provider "${this.defaultProvider}" is not available`
      );
    }

    return { provider, model: this.defaultModel };
  }

  /** Set a user's preferred provider and model. */
  setUserPreference(
    userId: string,
    providerName: string,
    model: string
  ): void {
    if (!this.providers.has(providerName)) {
      throw new Error(`Provider "${providerName}" is not configured`);
    }
    const models = this.providerModels.get(providerName);
    if (models && !models.includes(model)) {
      throw new Error(
        `Model "${model}" is not available for provider "${providerName}". Available: ${models.join(", ")}`
      );
    }
    this.userPreferences.set(userId, { provider: providerName, model });
  }

  /** List all available providers and their models. */
  listProviders(): ProviderInfo[] {
    const result: ProviderInfo[] = [];
    for (const [name, provider] of this.providers) {
      result.push({
        name,
        models: this.providerModels.get(name) ?? [],
        capabilities: provider.capabilities,
      });
    }
    return result;
  }

  /** Track token usage for a request. */
  async trackUsage(
    providerName: string,
    model: string,
    usage: { inputTokens: number | null; outputTokens: number | null }
  ): Promise<void> {
    await this.usage.track(providerName, model, usage);
  }

  /** Get a specific provider by name (for testing/internal use). */
  getProvider(name: string): LLMProvider | undefined {
    return this.providers.get(name);
  }
}
