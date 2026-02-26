import dotenv from "dotenv";

// Load .env file before anything else
dotenv.config();

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
import { TelegramBot } from "./interfaces/telegram-bot.js";
import { DiscordAlertSink } from "./core/sinks/discord-sink.js";
import { SlackAlertSink } from "./core/sinks/slack-sink.js";
import { TelegramAlertSink } from "./core/sinks/telegram-sink.js";
import { RestApi } from "./interfaces/rest-api.js";
import { SkillHealthTracker } from "./core/skill-health.js";
import { RateLimiter } from "./core/rate-limiter.js";
import { PreferencesManager } from "./core/preferences.js";
import { createDatabase } from "./db/index.js";
import { initializeDatabase } from "./db/connection.js";
import { runMigrations } from "./db/migrate.js";
import { NotesSkill } from "./skills/notes/skill.js";
import { ReminderSkill } from "./skills/reminders/skill.js";
import type { McpServerManager } from "./integrations/mcp/manager.js";
import { SchedulerSkill } from "./skills/scheduler/skill.js";
import { N8nSkill } from "./integrations/n8n/skill.js";
import { MemorySkill } from "./skills/memory/skill.js";
import { FirecrawlSkill } from "./integrations/firecrawl/skill.js";
import { WeatherSkill } from "./integrations/weather/skill.js";
import { SubagentSkill } from "./skills/subagents/skill.js";
import { AgentSkillDiscovery } from "./skills/agent-skill-discovery.js";
import { AgentSkillsSkill } from "./skills/agent-skills/skill.js";
import { DoctorService } from "./core/doctor/doctor-service.js";
import { DoctorSkill } from "./skills/doctor/skill.js";
import { SubagentManager } from "./core/subagent-manager.js";
import { TierClassifier } from "./core/tier-classifier.js";
import { DockerExecutorSkill } from "./skills/docker-executor/skill.js";
import { DockerSandboxSkill } from "./skills/docker-sandbox/skill.js";
import { AuditService } from "./core/audit.js";
import { AuditSkill } from "./skills/audit/skill.js";
import { RoutingDecisionLogger } from "./core/routing-logger.js";
import { ConfigWatcher } from "./utils/config-watcher.js";
import { initAgentLoader } from "./core/agent-loader.js";
import { MessageSender } from "./core/message-sender.js";
import { SelfAssessmentService } from "./core/self-assessment.js";
import { PromptManager } from "./core/prompt-manager.js";
import { LearnedTierClassifier } from "./core/learned-classifier.js";
import { SelfImprovementSkill } from "./skills/self-improvement/skill.js";
import { SelfImprovementExecutorSkill } from "./skills/self-improvement-executor/skill.js";
import { TaskExecutionSkill } from "./skills/tasks/skill.js";
import { CritiqueService } from "./core/critique-service.js";
import { FewShotService } from "./core/few-shot-service.js";
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
    memory: config.memory,
    firecrawl: config.firecrawl,
    weather: config.weather,
    n8n: config.n8n,
    "self-improvement": config.self_improvement,
    "self-improvement-executor": config.self_improvement,
    tasks: config.tasks,
  };
  return (sectionMap[skillName] as Record<string, unknown>) ?? {};
}

