import { loadConfig } from "./utils/config.js";
import { createLogger } from "./utils/logger.js";
import { ProviderManager } from "./core/llm/manager.js";
import { InProcessEventBus } from "./core/events.js";
import { RedisStreamEventBus } from "./core/redis-event-bus.js";
import { AlertRouter } from "./core/alerts.js";
import { ContextStore } from "./core/context.js";
import { ConfirmationManager } from "./core/confirmation.js";
import { Orchestrator } from "./core/orchestrator.js";
import { TaskScheduler } from "./core/scheduler.js";
import { SkillRegistry } from "./skills/registry.js";
import { ExternalSkillLoader } from "./skills/loader.js";
import { DiscordBot } from "./interfaces/discord-bot.js";
import { SlackBot } from "./interfaces/slack-bot.js";
import { DiscordAlertSink } from "./core/sinks/discord-sink.js";
import { SlackAlertSink } from "./core/sinks/slack-sink.js";
import { RestApi } from "./interfaces/rest-api.js";
import { SkillHealthTracker } from "./core/skill-health.js";
import { RateLimiter } from "./core/rate-limiter.js";
import { PreferencesManager } from "./core/preferences.js";
import { createDatabase } from "./db/index.js";
import { initializeDatabase } from "./db/connection.js";
import { runMigrations } from "./db/migrate.js";
import { NotesSkill } from "./skills/notes/skill.js";
import { ReminderSkill } from "./skills/reminders/skill.js";
import { CalendarSkill } from "./integrations/calendar/skill.js";
import { EmailSkill } from "./integrations/email/skill.js";
import { SchedulerSkill } from "./skills/scheduler/skill.js";
import { N8nSkill } from "./integrations/n8n/skill.js";
import { MemorySkill } from "./skills/memory/skill.js";
import { FirecrawlSkill } from "./integrations/firecrawl/skill.js";
import { SubagentSkill } from "./skills/subagents/skill.js";
import { AgentSkillDiscovery } from "./skills/agent-skill-discovery.js";
import { AgentSkillsSkill } from "./skills/agent-skills/skill.js";
import { SubagentManager } from "./core/subagent-manager.js";
import type { SkillContext } from "./skills/context.js";
import type { AppConfig } from "./utils/config.js";
import type { EventBus } from "./core/events.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Redis from "ioredis";

const logger = createLogger();

/** Map skill names to their config section from AppConfig. */
function getSkillConfig(skillName: string, config: AppConfig): Record<string, unknown> {
  const sectionMap: Record<string, unknown> = {
    notes: config.notes,
    reminders: config.reminders,
    calendar: config.calendar,
    email: config.email,
    memory: config.memory,
    firecrawl: config.firecrawl,
    n8n: {},
  };
  return (sectionMap[skillName] as Record<string, unknown>) ?? {};
}

