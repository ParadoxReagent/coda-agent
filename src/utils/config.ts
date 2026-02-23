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

const TierConfigSchema = z.object({
  enabled: z.boolean().default(false),
  light: z.object({
    provider: z.string(),
    model: z.string(),
  }),
  heavy: z.object({
    provider: z.string(),
    model: z.string(),
  }),
  heavy_tools: z.array(z.string()).default([]),
  heavy_patterns: z.array(z.string()).default([]),
  heavy_message_length: z.number().default(800),
  show_tier: z.boolean().default(false),
});

const LLMConfigSchema = z.object({
  default_provider: z.string(),
  default_model: z.string(),
  providers: z.record(ProviderConfigSchema),
  cost_per_million_tokens: z
    .record(z.object({ input: z.number(), output: z.number() }))
    .optional(),
  daily_spend_alert_threshold: z.number().optional(),
  failover_chain: z.array(z.string()).optional(),
  tiers: TierConfigSchema.optional(),
});

const SigningKeySchema = z.object({
  id: z.string(),
  publicKey: z.string(), // Ed25519 public key in base64 or PEM format
});

const ExternalPolicySchema = z.object({
  mode: z.enum(["strict", "dev"]).default("strict"),
  trusted_signing_keys: z.array(SigningKeySchema).default([]),
  allow_unsigned_local: z.boolean().default(false),
  allowed_local_unsigned_dirs: z.array(z.string()).default([]),
});

const SkillsConfigSchema = z.object({
  external_dirs: z.array(z.string()).default([]),
  external_policy: ExternalPolicySchema.default({}),
  agent_skill_dirs: z.array(z.string()).default([]),
  allow_executable_resources: z.boolean().default(true),
});

const DiscordConfigSchema = z.object({
  bot_token: z.string(),
  channel_id: z.string(),
  allowed_user_ids: z.array(z.string()),
});

const SlackConfigSchema = z.object({
  app_token: z.string(),
  bot_token: z.string(),
  channel_id: z.string(),
  allowed_user_ids: z.array(z.string()),
});

const TelegramConfigSchema = z.object({
  bot_token: z.string(),
  chat_id: z.string(),
  allowed_user_ids: z.array(z.string()),
});

const RemindersConfigSchema = z.object({
  timezone: z.string().default("America/New_York"),
  check_interval_seconds: z.number().default(60),
  default_snooze_minutes: z.number().default(15),
});

const NotesConfigSchema = z.object({
  max_note_length: z.number().default(10000),
  default_list_limit: z.number().default(20),
});

const AlertRuleSchema = z.object({
  severity: z.enum(["high", "medium", "low"]),
  channels: z.array(z.enum(["discord", "slack", "telegram"])),
  quietHours: z.boolean().default(true),
  cooldown: z.number().default(300),
});

const AlertsConfigSchema = z.object({
  rules: z.record(AlertRuleSchema).default({}),
  quiet_hours: z.object({
    enabled: z.boolean().default(false),
    start: z.string().default("22:00"),
    end: z.string().default("07:00"),
    timezone: z.string().default("America/New_York"),
    override_severities: z.array(z.enum(["high", "medium", "low"])).default(["high"]),
  }).default({}),
});

const MemoryConfigSchema = z.object({
  base_url: z.string().default("http://memory-service:8010"),
  api_key: z.string(),
  context_injection: z.object({
    enabled: z.boolean().default(true),
    max_tokens: z.number().default(1500),
  }).default({}),
});

const FirecrawlConfigSchema = z.object({
  api_key: z.string().optional(),
  api_url: z.string().default("https://api.firecrawl.dev"),
  defaults: z.object({
    only_main_content: z.boolean().default(true),
    output_format: z.enum(["markdown", "html"]).default("markdown"),
    timeout_ms: z.number().default(30000),
    max_content_length: z.number().default(50000),
  }).default({}),
  rate_limit: z.object({
    max_requests: z.number().default(30),
    window_seconds: z.number().default(60),
  }).default({}),
  cache_ttl_seconds: z.number().default(3600),
  url_allowlist: z.array(z.string()).default([]),
  url_blocklist: z.array(z.string()).default([]),
}).refine(
  (data) => data.api_key || data.api_url !== "https://api.firecrawl.dev",
  { message: "api_key is required when using Firecrawl Cloud (default api_url)" }
);

