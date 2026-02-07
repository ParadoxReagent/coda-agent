import { readFileSync, existsSync } from "node:fs";
import yaml from "js-yaml";
import { z } from "zod";

const ProviderCapabilitiesSchema = z.object({
  tools: z.union([z.boolean(), z.literal("model_dependent")]).optional(),
  parallel_tool_calls: z.boolean().optional(),
  usage_metrics: z.boolean().optional(),
  json_mode: z.boolean().optional(),
  streaming: z.boolean().optional(),
});

const ProviderConfigSchema = z.object({
  type: z.enum(["anthropic", "google", "openai_compat"]),
  api_key: z.string(),
  base_url: z.string().optional(),
  models: z.array(z.string()),
  default_headers: z.record(z.string()).optional(),
  capabilities: ProviderCapabilitiesSchema.optional(),
});

const LLMConfigSchema = z.object({
  default_provider: z.string(),
  default_model: z.string(),
  providers: z.record(ProviderConfigSchema),
  cost_per_million_tokens: z
    .record(z.object({ input: z.number(), output: z.number() }))
    .optional(),
  daily_spend_alert_threshold: z.number().optional(),
});

const ExternalPolicySchema = z.object({
  mode: z.enum(["strict", "dev"]).default("strict"),
  trusted_signing_keys: z.array(z.string()).default([]),
  allow_unsigned_local: z.boolean().default(false),
  allowed_local_unsigned_dirs: z.array(z.string()).default([]),
});

const SkillsConfigSchema = z.object({
  external_dirs: z.array(z.string()).default([]),
  external_policy: ExternalPolicySchema.default({}),
});

const DiscordConfigSchema = z.object({
  bot_token: z.string(),
  channel_id: z.string(),
  allowed_user_ids: z.array(z.string()),
});

const AppConfigSchema = z.object({
  llm: LLMConfigSchema,
  skills: SkillsConfigSchema.default({}),
  discord: DiscordConfigSchema,
  redis: z.object({ url: z.string().default("redis://localhost:6379") }).default({}),
  database: z
    .object({
      url: z
        .string()
        .default("postgresql://coda:coda@localhost:5432/coda"),
    })
    .default({}),
  server: z
    .object({
      port: z.number().default(3000),
      host: z.string().default("0.0.0.0"),
    })
    .default({}),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type ProviderCapabilitiesConfig = z.infer<typeof ProviderCapabilitiesSchema>;

/**
 * Load configuration from YAML file with environment variable overrides.
 * Env vars take precedence over YAML values for sensitive fields.
 */
export function loadConfig(configPath?: string): AppConfig {
  const path = configPath ?? process.env.CONFIG_PATH ?? "./config/config.yaml";

  let rawConfig: Record<string, unknown> = {};

  if (existsSync(path)) {
    const fileContent = readFileSync(path, "utf-8");
    rawConfig = yaml.load(fileContent) as Record<string, unknown>;
  }

  // Apply environment variable overrides
  applyEnvOverrides(rawConfig);

  return AppConfigSchema.parse(rawConfig);
}

function applyEnvOverrides(config: Record<string, unknown>): void {
  // Ensure nested objects exist
  const llm = ensureObject(config, "llm");
  const providers = ensureObject(llm, "providers");
  const discord = ensureObject(config, "discord");
  const redis = ensureObject(config, "redis");
  const database = ensureObject(config, "database");

  // Discord overrides
  if (process.env.DISCORD_BOT_TOKEN) discord.bot_token = process.env.DISCORD_BOT_TOKEN;
  if (process.env.DISCORD_CHANNEL_ID) discord.channel_id = process.env.DISCORD_CHANNEL_ID;
  if (process.env.DISCORD_ALLOWED_USER_IDS) {
    discord.allowed_user_ids = process.env.DISCORD_ALLOWED_USER_IDS.split(",");
  }

  // Redis override
  if (process.env.REDIS_URL) redis.url = process.env.REDIS_URL;

  // Database override
  if (process.env.DATABASE_URL) database.url = process.env.DATABASE_URL;

  // LLM provider API key overrides
  if (process.env.ANTHROPIC_API_KEY) {
    const anthropic = ensureObject(providers, "anthropic");
    anthropic.api_key = process.env.ANTHROPIC_API_KEY;
    if (!anthropic.type) anthropic.type = "anthropic";
    if (!anthropic.models) anthropic.models = ["claude-sonnet-4-5-20250514"];
  }

  if (process.env.GOOGLE_API_KEY) {
    const google = ensureObject(providers, "google");
    google.api_key = process.env.GOOGLE_API_KEY;
    if (!google.type) google.type = "google";
    if (!google.models) google.models = ["gemini-2.0-flash"];
  }

  if (process.env.OPENAI_API_KEY) {
    const openai = ensureObject(providers, "openai");
    openai.api_key = process.env.OPENAI_API_KEY;
    if (!openai.type) openai.type = "openai_compat";
    if (!openai.base_url) openai.base_url = "https://api.openai.com/v1";
    if (!openai.models) openai.models = ["gpt-4o"];
  }

  if (process.env.OPENROUTER_API_KEY) {
    const openrouter = ensureObject(providers, "openrouter");
    openrouter.api_key = process.env.OPENROUTER_API_KEY;
    if (!openrouter.type) openrouter.type = "openai_compat";
    if (!openrouter.base_url)
      openrouter.base_url = "https://openrouter.ai/api/v1";
    if (!openrouter.models)
      openrouter.models = ["anthropic/claude-sonnet-4-5"];
  }

  // Set defaults for llm config
  if (!llm.default_provider) {
    llm.default_provider = Object.keys(providers)[0] ?? "anthropic";
  }
  if (!llm.default_model) {
    const defaultProviderConfig = providers[llm.default_provider as string] as
      | Record<string, unknown>
      | undefined;
    const models = defaultProviderConfig?.models as string[] | undefined;
    llm.default_model = models?.[0] ?? "claude-sonnet-4-5-20250514";
  }
}

function ensureObject(
  parent: Record<string, unknown>,
  key: string
): Record<string, unknown> {
  if (!parent[key] || typeof parent[key] !== "object") {
    parent[key] = {};
  }
  return parent[key] as Record<string, unknown>;
}
