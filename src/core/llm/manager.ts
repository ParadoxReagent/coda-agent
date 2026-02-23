import type { LLMProvider } from "./provider.js";
import type { AppConfig, ProviderConfig } from "../../utils/config.js";
import type { EventBus } from "../events.js";
import { createProvider } from "./factory.js";
import { UsageTracker } from "./usage.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import { ResilientLLMProvider } from "./resilient-provider.js";
import type { Logger } from "../../utils/logger.js";

export interface ProviderSelection {
  provider: LLMProvider;
  model: string;
  failedOver?: boolean;
  originalProvider?: string;
}

export interface TierSelection extends ProviderSelection {
  tier: "light" | "heavy";
}

export interface ProviderInfo {
  name: string;
  models: string[];
  capabilities: LLMProvider["capabilities"];
}

/**
 * Manages multiple LLM providers, per-user preferences, usage tracking,
 * and automatic failover when providers become unavailable.
 */
export class ProviderManager {
  private providers: Map<string, LLMProvider> = new Map();
  private circuitBreakers: Map<string, CircuitBreaker> = new Map();
  private providerModels: Map<string, string[]> = new Map();
  private userPreferences: Map<string, { provider: string; model: string }> =
    new Map();
  private userTierPreferences: Map<
    string,
    { light?: { provider: string; model: string }; heavy?: { provider: string; model: string } }
  > = new Map();
  private defaultProvider: string;
  private defaultModel: string;
  private failoverChain: string[];
  private tiersEnabled: boolean;
  private tierConfig?: {
    light: { provider: string; model: string };
    heavy: { provider: string; model: string };
    showTier: boolean;
  };
  readonly usage: UsageTracker;
  private logger: Logger;

