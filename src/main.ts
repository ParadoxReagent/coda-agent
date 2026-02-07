import { loadConfig } from "./utils/config.js";
import { createLogger } from "./utils/logger.js";
import { ProviderManager } from "./core/llm/manager.js";
import { InProcessEventBus } from "./core/events.js";
import { AlertRouter } from "./core/alerts.js";
import { ContextStore } from "./core/context.js";
import { ConfirmationManager } from "./core/confirmation.js";
import { Orchestrator } from "./core/orchestrator.js";
import { SkillRegistry } from "./skills/registry.js";
import { ExternalSkillLoader } from "./skills/loader.js";
import { DiscordBot } from "./interfaces/discord-bot.js";
import { RestApi } from "./interfaces/rest-api.js";
import { createDatabase } from "./db/index.js";
import { initializeDatabase } from "./db/connection.js";
import { NotesSkill } from "./skills/notes/skill.js";
import { ReminderSkill } from "./skills/reminders/skill.js";
import { CalendarSkill } from "./skills/calendar/skill.js";
import { EmailSkill } from "./skills/email/skill.js";
import type { SkillContext } from "./skills/context.js";
import type { AppConfig } from "./utils/config.js";
import Redis from "ioredis";

const logger = createLogger();

/** Map skill names to their config section from AppConfig. */
function getSkillConfig(skillName: string, config: AppConfig): Record<string, unknown> {
  const sectionMap: Record<string, unknown> = {
    notes: config.notes,
    reminders: config.reminders,
    calendar: config.calendar,
    email: config.email,
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
  logger.info("Database initialized");

  // 3. Initialize Redis
  const redis = new Redis(config.redis.url);
  logger.info("Redis connected");

  // 4. Initialize core services
  const providerManager = new ProviderManager(config.llm, logger);
  const eventBus = new InProcessEventBus(logger);
  const alertRouter = new AlertRouter(logger);
  alertRouter.attachToEventBus(eventBus);

  const contextStore = new ContextStore(logger);
  const confirmationManager = new ConfirmationManager(logger);

  // 5. Create skill registry
  const skillRegistry = new SkillRegistry(logger);

  // 6. Register internal skills
  // Notes and Reminders always register (no required external config)
  skillRegistry.register(new NotesSkill());
  skillRegistry.register(new ReminderSkill());

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

  // 8. Create orchestrator
  const orchestrator = new Orchestrator(
    providerManager,
    skillRegistry,
    contextStore,
    eventBus,
    confirmationManager,
    logger
  );

  // 9. Start all skills with context (real Redis-backed)
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
    };
  });

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
    logger
  );
  await discordBot.start();

  // 11. Start REST API (health checks)
  const restApi = new RestApi(logger);
  await restApi.start(config.server.port, config.server.host);

  // 12. Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Received shutdown signal");
    await discordBot.stop();
    await restApi.stop();
    await skillRegistry.shutdownAll();
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