async function main() {
  logger.info("Starting coda agent...");

  // 1. Load configuration
  const config = loadConfig();
  logger.info("Configuration loaded");

  // Security: warn if default database credentials detected
  if (config.database.url.includes("coda:coda")) {
    logger.warn(
      "Default database credentials detected (coda:coda) — change them for production!"
    );
  }

  // 2. Initialize database
  const { db, client: dbClient } = createDatabase(config.database.url);
  initializeDatabase(db);
  await runMigrations(db);
  logger.info("Database initialized");

  // 2b. Preferences manager
  const preferencesManager = new PreferencesManager(db, logger);

  // 2c. Audit service (writes to audit_log table)
  const auditService = new AuditService(db, logger);

  // 2d. Routing decision logger
  const routingDecisionLogger = new RoutingDecisionLogger(db, logger);

  // 2e. Message sender (channels registered after bots start, below)
  const messageSender = new MessageSender(logger, auditService);

  // 2f. Self-assessment service (4.1)
  const selfAssessmentService = new SelfAssessmentService(db, logger);

  // 2g. Prompt manager (4.3)
  const promptManager = new PromptManager(db, logger);

  // 2h. Learned tier classifier (4.4)
  const learnedClassifier = new LearnedTierClassifier(db, logger);

  // 3. Initialize Redis
  const redis = new Redis(config.redis.url);
  logger.info("Redis connected");

  // Security: warn if Redis URL does not include authentication
  try {
    const redisUrl = new URL(config.redis.url);
    if (!redisUrl.password && !redisUrl.username) {
      logger.warn(
        "Redis connection does not include authentication. " +
        "Use format: redis://:password@host:port or redis://user:password@host:port"
      );
    }
  } catch {
    // Ignore URL parse errors (already validated by config schema)
  }

  // 3b. Initialize specialist agent loader (must happen before skill registry)
  await initAgentLoader(logger);

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

  // Config hot-reload watcher (event bus now available)
  const configPath = process.env.CONFIG_PATH ?? "./config/config.yaml";
  const configWatcher = new ConfigWatcher(configPath, logger, eventBus);

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

  // 5. Create skill registry with health tracking, rate limiting, and audit
  const skillRegistry = new SkillRegistry(logger, skillHealthTracker, rateLimiter, auditService);

  // 6. Register internal skills
  skillRegistry.register(new NotesSkill());
  skillRegistry.register(new ReminderSkill());
  skillRegistry.register(new SchedulerSkill(taskScheduler));
  skillRegistry.register(new N8nSkill(), config.n8n);

  // Register optional skills that depend on config
  const optionalSkills: Array<{ skill: import("./skills/base.js").Skill; config: Record<string, unknown> | undefined }> = [
    { skill: new MemorySkill(), config: config.memory },
    { skill: new FirecrawlSkill(), config: config.firecrawl },
    { skill: new WeatherSkill(), config: config.weather },
  ];

  for (const { skill, config: skillConfig } of optionalSkills) {
    if (skillConfig) {
      try {
        skillRegistry.register(skill, skillConfig);
      } catch (err) {
        logger.warn({ error: err }, `${skill.name} skill not registered — missing config`);
      }
    }
  }

  // MCP servers
  let mcpManager: McpServerManager | undefined = undefined;
  if (config.mcp?.servers && Object.keys(config.mcp.servers).length > 0) {
    const { createMcpSkills } = await import("./integrations/mcp/factory.js");
    const { skills: mcpSkills, manager } = await createMcpSkills(config.mcp, logger);
    mcpManager = manager;
    for (const { skill } of mcpSkills) {
      try {
        skillRegistry.register(skill);
      } catch (err) {
        logger.error({ skill: skill.name, error: err }, "Failed to register MCP skill");
      }
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

  const agentSkillDiscovery = new AgentSkillDiscovery(
    logger,
    config.skills.allow_executable_resources
  );
  agentSkillDiscovery.scanDirectories(agentSkillDirs);

  if (agentSkillDiscovery.getSkillMetadataList().length > 0) {
    skillRegistry.register(new AgentSkillsSkill(agentSkillDiscovery, config.execution?.enabled ?? false));
  }

  // 7c. Docker Executor Skill (code execution in sandboxed containers)
  if (config.execution?.enabled) {
    try {
      skillRegistry.register(new DockerExecutorSkill(config.execution, logger));
      logger.info("Docker executor skill registered");
    } catch (err) {
      logger.warn({ error: err }, "Docker executor skill not registered");
    }
  } else {
    logger.info("Docker executor disabled (execution.enabled: false)");
  }

  // 7d. Docker Sandbox Skill (for self-improvement executor validation)
  if (config.self_improvement?.executor_enabled) {
    try {
      skillRegistry.register(new DockerSandboxSkill());
      logger.info("Docker sandbox skill registered");
    } catch (err) {
      logger.warn({ error: err }, "Docker sandbox skill not registered");
    }
  }

  // 7d. Browser Automation Skill (Playwright MCP in ephemeral Docker sandbox)
  if (config.browser?.enabled) {
    try {
      const { BrowserSkill } = await import("./skills/browser/skill.js");
      skillRegistry.register(new BrowserSkill(config.browser, logger));
      logger.info("Browser automation skill registered");
    } catch (err) {
      logger.warn({ error: err }, "Browser automation skill not registered");
    }
  } else {
    logger.info("Browser automation disabled (browser.enabled: false)");
  }

  // 8. Create orchestrator with optional tier classifier
  const tierClassifier = config.llm.tiers?.enabled
    ? new TierClassifier(config.llm.tiers)
    : undefined;

  // Wire learned classifier into tier classifier (starts empty, retrains weekly)
  if (tierClassifier) {
    tierClassifier.setLearnedClassifier(learnedClassifier);
  }

  // Register routing retrain cron
  const routingRetrainCron = config.self_improvement?.routing_retrain_cron ?? "0 4 * * 0";
  taskScheduler.registerTask({
    name: "routing.retrain",
    cronExpression: routingRetrainCron,
    handler: async () => {
      logger.info("Running learned classifier retrain");
      await learnedClassifier.retrain();
      const stats = learnedClassifier.getStats();
      await messageSender.send(
        "discord",
        `Routing classifier retrained: ${stats.patternCount} patterns learned from ${stats.lastTrainedAt ? 'latest data' : 'no data'}.`,
        "routing.retrain"
      );
    },
    description: "Weekly retrain of learned tier classifier from routing_decisions + self_assessments",
  });

  const orchestrator = new Orchestrator(
    providerManager,
    skillRegistry,
    contextStore,
    eventBus,
    confirmationManager,
    logger,
    agentSkillDiscovery,
    tierClassifier,
    config.security,
    routingDecisionLogger
  );

  // Wire self-assessment and prompt-manager into orchestrator
  if (config.self_improvement?.assessment_enabled !== false) {
    orchestrator.setSelfAssessmentService(selfAssessmentService);
  }
  orchestrator.setPromptManager(promptManager);

  // Wire critique service (5.3)
  if (config.self_improvement?.critique_enabled !== false) {
    const critiqueService = new CritiqueService(logger, auditService);
    // Wire light LLM after skill startup (use a deferred approach)
    const critiqueMinTier = config.self_improvement?.critique_min_tier ?? 3;
    orchestrator.setCritiqueService(critiqueService, critiqueMinTier);
    // LLM wired below after skillRegistry.startupAll builds the light llm
    (async () => {
      const { provider, model } = await providerManager.getForUserTiered("system", "light").catch(
        () => providerManager.getForUser("system")
      );
      critiqueService.setLlm({
        async chat(params) {
          const response = await provider.chat({
            model,
            system: params.system,
            messages: params.messages.map(m => ({ role: m.role, content: m.content })),
            maxTokens: params.maxTokens ?? 512,
          });
          return { text: response.text };
        },
      });
    })().catch(err => logger.warn({ error: err }, "Failed to wire critique LLM"));
  }

  // Register audit skill (read-only agent self-introspection)
  skillRegistry.register(new AuditSkill(auditService));

  // Register tasks skill (4.5)
  if (config.tasks?.enabled !== false) {
    const tasksSkill = new TaskExecutionSkill({
      max_active_per_user: config.tasks?.max_active_per_user,
      resume_cron: config.tasks?.resume_cron,
    });
    skillRegistry.register(tasksSkill);
  }

  // Register self-improvement executor skill (Phase 6)
  // Must be registered before startupAll; subagentManager wired below after it's created.
  let selfImprovementExecutorSkill: SelfImprovementExecutorSkill | undefined;
  if (config.self_improvement?.executor_enabled) {
    const { getAgentLoader } = await import("./core/agent-loader.js");
    selfImprovementExecutorSkill = new SelfImprovementExecutorSkill({
      executor_enabled: config.self_improvement.executor_enabled,
      executor_require_approval: config.self_improvement.executor_require_approval,
      executor_cron: config.self_improvement.executor_cron,
      executor_max_files: config.self_improvement.executor_max_files,
      executor_blast_radius_limit: config.self_improvement.executor_blast_radius_limit,
      executor_allowed_paths: config.self_improvement.executor_allowed_paths,
      executor_forbidden_paths: config.self_improvement.executor_forbidden_paths,
      executor_auto_merge: false,
      executor_shadow_port: config.self_improvement.executor_shadow_port,
      executor_max_run_duration_minutes: config.self_improvement.executor_max_run_duration_minutes,
      executor_webhook_name: config.self_improvement.executor_webhook_name,
      executor_github_owner: config.self_improvement.executor_github_owner,
      executor_github_repo: config.self_improvement.executor_github_repo,
    });
    selfImprovementExecutorSkill.setAgentLoader(getAgentLoader());
    selfImprovementExecutorSkill.setSkillRegistry(skillRegistry);
    skillRegistry.register(selfImprovementExecutorSkill);
    logger.info("Self-improvement executor skill registered");
  }

  // Register self-improvement skill (4.2 + 4.3)
  if (config.self_improvement?.enabled !== false) {
    const selfImprovementSkill = new SelfImprovementSkill({
      reflection_cron: config.self_improvement?.reflection_cron,
      approval_channel: config.self_improvement?.approval_channel,
      prompt_evolution_enabled: config.self_improvement?.prompt_evolution_enabled,
      gap_detection_enabled: config.self_improvement?.gap_detection_enabled,
      gap_detection_cron: config.self_improvement?.gap_detection_cron,
    });
    selfImprovementSkill.setPromptManager(promptManager);
    selfImprovementSkill.setAuditService(auditService);
    selfImprovementSkill.setSystemPromptGetter(
      (userId: string) => orchestrator.getSystemPromptSnapshot(userId)
    );
    selfImprovementSkill.setToolListGetter(
      () => skillRegistry.getToolDefinitions().map(t => t.name)
    );
    selfImprovementSkill.setSkillListGetter(
      () => skillRegistry.listSkills().map(s => s.name)
    );
    skillRegistry.register(selfImprovementSkill);

    // Wire few-shot service (5.7)
    if (config.self_improvement?.few_shot_enabled !== false) {
      const fewShotService = new FewShotService(db, logger, {
        minScore: config.self_improvement?.few_shot_min_score,
        minToolCalls: config.self_improvement?.few_shot_min_tool_calls,
      });
      const opusLlmForFewShot = buildOpusLlm();
      if (opusLlmForFewShot) {
        fewShotService.setOpusLlm(opusLlmForFewShot);
      }
      orchestrator.setFewShotService(fewShotService);
      selfImprovementSkill.setFewShotService(fewShotService);
    }
  }

  // 8a. Initialize DoctorService
  const doctorService = new DoctorService(logger, {
    enabled: config.doctor.enabled,
    patternWindowMs: config.doctor.pattern_window_seconds * 1000,
    patternThreshold: config.doctor.pattern_threshold,
    skillRecoveryIntervalMs: config.doctor.skill_recovery_interval_seconds * 1000,
    maxErrorHistory: config.doctor.max_error_history,
  }, {
    eventBus,
    skillHealthTracker,
    providerManager,
  });
  orchestrator.setDoctorService(doctorService);
  doctorService.start();

  // Register doctor skill
  skillRegistry.register(new DoctorSkill(doctorService, skillHealthTracker));

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
    safe_default_tools: [
      "firecrawl_scrape",
      "firecrawl_search",
      "firecrawl_map",
      "note_save",
      "note_search",
    ],
    restricted_tools: [],
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
  subagentSkill.setSpecialistConfig(config.specialists);

  // Wire subagentManager into self-improvement executor (after it's created)
  if (selfImprovementExecutorSkill) {
    selfImprovementExecutorSkill.setSubagentManager(subagentManager);
  }

  // Helper: build Opus LLM client (for privileged skills like self-improvement)
  const opusModel = config.self_improvement?.opus_model;

  function buildOpusLlm(): SkillContext["opusLlm"] {
    // If no specific opus config, fall back to heavy tier
    return {
      async chat(params) {
        // Try to use the configured opus provider; fall back to heavy tier
        let provider;
        let model;
        try {
          const heavySelection = await providerManager.getForUserTiered("system", "heavy");
          provider = heavySelection.provider;
          model = opusModel ?? heavySelection.model;
        } catch {
          const selection = await providerManager.getForUser("system");
          provider = selection.provider;
          model = opusModel ?? selection.model;
        }
        const response = await provider.chat({
          model,
          system: params.system,
          messages: params.messages.map((m) => ({ role: m.role, content: m.content })),
          maxTokens: params.maxTokens ?? 4096,
        });
        return { text: response.text };
      },
    };
  }

  // 9. Start all skills with context (real Redis-backed + scheduler)
  await skillRegistry.startupAll((skillName: string): SkillContext => {
    const prefix = `skill:${skillName}:`;
    const isPrivilegedSkill = skillName === "self-improvement";
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
      llm: {
        async chat(params) {
          const { provider, model } = await providerManager.getForUserTiered("system", "light");
          const response = await provider.chat({
            model,
            system: params.system,
            messages: params.messages.map((m) => ({ role: m.role, content: m.content })),
            maxTokens: params.maxTokens ?? 4096,
          });
          return { text: response.text };
        },
      },
      // Inject Opus LLM only for privileged skills
      opusLlm: isPrivilegedSkill ? buildOpusLlm() : undefined,
      conversations: {
        async getHistory(userId: string) {
          const history = await contextStore.getHistory(userId);
          return history.map((m) => ({
            role: m.role,
            content: typeof m.content === "string" ? m.content : "",
            timestamp: Date.now(), // Approximate, as we don't store timestamps in LLMMessage
          }));
        },
        getAllHistories() {
          return contextStore.getAllHistories();
        },
      },
      messageSender,
    };
  });

  // 9b. Start SubagentManager
  subagentManager.startup();

  // 9c. Start periodic cleanup for confirmation tokens
  const CONFIRMATION_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
  const confirmationCleanupInterval = setInterval(async () => {
    try {
      await confirmationManager.cleanup();
      logger.debug("Confirmation token cleanup completed");
    } catch (err) {
      logger.error({ error: err }, "Failed to cleanup confirmation tokens");
    }
  }, CONFIRMATION_CLEANUP_INTERVAL_MS);

  logger.info(
    { intervalMinutes: CONFIRMATION_CLEANUP_INTERVAL_MS / 60000 },
    "Confirmation cleanup interval started"
  );

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
    subagentManager,
    mcpManager
  );
  await discordBot.start();

  // Register Discord alert sink
  const discordSink = new DiscordAlertSink(discordBot);
  alertRouter.registerSink("discord", discordSink);

  // Start Telegram bot (optional)
  let telegramBot: TelegramBot | undefined;
  if (config.telegram) {
    telegramBot = new TelegramBot(
      {
        botToken: config.telegram.bot_token,
        chatId: config.telegram.chat_id,
        allowedUserIds: config.telegram.allowed_user_ids,
      },
      orchestrator,
      logger
    );
    await telegramBot.start();

    const telegramSink = new TelegramAlertSink(telegramBot);
    alertRouter.registerSink("telegram", telegramSink);
  }

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
    } else if (channel === "telegram" && telegramBot) {
      await telegramBot.sendNotification(message);
    } else {
      // Default to Discord for unknown channels
      await discordBot.sendNotification(message);
    }
  });

  // 10c. Register messaging channels with MessageSender for proactive sends
  messageSender.registerChannel({
    id: "discord",
    name: "Discord",
    send: (msg) => discordBot.sendNotification(msg),
  });
  if (slackBot) {
    messageSender.registerChannel({
      id: "slack",
      name: "Slack",
      send: (msg) => slackBot!.sendNotification(msg),
    });
  }
  if (telegramBot) {
    messageSender.registerChannel({
      id: "telegram",
      name: "Telegram",
      send: (msg) => telegramBot!.sendNotification(msg),
    });
  }

  // 10d. Start config hot-reload watcher (after event bus is running)
  configWatcher.start();

  // 11. Start REST API (health checks) with real service deps
  const restApi = new RestApi(logger, {
    redis,
    skillHealth: skillHealthTracker,
    providerManager,
  }, {
    apiKey: config.server.api_key,
    requireAuthForHealth: config.server.require_auth_for_health,
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
    configWatcher.stop();
    doctorService.stop();
    clearInterval(confirmationCleanupInterval);
    await subagentManager.shutdown();
    await discordBot.stop();
    if (slackBot) await slackBot.stop();
    if (telegramBot) await telegramBot.stop();
    await restApi.stop();
    if (mcpManager) await mcpManager.shutdown();
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