const WeatherConfigSchema = z.object({
  default_latitude: z.number().default(42.0314),
  default_longitude: z.number().default(-80.2553),
  user_agent: z.string().default("coda-agent/1.0 (weather-integration)"),
  timeout_ms: z.number().default(10000),
  cache_ttl_seconds: z.number().default(900),
});

const N8nWebhookAuthSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("header"),
    name: z.string(),
    value: z.string(),
  }),
  z.object({
    type: z.literal("basic"),
    username: z.string(),
    password: z.string(),
  }),
]);

const N8nWebhookEntrySchema = z.object({
  url: z.string().url(),
  auth: N8nWebhookAuthSchema.optional(),
  timeout_ms: z.number().default(30000),
  description: z.string().optional(),
});

const N8nConfigSchema = z.object({
  webhooks: z.record(N8nWebhookEntrySchema).default({}),
  default_timeout_ms: z.number().default(30000),
});

const SchedulerConfigSchema = z.object({
  tasks: z.record(z.object({
    cron: z.string(),
    enabled: z.boolean().default(true),
  })).default({}),
});

const SubagentConfigSchema = z.object({
  enabled: z.boolean().default(true),
  default_timeout_minutes: z.number().default(5),
  max_timeout_minutes: z.number().default(10),
  sync_timeout_seconds: z.number().default(120),
  max_concurrent_per_user: z.number().default(3),
  max_concurrent_global: z.number().default(10),
  archive_ttl_minutes: z.number().default(60),
  max_tool_calls_per_run: z.number().default(25),
  default_token_budget: z.number().default(50000),
  max_token_budget: z.number().default(200000),
  spawn_rate_limit: z.object({
    max_requests: z.number().default(10),
    window_seconds: z.number().default(3600),
  }).default({}),
  cleanup_interval_seconds: z.number().default(60),
  safe_default_tools: z.array(z.string()).default([
    "firecrawl_scrape",
    "firecrawl_search",
    "firecrawl_map",
    "note_save",
    "note_search",
  ]),
  restricted_tools: z.array(z.string()).default([]),
});

const DoctorConfigSchema = z.object({
  enabled: z.boolean().default(true),
  pattern_window_seconds: z.number().default(300),
  pattern_threshold: z.number().default(10),
  skill_recovery_interval_seconds: z.number().default(60),
  max_error_history: z.number().default(500),
  output_repair: z.object({
    enabled: z.boolean().default(true),
    max_attempts: z.number().default(2),
    quick_fix_only: z.boolean().default(true),
  }).default({}),
}).default({});

const SecurityConfigSchema = z.object({
  sensitive_tool_policy: z.enum(["log", "confirm_with_external", "always_confirm"]).default("log"),
});

const ExecutionConfigSchema = z.object({
  enabled: z.boolean().default(false),
  docker_socket: z.string().default("/var/run/docker.sock"),
  default_image: z.string().default("python:3.12-slim"),
  timeout: z.number().min(1).max(300).default(60),
  max_memory: z.string().default("512m"),
  network_enabled: z.boolean().default(false),
  max_output_size: z.number().default(52428800), // 50 MB
  allowed_images: z.array(z.string()).default([
    "python:*",
    "node:*",
    "ubuntu:*",
    "alpine:*",
    "coda-skill-*",
  ]),
});