  constructor(config: AppConfig["llm"], logger: Logger, eventBus?: EventBus) {
    this.defaultProvider = config.default_provider;
    this.defaultModel = config.default_model;
    this.failoverChain = config.failover_chain ?? [];
    this.tiersEnabled = config.tiers?.enabled ?? false;
    this.tierConfig = config.tiers?.enabled
      ? {
          light: config.tiers.light,
          heavy: config.tiers.heavy,
          showTier: config.tiers.show_tier ?? false,
        }
      : undefined;
    this.usage = new UsageTracker(
      config.cost_per_million_tokens,
      config.daily_spend_alert_threshold,
      logger,
      eventBus
    );
    this.logger = logger;

    // Initialize all configured providers with circuit breakers
    for (const [name, providerConfig] of Object.entries(config.providers)) {
      try {
        const rawProvider = createProvider(name, providerConfig as ProviderConfig);
        const breaker = new CircuitBreaker();
        this.circuitBreakers.set(name, breaker);

        const resilientProvider = new ResilientLLMProvider(
          rawProvider,
          breaker,
          logger,
          eventBus
        );
        this.providers.set(name, resilientProvider);
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
    return this.getWithFailover(userId);
  }

  /**
   * Get the best available provider for a user.
   * If the preferred provider's circuit breaker is open, walk the failover chain.
   */
  async getWithFailover(userId: string): Promise<ProviderSelection> {
    const pref = this.userPreferences.get(userId);
    const preferredProviderName = pref?.provider ?? this.defaultProvider;
    const preferredModel = pref?.model ?? this.defaultModel;

    return this.resolveProviderWithFailover(userId, preferredProviderName, preferredModel);
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

  /** Get provider and model for a specific tier. */
  async getForUserTiered(
    userId: string,
    tier: "light" | "heavy"
  ): Promise<TierSelection> {
    if (!this.tiersEnabled || !this.tierConfig) {
      // Tiers disabled, fall back to regular getForUser
      const selection = await this.getForUser(userId);
      return { ...selection, tier };
    }

    // Check if user has a tier-specific preference
    const tierPrefs = this.userTierPreferences.get(userId);
    const tierPref = tierPrefs?.[tier];

    const preferredProviderName = tierPref?.provider ?? this.tierConfig[tier].provider;
    const preferredModel = tierPref?.model ?? this.tierConfig[tier].model;

    const selection = await this.resolveProviderWithFailover(
      userId,
      preferredProviderName,
      preferredModel,
      tier
    );
    return { ...selection, tier };
  }

  /** Set a user's tier-specific provider and model preference. */
  setUserTierPreference(
    userId: string,
    tier: "light" | "heavy",
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

    const existing = this.userTierPreferences.get(userId) ?? {};
    existing[tier] = { provider: providerName, model };
    this.userTierPreferences.set(userId, existing);
  }

  /** Check if tiers are enabled. */
  isTierEnabled(): boolean {
    return this.tiersEnabled;
  }

  /** Get tier configuration and user preferences for a user. */
  getUserTierStatus(userId: string): {
    enabled: boolean;
    light?: { provider: string; model: string };
    heavy?: { provider: string; model: string };
    userPreferences?: {
      light?: { provider: string; model: string };
      heavy?: { provider: string; model: string };
    };
  } {
    if (!this.tiersEnabled || !this.tierConfig) {
      return { enabled: false };
    }

    const userPrefs = this.userTierPreferences.get(userId);

    return {
      enabled: true,
      light: this.tierConfig.light,
      heavy: this.tierConfig.heavy,
      userPreferences: userPrefs,
    };
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
    usage: { inputTokens: number | null; outputTokens: number | null },
    tier?: "light" | "heavy"
  ): Promise<void> {
    await this.usage.track(providerName, model, usage, tier);
  }

  /** Get a specific provider by name (for testing/internal use). */
  getProvider(name: string): LLMProvider | undefined {
    return this.providers.get(name);
  }

  /** Get circuit breaker state for a provider (for health checks). */
  getProviderHealth(name: string): string {
    const breaker = this.circuitBreakers.get(name);
    return breaker?.getState() ?? "unknown";
  }

  /**
   * Resolve a provider by name with failover through the chain.
   * Shared logic for both regular and tiered provider resolution.
   */
  private async resolveProviderWithFailover(
    userId: string,
    preferredProviderName: string,
    preferredModel: string,
    tier?: "light" | "heavy"
  ): Promise<ProviderSelection> {
    const tierLabel = tier ? ` for tier ${tier}` : "";

    // Check if preferred provider is available
    const breaker = this.circuitBreakers.get(preferredProviderName);
    if (breaker && breaker.canExecute()) {
      const provider = this.providers.get(preferredProviderName);
      if (provider) {
        return { provider, model: preferredModel };
      }
    }

    // Failover: walk the chain
    for (const fallbackName of this.failoverChain) {
      if (fallbackName === preferredProviderName) continue;

      const fallbackBreaker = this.circuitBreakers.get(fallbackName);
      if (fallbackBreaker && !fallbackBreaker.canExecute()) continue;

      const fallbackProvider = this.providers.get(fallbackName);
      if (!fallbackProvider) continue;

      const models = this.providerModels.get(fallbackName);
      const fallbackModel = models?.[0] ?? preferredModel;

      this.logger.warn(
        { userId, ...(tier && { tier }), originalProvider: preferredProviderName, fallbackProvider: fallbackName },
        `Failing over to alternate LLM provider${tierLabel}`
      );

      return {
        provider: fallbackProvider,
        model: fallbackModel,
        failedOver: true,
        originalProvider: preferredProviderName,
      };
    }

    // Try all remaining providers
    for (const [name, provider] of this.providers) {
      if (name === preferredProviderName) continue;

      const provBreaker = this.circuitBreakers.get(name);
      if (provBreaker && !provBreaker.canExecute()) continue;

      const models = this.providerModels.get(name);
      const model = models?.[0] ?? preferredModel;

      this.logger.warn(
        { userId, ...(tier && { tier }), originalProvider: preferredProviderName, fallbackProvider: name },
        `All failover chain providers unavailable${tierLabel}, using any available provider`
      );

      return {
        provider,
        model,
        failedOver: true,
        originalProvider: preferredProviderName,
      };
    }

    // All providers down
    throw new Error(
      "All LLM providers are currently unavailable. Please try again later."
    );
  }
}