async function main() {
  logger.info("Starting coda agent...");

  // 1. Load configuration
  const config = loadConfig();
  logger.info("Configuration loaded");

  // 2. Initialize database
  const { db, client: dbClient } = createDatabase(config.database.url);
  initializeDatabase(db);
  await runMigrations(db);
  logger.info("Database initialized");

  // 2b. Preferences manager
  const preferencesManager = new PreferencesManager(db, logger);

  // 3. Initialize Redis
  const redis = new Redis(config.redis.url);
  logger.info("Redis connected");

  // 4. Initialize core services
  const skillHealthTracker = new SkillHealthTracker();

  // Use Redis Streams event bus for production, with fallback
  let eventBus: EventBus;
  let redisEventBus: RedisStreamEventBus | null = null;
  try {
    redisEventBus = new RedisStreamEventBus(redis, logger);
    eventBus = redisEventBus;
    logger.info("Using Redis Streams event bus");
  } catch {
    eventBus = new InProcessEventBus(logger);
    logger.warn("Falling back to in-process event bus");
  }

  // Initialize provider manager with event bus for circuit breaker alerts
  const providerManager = new ProviderManager(config.llm, logger, eventBus);

  // Configure alert router with Phase 3 enhancements
  const alertsConfig = config.alerts;
  const alertRouter = new AlertRouter(logger, redis, db, {
    rules: alertsConfig?.rules ?? {},
    quietHours: alertsConfig?.quiet_hours
      ? {
          enabled: alertsConfig.quiet_hours.enabled,
          start: alertsConfig.quiet_hours.start,
          end: alertsConfig.quiet_hours.end,
          timezone: alertsConfig.quiet_hours.timezone,
          overrideSeverities: alertsConfig.quiet_hours.override_severities,
        }
      : undefined,
  }, preferencesManager);
  alertRouter.attachToEventBus(eventBus);

  // Initialize task scheduler
  const taskScheduler = new TaskScheduler(logger, eventBus);

  // Register built-in scheduled tasks
  taskScheduler.registerTask(
    {
      name: "health.check",
      cronExpression: "*/5 * * * *",
      handler: async () => {
        logger.debug("Health check tick");
      },
      description: "Periodic health check (every 5 minutes)",
    },
    config.scheduler?.tasks?.["health.check"]
      ? {
          cron: config.scheduler.tasks["health.check"].cron,
          enabled: config.scheduler.tasks["health.check"].enabled,
        }
      : undefined
  );

  // Register daily cost log task
  taskScheduler.registerTask({
    name: "llm.daily_cost_log",
    cronExpression: "0 0 * * *", // midnight daily
    handler: async () => {
      const usage = providerManager.usage.getDailyUsage();
      const totalCost = providerManager.usage.getTodayTotalCost();
      logger.info(
        { usage, totalCost },
        "Daily LLM usage summary"
      );
    },
    description: "Log daily LLM token usage summary at midnight",
  });

  const contextStore = new ContextStore(logger);
  const confirmationManager = new ConfirmationManager(logger, eventBus);
  const rateLimiter = new RateLimiter(redis, logger);

  // 5. Create skill registry with health tracking and rate limiting
  const skillRegistry = new SkillRegistry(logger, skillHealthTracker, rateLimiter);

  // 6. Register internal skills
  skillRegistry.register(new NotesSkill());
  skillRegistry.register(new ReminderSkill());
  skillRegistry.register(new SchedulerSkill(taskScheduler));
  skillRegistry.register(new N8nSkill());

  // Calendar registers conditionally (requires CalDAV config)
  if (config.calendar) {
    try {
      skillRegistry.register(new CalendarSkill(), { caldav: config.calendar });
    } catch (err) {
      logger.warn({ error: err }, "Calendar skill not registered — missing config");
    }
  }

  // Email registers conditionally (requires OAuth or IMAP config)
  if (config.email) {
    try {
      skillRegistry.register(new EmailSkill(), config.email);
    } catch (err) {
      logger.warn({ error: err }, "Email skill not registered — missing config");
    }
  }

  // Memory registers conditionally (requires API key)
  if (config.memory) {
    try {
      skillRegistry.register(new MemorySkill(), config.memory);
    } catch (err) {
      logger.warn({ error: err }, "Memory skill not registered — missing config");
    }
  }

  // Firecrawl registers conditionally (requires config or env var)
  if (config.firecrawl) {
    try {
      skillRegistry.register(new FirecrawlSkill(), config.firecrawl);
    } catch (err) {
      logger.warn({ error: err }, "Firecrawl skill not registered — missing config");
    }
  }

  // 6b. Register subagent skill (tools registered now, manager wired after orchestrator)
  const subagentSkill = new SubagentSkill();
  skillRegistry.register(subagentSkill);

  // 7. Load external skills
  if (config.skills.external_dirs.length > 0) {
    const loader = new ExternalSkillLoader(logger, {
      mode: config.skills.external_policy.mode,
      trusted_signing_keys: config.skills.external_policy.trusted_signing_keys,
      allow_unsigned_local: config.skills.external_policy.allow_unsigned_local,
      allowed_local_unsigned_dirs:
        config.skills.external_policy.allowed_local_unsigned_dirs,
    });
    const externalSkills = await loader.loadFromDirectories(
      config.skills.external_dirs
    );
    for (const { skill } of externalSkills) {
      try {
        skillRegistry.register(skill);
      } catch (err) {
        logger.error(
          { skill: skill.name, error: err },
          "Failed to register external skill"
        );
      }
    }
  }

  // 7b. Agent Skills (agentskills.io standard)
  // Always include built-in agent-skills directory alongside any user-configured dirs.
  // In dev: src/skills/agent-skills/  In prod: dist/skills/agent-skills/
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const builtinAgentSkillsDir = join(__dirname, "skills", "agent-skills");
  const agentSkillDirs = [builtinAgentSkillsDir, ...config.skills.agent_skill_dirs];

  const agentSkillDiscovery = new AgentSkillDiscovery(logger);
  agentSkillDiscovery.scanDirectories(agentSkillDirs);

  if (agentSkillDiscovery.getSkillMetadataList().length > 0) {
    skillRegistry.register(new AgentSkillsSkill(agentSkillDiscovery));
  }

  // 8. Create orchestrator
  const orchestrator = new Orchestrator(
    providerManager,
    skillRegistry,
    contextStore,
    eventBus,
    confirmationManager,
    logger,
    agentSkillDiscovery
  );

  // 8b. Initialize SubagentManager
  const subagentConfig = config.subagents ?? {
    enabled: true,
    default_timeout_minutes: 5,
    max_timeout_minutes: 10,
    sync_timeout_seconds: 120,
    max_concurrent_per_user: 3,
    max_concurrent_global: 10,
    archive_ttl_minutes: 60,
    max_tool_calls_per_run: 25,
    default_token_budget: 50000,
    max_token_budget: 200000,
    spawn_rate_limit: { max_requests: 10, window_seconds: 3600 },
    cleanup_interval_seconds: 60,
  };

  const subagentManager = new SubagentManager(
    subagentConfig,
    skillRegistry,
    providerManager,
    eventBus,
    rateLimiter,
    logger
  );
  subagentSkill.setManager(subagentManager);

  // 9. Start all skills with context (real Redis-backed + scheduler)
  await skillRegistry.startupAll((skillName: string): SkillContext => {
    const prefix = `skill:${skillName}:`;
    return {
      config: getSkillConfig(skillName, config),
      logger: logger.child({ skill: skillName }),
      redis: {
        async get(key: string) {
          return redis.get(`${prefix}${key}`);
        },
        async set(key: string, value: string, ttl?: number) {
          if (ttl) {
            await redis.set(`${prefix}${key}`, value, "EX", ttl);
          } else {
            await redis.set(`${prefix}${key}`, value);
          }
        },
        async del(key: string) {
          await redis.del(`${prefix}${key}`);
        },
      },
      eventBus,
      db,
      scheduler: taskScheduler.getClientFor(skillName),
    };
  });

  // 9b. Start SubagentManager
  subagentManager.startup();

  // 10. Start Discord bot
  const discordBot = new DiscordBot(
    {
      botToken: config.discord.bot_token,
      channelId: config.discord.channel_id,
      allowedUserIds: config.discord.allowed_user_ids,
    },
    orchestrator,
    providerManager,
    skillRegistry,
    logger,
    preferencesManager,
    subagentManager
  );
  await discordBot.start();

  // Register Discord alert sink
  const discordSink = new DiscordAlertSink(discordBot);
  alertRouter.registerSink("discord", discordSink);

  // Start Slack bot (optional)
  let slackBot: SlackBot | undefined;
  if (config.slack) {
    slackBot = new SlackBot(
      {
        appToken: config.slack.app_token,
        botToken: config.slack.bot_token,
        channelId: config.slack.channel_id,
        allowedUserIds: config.slack.allowed_user_ids,
      },
      orchestrator,
      providerManager,
      skillRegistry,
      logger
    );
    await slackBot.start();

    const slackSink = new SlackAlertSink(slackBot);
    alertRouter.registerSink("slack", slackSink);
  }

  // 10b. Wire subagent announcement callback
  subagentManager.setAnnounceCallback(async (channel: string, message: string) => {
    if (channel === "discord") {
      await discordBot.sendNotification(message);
    } else if (channel === "slack" && slackBot) {
      await slackBot.sendNotification(message);
    } else {
      // Default to Discord for unknown channels
      await discordBot.sendNotification(message);
    }
  });

  // 11. Start REST API (health checks) with real service deps
  const restApi = new RestApi(logger, {
    redis,
    skillHealth: skillHealthTracker,
    providerManager,
  });
  await restApi.start(config.server.port, config.server.host);

  // 12. Start event bus consumer (after all subscriptions are registered)
  if (redisEventBus) {
    redisEventBus.startConsumer().catch((err) => {
      logger.error({ error: err }, "Event bus consumer error");
    });
  }

  // 13. Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Received shutdown signal");
    await subagentManager.shutdown();
    await discordBot.stop();
    if (slackBot) await slackBot.stop();
    await restApi.stop();
    await skillRegistry.shutdownAll();
    taskScheduler.shutdown();
    if (redisEventBus) {
      await redisEventBus.stopConsumer();
    }
    redis.disconnect();
    await dbClient.end();
    logger.info("Shutdown complete");
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  logger.info("coda agent is running");
}

main().catch((err) => {
  logger.fatal({ error: err }, "Fatal startup error");
  process.exit(1);
});
