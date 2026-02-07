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
import type { SkillContext } from "./skills/context.js";

const logger = createLogger();

async function main() {
  logger.info("Starting coda agent...");

  // 1. Load configuration
  const config = loadConfig();
  logger.info("Configuration loaded");

  // 2. Initialize core services
  const providerManager = new ProviderManager(config.llm, logger);
  const eventBus = new InProcessEventBus(logger);
  const alertRouter = new AlertRouter(logger);
  alertRouter.attachToEventBus(eventBus);

  const contextStore = new ContextStore(logger);
  const confirmationManager = new ConfirmationManager(logger);

  // 3. Create skill registry
  const skillRegistry = new SkillRegistry(logger);

  // 4. Load external skills
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

  // 5. Create orchestrator
  const orchestrator = new Orchestrator(
    providerManager,
    skillRegistry,
    contextStore,
    eventBus,
    confirmationManager,
    logger
  );

  // 6. Start all skills with context
  await skillRegistry.startupAll((skillName: string): SkillContext => ({
    config: {},
    logger: logger.child({ skill: skillName }),
    redis: {
      async get(_key: string) { return null; },
      async set(_key: string, _value: string) {},
      async del(_key: string) {},
    },
    eventBus,
  }));

  // 7. Start Discord bot
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

  // 8. Start REST API (health checks)
  const restApi = new RestApi(logger);
  await restApi.start(config.server.port, config.server.host);

  // 9. Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Received shutdown signal");
    await discordBot.stop();
    await restApi.stop();
    await skillRegistry.shutdownAll();
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