const BrowserConfigSchema = z.object({
  /** Enable/disable the browser automation skill. */
  enabled: z.boolean().default(false),
  /**
   * Connection mode:
   * - "docker" (default): spawn an isolated container per session (production)
   * - "host": launch Chromium directly on the host machine (development/testing)
   *           Requires: npx playwright install chromium
   */
  mode: z.enum(["docker", "host"]).default("docker"),
  /** Docker socket path (leave default unless using a remote Docker host). */
  docker_socket: z.string().default("/var/run/docker.sock"),
  /** Docker image for the browser sandbox container. */
  image: z.string().default("coda-browser-sandbox"),
  /** Docker network name for browser containers (internet-only, isolated from coda-internal). */
  sandbox_network: z.string().default("coda-browser-sandbox"),
  /** Maximum number of concurrent browser sessions. */
  max_sessions: z.number().default(3),
  /** Idle session timeout in seconds — sessions inactive longer than this are auto-destroyed. */
  session_timeout_seconds: z.number().default(300),
  /** Tool call timeout in milliseconds. */
  tool_timeout_ms: z.number().default(30000),
  /** WebSocket connection timeout in milliseconds (docker mode: time to connect to container). */
  connect_timeout_ms: z.number().default(15000),
  /** Number of connection retry attempts in docker mode before giving up. */
  connect_retries: z.number().default(3),
  /** Run browser in headless mode. Only applies in host mode (docker mode always headless). */
  headless: z.boolean().default(true),
  /**
   * Optional URL allowlist. If non-empty, browser_navigate is restricted to these domains.
   * Subdomains are automatically included (e.g. "example.com" allows "www.example.com").
   */
  url_allowlist: z.array(z.string()).default([]),
  /**
   * URL blocklist — these domains are always blocked regardless of allowlist.
   * Private IP ranges and internal hostnames are always blocked (not configurable).
   */
  url_blocklist: z.array(z.string()).default([]),
});

const McpTransportSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("stdio"),
    command: z.string(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string()).optional(),
    cwd: z.string().optional(),
  }),
  z.object({
    type: z.literal("http"),
    url: z.string().url(),
    headers: z.record(z.string()).optional(),
  }),
]);

const McpServerConfigSchema = z.object({
  enabled: z.boolean().default(true),
  transport: McpTransportSchema,
  timeout_ms: z.number().default(30000),
  tool_timeout_ms: z.number().default(60000),
  tool_allowlist: z.array(z.string()).optional(),
  tool_blocklist: z.array(z.string()).default([]),
  requires_confirmation: z.array(z.string()).default([]),
  sensitive_tools: z.array(z.string()).default([]),
  description: z.string().optional(),
  max_response_size: z.number().default(100000),
  auto_refresh_tools: z.boolean().default(false),
  startup_mode: z.enum(["eager", "lazy"]).default("eager"),
  idle_timeout_minutes: z.number().optional(), // undefined = no timeout
});

const McpConfigSchema = z.object({
  servers: z.record(McpServerConfigSchema).default({}),
});

const SpecialistPresetOverrideSchema = z.object({
  system_prompt: z.string().optional(),
  allowed_tools: z.array(z.string()).optional(),
  blocked_tools: z.array(z.string()).optional(),
  default_model: z.string().optional(),
  default_provider: z.string().optional(),
  token_budget: z.number().optional(),
  max_tool_calls: z.number().optional(),
  enabled: z.boolean().default(true),
});

const SelfImprovementConfigSchema = z.object({
  enabled: z.boolean().default(true),
  opus_provider: z.string().optional(),
  opus_model: z.string().optional(),
  reflection_cron: z.string().default("0 3 * * 0"), // Sunday 3 AM
  assessment_enabled: z.boolean().default(true),
  prompt_evolution_enabled: z.boolean().default(false),
  max_reflection_input_tokens: z.number().default(8000),
  approval_channel: z.string().default("discord"),
  routing_retrain_cron: z.string().default("0 4 * * 0"), // Sunday 4 AM
  // 5.3 Critique Loop
  critique_enabled: z.boolean().default(true),
  critique_min_tier: z.number().default(3),
  // 5.4 Gap Detection
  gap_detection_enabled: z.boolean().default(true),
  gap_detection_cron: z.string().default("0 2 1 * *"), // 1st of month 2 AM
  // 5.7 Few-Shot Library
  few_shot_enabled: z.boolean().default(true),
  few_shot_harvest_cron: z.string().default("0 4 1 * *"), // 1st of month 4 AM
  few_shot_min_score: z.number().default(4),
  few_shot_min_tool_calls: z.number().default(2),
});

