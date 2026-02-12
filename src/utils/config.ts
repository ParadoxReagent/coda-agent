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
  failover_chain: z.array(z.string()).optional(),
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

const SlackConfigSchema = z.object({
  app_token: z.string(),
  bot_token: z.string(),
  channel_id: z.string(),
  allowed_user_ids: z.array(z.string()),
});

const EmailOAuthConfigSchema = z.object({
  client_id: z.string(),
  client_secret: z.string(),
  redirect_port: z.number().default(3000),
  scopes: z.array(z.string()).default([
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.modify",
  ]),
});

const EmailConfigSchema = z.object({
  // Gmail API with OAuth (preferred)
  oauth: EmailOAuthConfigSchema.optional(),
  gmail_user: z.string().optional(),

  // Legacy IMAP config (fallback)
  imap_host: z.string().optional(),
  imap_port: z.number().default(993),
  imap_user: z.string().optional(),
  imap_pass: z.string().optional(),
  imap_tls: z.boolean().default(true),

  // Common settings
  poll_interval_seconds: z.number().default(300),
  folders: z.array(z.string()).default(["INBOX"]),
  labels: z.array(z.string()).default(["INBOX"]),
  categorization: z.object({
    urgent_senders: z.array(z.string()).default([]),
    urgent_keywords: z.array(z.string()).default([]),
    known_contacts: z.array(z.string()).default([]),
  }).default({}),
}).refine(
  (data) => (data.oauth && data.gmail_user) || (data.imap_host && data.imap_user && data.imap_pass),
  { message: "Either (oauth + gmail_user) or (imap_host + imap_user + imap_pass) must be provided" }
);

const CalendarConfigSchema = z.object({
  caldav_server_url: z.string(),
  caldav_username: z.string(),
  caldav_password: z.string(),
  timezone: z.string().default("America/New_York"),
  default_calendar: z.string().optional(),
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
  channels: z.array(z.enum(["discord", "slack"])),
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

const SchedulerConfigSchema = z.object({
  tasks: z.record(z.object({
    cron: z.string(),
    enabled: z.boolean().default(true),
  })).default({}),
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
  slack: SlackConfigSchema.optional(),
  email: EmailConfigSchema.optional(),
  calendar: CalendarConfigSchema.optional(),
  reminders: RemindersConfigSchema.optional(),
  notes: NotesConfigSchema.optional(),
  memory: MemoryConfigSchema.optional(),
  alerts: AlertsConfigSchema.optional(),
  scheduler: SchedulerConfigSchema.optional(),
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

  // Gmail OAuth overrides
  if (process.env.GMAIL_OAUTH_CLIENT_ID || process.env.GMAIL_OAUTH_CLIENT_SECRET) {
    const email = ensureObject(config, "email");
    const oauth = ensureObject(email, "oauth");
    if (process.env.GMAIL_OAUTH_CLIENT_ID) oauth.client_id = process.env.GMAIL_OAUTH_CLIENT_ID;
    if (process.env.GMAIL_OAUTH_CLIENT_SECRET) oauth.client_secret = process.env.GMAIL_OAUTH_CLIENT_SECRET;
    if (process.env.GMAIL_OAUTH_REDIRECT_PORT) oauth.redirect_port = parseInt(process.env.GMAIL_OAUTH_REDIRECT_PORT, 10);
    if (process.env.GMAIL_USER) email.gmail_user = process.env.GMAIL_USER;
  }

  // IMAP / Email overrides (legacy)
  if (process.env.IMAP_HOST || process.env.IMAP_USER || process.env.IMAP_PASS) {
    const email = ensureObject(config, "email");
    if (process.env.IMAP_HOST) email.imap_host = process.env.IMAP_HOST;
    if (process.env.IMAP_USER) email.imap_user = process.env.IMAP_USER;
    if (process.env.IMAP_PASS) email.imap_pass = process.env.IMAP_PASS;
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

  // Memory service overrides
  if (process.env.MEMORY_API_KEY) {
    const memory = ensureObject(config, "memory");
    memory.api_key = process.env.MEMORY_API_KEY;
    if (process.env.MEMORY_SERVICE_URL) memory.base_url = process.env.MEMORY_SERVICE_URL;
  }

  // CalDAV / Calendar overrides
  if (process.env.CALDAV_SERVER_URL || process.env.CALDAV_USERNAME || process.env.CALDAV_PASSWORD) {
    const calendar = ensureObject(config, "calendar");
    if (process.env.CALDAV_SERVER_URL) calendar.caldav_server_url = process.env.CALDAV_SERVER_URL;
    if (process.env.CALDAV_USERNAME) calendar.caldav_username = process.env.CALDAV_USERNAME;
    if (process.env.CALDAV_PASSWORD) calendar.caldav_password = process.env.CALDAV_PASSWORD;
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