const TasksConfigSchema = z.object({
  enabled: z.boolean().default(true),
  resume_cron: z.string().default("*/15 * * * *"),
  max_active_per_user: z.number().default(5),
  max_auto_resume_attempts: z.number().default(3),
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
        .default("postgresql://localhost:5432/coda"),
      conversation_retention_days: z.number().default(30),
    })
    .default({}),
  server: z
    .object({
      port: z.number().default(3000),
      host: z.string().default("127.0.0.1"),
      api_key: z.string().optional(),
      require_auth_for_health: z.boolean().default(false),
    })
    .default({}),
  slack: SlackConfigSchema.optional(),
  telegram: TelegramConfigSchema.optional(),
  reminders: RemindersConfigSchema.optional(),
  notes: NotesConfigSchema.optional(),
  memory: MemoryConfigSchema.optional(),
  alerts: AlertsConfigSchema.optional(),
  scheduler: SchedulerConfigSchema.optional(),
  subagents: SubagentConfigSchema.optional(),
  firecrawl: FirecrawlConfigSchema.optional(),
  weather: WeatherConfigSchema.optional().default({}),
  n8n: N8nConfigSchema.optional(),
  doctor: DoctorConfigSchema.optional().default({ enabled: true }),
  security: SecurityConfigSchema.optional(),
  execution: ExecutionConfigSchema.optional(),
  mcp: McpConfigSchema.optional(),
  self_improvement: SelfImprovementConfigSchema.optional(),
  tasks: TasksConfigSchema.optional(),
  specialists: z.record(SpecialistPresetOverrideSchema).optional(),
  browser: BrowserConfigSchema.optional(),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
export type BrowserConfig = z.infer<typeof BrowserConfigSchema>;
export type SelfImprovementConfig = z.infer<typeof SelfImprovementConfigSchema>;
export type TasksConfig = z.infer<typeof TasksConfigSchema>;
export type SubagentConfig = z.infer<typeof SubagentConfigSchema>;
export type FirecrawlConfig = z.infer<typeof FirecrawlConfigSchema>;
export type WeatherConfig = z.infer<typeof WeatherConfigSchema>;
export type N8nConfig = z.infer<typeof N8nConfigSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type ProviderCapabilitiesConfig = z.infer<typeof ProviderCapabilitiesSchema>;
export type TierConfig = z.infer<typeof TierConfigSchema>;
export type ExecutionConfig = z.infer<typeof ExecutionConfigSchema>;
export type McpConfig = z.infer<typeof McpConfigSchema>;
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;
export type McpTransport = z.infer<typeof McpTransportSchema>;
export type SpecialistPresetOverride = z.infer<typeof SpecialistPresetOverrideSchema>;
export type SpecialistsConfig = Record<string, SpecialistPresetOverride>;

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

  // Server overrides
  const server = ensureObject(config, "server");
  if (process.env.API_KEY) server.api_key = process.env.API_KEY;
  if (process.env.SERVER_HOST) server.host = process.env.SERVER_HOST;
  if (process.env.SERVER_PORT) server.port = Number(process.env.SERVER_PORT);

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

  // Slack overrides
  if (process.env.SLACK_APP_TOKEN || process.env.SLACK_BOT_TOKEN) {
    const slack = ensureObject(config, "slack");
    if (process.env.SLACK_APP_TOKEN) slack.app_token = process.env.SLACK_APP_TOKEN;
    if (process.env.SLACK_BOT_TOKEN) slack.bot_token = process.env.SLACK_BOT_TOKEN;
    if (process.env.SLACK_CHANNEL_ID) slack.channel_id = process.env.SLACK_CHANNEL_ID;
    if (process.env.SLACK_ALLOWED_USER_IDS) {
      slack.allowed_user_ids = process.env.SLACK_ALLOWED_USER_IDS.split(",");
    }
  }

  // Telegram overrides
  if (process.env.TELEGRAM_BOT_TOKEN) {
    const telegram = ensureObject(config, "telegram");
    telegram.bot_token = process.env.TELEGRAM_BOT_TOKEN;
    if (process.env.TELEGRAM_CHAT_ID) telegram.chat_id = process.env.TELEGRAM_CHAT_ID;
    if (process.env.TELEGRAM_ALLOWED_USER_IDS) {
      telegram.allowed_user_ids = process.env.TELEGRAM_ALLOWED_USER_IDS.split(",");
    }
  }

  // Memory service overrides
  if (process.env.MEMORY_API_KEY) {
    const memory = ensureObject(config, "memory");
    memory.api_key = process.env.MEMORY_API_KEY;
    if (process.env.MEMORY_SERVICE_URL) memory.base_url = process.env.MEMORY_SERVICE_URL;
  }

  // Firecrawl overrides
  if (process.env.FIRECRAWL_API_KEY) {
    const firecrawl = ensureObject(config, "firecrawl");
    firecrawl.api_key = process.env.FIRECRAWL_API_KEY;
    if (process.env.FIRECRAWL_API_URL) firecrawl.api_url = process.env.FIRECRAWL_API_URL;
  }

  // Tier overrides
  if (process.env.TIER_ENABLED !== undefined) {
    const tiers = ensureObject(llm, "tiers");
    tiers.enabled = process.env.TIER_ENABLED === "true";
  }
  if (process.env.TIER_LIGHT_MODEL) {
    const tiers = ensureObject(llm, "tiers");
    const light = ensureObject(tiers, "light");
    light.model = process.env.TIER_LIGHT_MODEL;
  }
  if (process.env.TIER_HEAVY_MODEL) {
    const tiers = ensureObject(llm, "tiers");
    const heavy = ensureObject(tiers, "heavy");
    heavy.model = process.env.TIER_HEAVY_MODEL;
  }
  if (process.env.TIER_LIGHT_PROVIDER) {
    const tiers = ensureObject(llm, "tiers");
    const light = ensureObject(tiers, "light");
    light.provider = process.env.TIER_LIGHT_PROVIDER;
  }
  if (process.env.TIER_HEAVY_PROVIDER) {
    const tiers = ensureObject(llm, "tiers");
    const heavy = ensureObject(tiers, "heavy");
    heavy.provider = process.env.TIER_HEAVY_PROVIDER;
  }

  // Default tier providers to default_provider if tiers are enabled but providers aren't set
  if (process.env.TIER_ENABLED === "true") {
    const tiers = ensureObject(llm, "tiers");
    const light = ensureObject(tiers, "light");
    const heavy = ensureObject(tiers, "heavy");
    const defaultProv = (llm.default_provider as string) || Object.keys(providers)[0] || "anthropic";
    if (!light.provider) light.provider = defaultProv;
    if (!heavy.provider) heavy.provider = defaultProv;
  }

  // Execution overrides
  if (process.env.EXECUTION_ENABLED !== undefined) {
    const execution = ensureObject(config, "execution");
    execution.enabled = process.env.EXECUTION_ENABLED === "true";
  }
  if (process.env.EXECUTION_DEFAULT_IMAGE) {
    const execution = ensureObject(config, "execution");
    execution.default_image = process.env.EXECUTION_DEFAULT_IMAGE;
  }

  // Browser automation overrides
  if (process.env.BROWSER_ENABLED !== undefined) {
    const browser = ensureObject(config, "browser");
    browser.enabled = process.env.BROWSER_ENABLED === "true";
  }
  if (process.env.BROWSER_IMAGE) {
    const browser = ensureObject(config, "browser");
    browser.image = process.env.BROWSER_IMAGE;
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
