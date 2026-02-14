import {
  Client,
  GatewayIntentBits,
  Events,
  SlashCommandBuilder,
  REST,
  Routes,
  type ChatInputCommandInteraction,
  type Interaction,
  type Message,
} from "discord.js";
import type { Orchestrator } from "../core/orchestrator.js";
import type { ProviderManager } from "../core/llm/manager.js";
import type { SkillRegistry } from "../skills/registry.js";
import type { Logger } from "../utils/logger.js";
import type { PreferencesManager } from "../core/preferences.js";
import type { SubagentManager } from "../core/subagent-manager.js";

interface DiscordBotConfig {
  botToken: string;
  channelId: string;
  allowedUserIds: string[];
}

/** Chunk a string into pieces of max `size` characters. */
function chunkResponse(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}

export class DiscordBot {
  private client: Client;
  private config: DiscordBotConfig;
  private orchestrator: Orchestrator;
  private providerManager: ProviderManager;
  private skills: SkillRegistry;
  private logger: Logger;
  private allowedUserIds: Set<string>;
  private preferences?: PreferencesManager;
  private subagentManager?: SubagentManager;

  constructor(
    config: DiscordBotConfig,
    orchestrator: Orchestrator,
    providerManager: ProviderManager,
    skills: SkillRegistry,
    logger: Logger,
    preferences?: PreferencesManager,
    subagentManager?: SubagentManager
  ) {
    this.config = config;
    this.orchestrator = orchestrator;
    this.providerManager = providerManager;
    this.skills = skills;
    this.logger = logger;
    this.allowedUserIds = new Set(config.allowedUserIds);
    this.preferences = preferences;
    this.subagentManager = subagentManager;

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });
  }

  async start(): Promise<void> {
    this.client.on(Events.ClientReady, () => {
      this.logger.info(
        { user: this.client.user?.tag },
        "Discord bot connected"
      );
    });

    this.client.on(Events.MessageCreate, (message) => {
      this.handleMessage(message).catch((err) => {
        this.logger.error({ error: err }, "Error handling Discord message");
      });
    });

    this.client.on(Events.InteractionCreate, (interaction) => {
      this.handleInteraction(interaction).catch((err) => {
        this.logger.error({ error: err }, "Error handling Discord interaction");
      });
    });

    await this.client.login(this.config.botToken);
    await this.registerSlashCommands();
  }

  async stop(): Promise<void> {
    this.client.destroy();
    this.logger.info("Discord bot disconnected");
  }

  async sendNotification(
    content: string | { embeds: unknown[] }
  ): Promise<void> {
    const channel = await this.client.channels.fetch(this.config.channelId);
    if (!channel || !("send" in channel)) {
      this.logger.warn("Notification channel not found or not sendable");
      return;
    }
    await (channel as { send: (msg: unknown) => Promise<unknown> }).send(content);
  }

  private async handleMessage(message: Message): Promise<void> {
    // Security: only respond in designated channel, only to allowed users
    if (message.channelId !== this.config.channelId) return;
    if (!this.allowedUserIds.has(message.author.id)) return;
    if (message.author.bot) return;

    this.logger.debug(
      { userId: message.author.id },
      "Processing Discord message"
    );

    const channel = message.channel;
    if (!("send" in channel)) return;

    // Show typing indicator
    if ("sendTyping" in channel) {
      await channel.sendTyping();
    }

    try {
      const response = await this.orchestrator.handleMessage(
        message.author.id,
        message.content,
        "discord"
      );

      // Handle long responses (Discord 2000 char limit)
      for (const chunk of chunkResponse(response, 1900)) {
        await channel.send(chunk);
      }
    } catch (err) {
      this.logger.error({ error: err }, "Orchestrator error");
      await channel.send(
        "Sorry, I encountered an error processing your message. Please try again."
      );
    }
  }

  private async handleInteraction(interaction: Interaction): Promise<void> {
    if (!interaction.isChatInputCommand()) return;
    if (!this.allowedUserIds.has(interaction.user.id)) {
      await interaction.reply({
        content: "You are not authorized to use this bot.",
        ephemeral: true,
      });
      return;
    }

    const { commandName } = interaction;

    switch (commandName) {
      case "ping":
        await interaction.reply("Pong!");
        break;

      case "status": {
        const skills = this.skills.listSkills();
        const lines = skills.map(
          (s) => `**${s.name}**: ${s.description} (${s.tools.length} tools)`
        );
        await interaction.reply(
          `**coda Status**\nSkills loaded: ${skills.length}\n${lines.join("\n") || "No skills loaded."}`
        );
        break;
      }

      case "help": {
        const skills = this.skills.listSkills();
        const lines = skills.map(
          (s) => `- **${s.name}**: ${s.description}\n  Tools: ${s.tools.join(", ")}`
        );
        await interaction.reply(
          `**Available Skills**\n${lines.join("\n") || "No skills loaded."}`
        );
        break;
      }

      case "model": {
        const subcommand = interaction.options.getSubcommand();
        await this.handleModelCommand(interaction, subcommand);
        break;
      }

      case "dnd": {
        if (!this.preferences) {
          await interaction.reply({ content: "Preferences not available.", ephemeral: true });
          break;
        }
        const prefs = await this.preferences.getPreferences(interaction.user.id);
        const newState = !prefs.dndEnabled;
        await this.preferences.setDnd(interaction.user.id, newState);
        await interaction.reply(
          newState
            ? "DND enabled — non-system alerts will be suppressed."
            : "DND disabled — all alerts will be delivered."
        );
        break;
      }

      case "briefing": {
        await interaction.deferReply();
        const response = await this.orchestrator.handleMessage(
          interaction.user.id,
          "Give me my morning briefing",
          "discord"
        );
        const chunks = chunkResponse(response, 1900);
        await interaction.editReply(chunks[0] ?? "No briefing data available.");
        for (let i = 1; i < chunks.length; i++) {
          await interaction.followUp(chunks[i]!);
        }
        break;
      }

      case "quiet": {
        if (!this.preferences) {
          await interaction.reply({ content: "Preferences not available.", ephemeral: true });
          break;
        }
        const start = interaction.options.getString("start");
        const end = interaction.options.getString("end");
        if (!start || !end) {
          const prefs = await this.preferences.getPreferences(interaction.user.id);
          const qh = prefs.quietHoursStart && prefs.quietHoursEnd
            ? `${prefs.quietHoursStart} – ${prefs.quietHoursEnd}`
            : "not set";
          await interaction.reply(`Current quiet hours: ${qh}`);
        } else {
          await this.preferences.setQuietHours(interaction.user.id, start, end);
          await interaction.reply(`Quiet hours set: ${start} – ${end}`);
        }
        break;
      }

      case "subagents": {
        if (!this.subagentManager) {
          await interaction.reply({ content: "Subagents are not available.", ephemeral: true });
          break;
        }
        const subcommand = interaction.options.getSubcommand();
        await this.handleSubagentsCommand(interaction, subcommand);
        break;
      }
    }
  }

  private async handleModelCommand(
    interaction: ChatInputCommandInteraction,
    subcommand: string
  ): Promise<void> {
    switch (subcommand) {
      case "list": {
        const providers = this.providerManager.listProviders();
        const lines = providers.map(
          (p) =>
            `**${p.name}**: ${p.models.join(", ")} (tools: ${p.capabilities.tools})`
        );
        await interaction.reply(
          `**Available Providers**\n${lines.join("\n")}`
        );
        break;
      }

      case "set": {
        const provider = interaction.options.getString("provider");
        const model = interaction.options.getString("model");
        if (!provider || !model) {
          await interaction.reply("Usage: /model set <provider> <model>");
          return;
        }
        try {
          this.providerManager.setUserPreference(
            interaction.user.id,
            provider,
            model
          );
          await interaction.reply(
            `Switched to **${provider}** / **${model}**`
          );
        } catch (err) {
          await interaction.reply(
            `Error: ${err instanceof Error ? err.message : "Unknown error"}`
          );
        }
        break;
      }

      case "status": {
        const tiersEnabled = this.providerManager.isTierEnabled();

        if (tiersEnabled) {
          // Tier-aware status
          const tierStatus = this.providerManager.getUserTierStatus(interaction.user.id);
          const tierUsage = this.providerManager.usage.getDailyUsageByTier();

          let statusText = "**Tier Configuration**\n";
          statusText += `Light: ${tierStatus.light?.provider}/${tierStatus.light?.model}\n`;
          statusText += `Heavy: ${tierStatus.heavy?.provider}/${tierStatus.heavy?.model}\n`;

          if (tierStatus.userPreferences?.light || tierStatus.userPreferences?.heavy) {
            statusText += "\n**User Overrides**\n";
            if (tierStatus.userPreferences.light) {
              statusText += `Light: ${tierStatus.userPreferences.light.provider}/${tierStatus.userPreferences.light.model}\n`;
            }
            if (tierStatus.userPreferences.heavy) {
              statusText += `Heavy: ${tierStatus.userPreferences.heavy.provider}/${tierStatus.userPreferences.heavy.model}\n`;
            }
          }

          statusText += "\n**Today's Usage by Tier**\n";

          const lightUsage = tierUsage.get("light");
          const heavyUsage = tierUsage.get("heavy");

          if (lightUsage && lightUsage.length > 0) {
            statusText += "\nLight tier:\n";
            for (const u of lightUsage) {
              const costStr = u.usageTracked
                ? u.estimatedCost !== null
                  ? `$${u.estimatedCost.toFixed(4)}`
                  : "cost not configured"
                : "usage not tracked";
              statusText += `  ${u.provider}/${u.model}: ${u.totalInputTokens} in / ${u.totalOutputTokens} out (${u.requestCount} requests, ${costStr})\n`;
            }
          }

          if (heavyUsage && heavyUsage.length > 0) {
            statusText += "\nHeavy tier:\n";
            for (const u of heavyUsage) {
              const costStr = u.usageTracked
                ? u.estimatedCost !== null
                  ? `$${u.estimatedCost.toFixed(4)}`
                  : "cost not configured"
                : "usage not tracked";
              statusText += `  ${u.provider}/${u.model}: ${u.totalInputTokens} in / ${u.totalOutputTokens} out (${u.requestCount} requests, ${costStr})\n`;
            }
          }

          if ((!lightUsage || lightUsage.length === 0) && (!heavyUsage || heavyUsage.length === 0)) {
            statusText += "No usage today.\n";
          }

          const cost = this.providerManager.usage.getTodayTotalCost();
          if (cost !== null) {
            statusText += `\nTotal estimated cost: $${cost.toFixed(4)}`;
          }

          await interaction.reply(statusText);
        } else {
          // Legacy non-tier status
          const { provider, model } =
            await this.providerManager.getForUser(interaction.user.id);
          const usage = this.providerManager.usage.getDailyUsage();
          const cost = this.providerManager.usage.getTodayTotalCost();

          let usageText = "No usage today.";
          if (usage.length > 0) {
            const lines = usage.map((u) => {
              const costStr = u.usageTracked
                ? u.estimatedCost !== null
                  ? `$${u.estimatedCost.toFixed(4)}`
                  : "cost not configured"
                : "usage not tracked";
              return `  ${u.provider}/${u.model}: ${u.totalInputTokens} in / ${u.totalOutputTokens} out (${u.requestCount} requests, ${costStr})`;
            });
            usageText = lines.join("\n");
          }

          await interaction.reply(
            `**Current Model**\nProvider: ${provider.name}\nModel: ${model}\nCapabilities: tools=${provider.capabilities.tools}, parallel=${provider.capabilities.parallelToolCalls}\n\n**Today's Usage**\n${usageText}${cost !== null ? `\n\nTotal estimated cost: $${cost.toFixed(4)}` : ""}`
          );
        }
        break;
      }

      case "tier": {
        const tier = interaction.options.getString("tier") as "light" | "heavy" | null;
        const provider = interaction.options.getString("provider");
        const model = interaction.options.getString("model");

        if (!tier || !provider || !model) {
          await interaction.reply("Usage: /model tier <light|heavy> <provider> <model>");
          return;
        }

        if (!this.providerManager.isTierEnabled()) {
          await interaction.reply("Tiers are not enabled in the configuration.");
          return;
        }

        try {
          this.providerManager.setUserTierPreference(
            interaction.user.id,
            tier,
            provider,
            model
          );
          await interaction.reply(
            `Set ${tier} tier to **${provider}** / **${model}**`
          );
        } catch (err) {
          await interaction.reply(
            `Error: ${err instanceof Error ? err.message : "Unknown error"}`
          );
        }
        break;
      }
    }
  }

  private async handleSubagentsCommand(
    interaction: ChatInputCommandInteraction,
    subcommand: string
  ): Promise<void> {
    const userId = interaction.user.id;

    switch (subcommand) {
      case "list": {
        const runs = this.subagentManager!.listRuns(userId);
        if (runs.length === 0) {
          await interaction.reply("No active sub-agent runs.");
          return;
        }
        const lines = runs.map(
          (r) =>
            `\`${r.id.slice(0, 8)}\` | ${r.status} | ${r.mode} | ${r.task.slice(0, 60)}`
        );
        await interaction.reply(
          `**Active Sub-agents**\n${lines.join("\n")}`
        );
        break;
      }

      case "stop": {
        const runId = interaction.options.getString("run_id");
        if (!runId) {
          await interaction.reply("Please provide a run ID.");
          return;
        }
        try {
          const stopped = await this.subagentManager!.stopRun(userId, runId);
          await interaction.reply(
            stopped
              ? `Sub-agent \`${runId.slice(0, 8)}\` stopped.`
              : `No active run found with ID \`${runId.slice(0, 8)}\`.`
          );
        } catch (err) {
          await interaction.reply(
            `Error: ${err instanceof Error ? err.message : "Unknown error"}`
          );
        }
        break;
      }

      case "log": {
        const runId = interaction.options.getString("run_id");
        if (!runId) {
          await interaction.reply("Please provide a run ID.");
          return;
        }
        const transcript = this.subagentManager!.getRunLog(userId, runId);
        if (!transcript) {
          await interaction.reply(
            `No run found with ID \`${runId.slice(0, 8)}\` or access denied.`
          );
          return;
        }
        if (transcript.length === 0) {
          await interaction.reply("No transcript entries yet.");
          return;
        }
        const entries = transcript
          .slice(-10)
          .map(
            (t) =>
              `[${t.role}${t.toolName ? ` (${t.toolName})` : ""}] ${t.content.slice(0, 200)}`
          );
        await interaction.reply(
          `**Transcript** (last ${entries.length} entries)\n\`\`\`\n${entries.join("\n")}\n\`\`\``
        );
        break;
      }

      case "info": {
        const runId = interaction.options.getString("run_id");
        if (!runId) {
          await interaction.reply("Please provide a run ID.");
          return;
        }
        const info = this.subagentManager!.getRunInfo(userId, runId);
        if (!info) {
          await interaction.reply(
            `No run found with ID \`${runId.slice(0, 8)}\` or access denied.`
          );
          return;
        }
        await interaction.reply(
          `**Sub-agent Info**\nID: \`${info.id}\`\nStatus: ${info.status}\nMode: ${info.mode}\nTask: ${info.task.slice(0, 200)}\nModel: ${info.model ?? "default"}\nTokens: ${info.inputTokens} in / ${info.outputTokens} out\nTool calls: ${info.toolCallCount}\nCreated: ${info.createdAt.toISOString()}`
        );
        break;
      }

      case "send": {
        const runId = interaction.options.getString("run_id");
        const message = interaction.options.getString("message");
        if (!runId || !message) {
          await interaction.reply("Please provide both a run ID and a message.");
          return;
        }
        const sent = this.subagentManager!.sendToRun(userId, runId, message);
        await interaction.reply(
          sent
            ? `Message sent to sub-agent \`${runId.slice(0, 8)}\`.`
            : `Could not send message: run not found, not running, or access denied.`
        );
        break;
      }
    }
  }

  private async registerSlashCommands(): Promise<void> {
    const commands = [
      new SlashCommandBuilder()
        .setName("ping")
        .setDescription("Health check"),

      new SlashCommandBuilder()
        .setName("status")
        .setDescription("Show loaded skills and their status"),

      new SlashCommandBuilder()
        .setName("help")
        .setDescription("List available skills and what they can do"),

      new SlashCommandBuilder()
        .setName("model")
        .setDescription("Manage LLM provider and model")
        .addSubcommand((sub) =>
          sub.setName("list").setDescription("Show available providers and models")
        )
        .addSubcommand((sub) =>
          sub
            .setName("set")
            .setDescription("Switch LLM provider and model")
            .addStringOption((opt) =>
              opt
                .setName("provider")
                .setDescription("Provider name")
                .setRequired(true)
            )
            .addStringOption((opt) =>
              opt
                .setName("model")
                .setDescription("Model name")
                .setRequired(true)
            )
        )
        .addSubcommand((sub) =>
          sub
            .setName("status")
            .setDescription("Show current provider, model, and usage")
        )
        .addSubcommand((sub) =>
          sub
            .setName("tier")
            .setDescription("Set tier-specific provider and model")
            .addStringOption((opt) =>
              opt
                .setName("tier")
                .setDescription("Tier (light or heavy)")
                .setRequired(true)
                .addChoices(
                  { name: "light", value: "light" },
                  { name: "heavy", value: "heavy" }
                )
            )
            .addStringOption((opt) =>
              opt
                .setName("provider")
                .setDescription("Provider name")
                .setRequired(true)
            )
            .addStringOption((opt) =>
              opt
                .setName("model")
                .setDescription("Model name")
                .setRequired(true)
            )
        ),

      new SlashCommandBuilder()
        .setName("dnd")
        .setDescription("Toggle Do Not Disturb mode"),

      new SlashCommandBuilder()
        .setName("briefing")
        .setDescription("Trigger your morning briefing"),

      new SlashCommandBuilder()
        .setName("quiet")
        .setDescription("Set or view quiet hours")
        .addStringOption((opt) =>
          opt
            .setName("start")
            .setDescription("Quiet hours start time (HH:MM)")
            .setRequired(false)
        )
        .addStringOption((opt) =>
          opt
            .setName("end")
            .setDescription("Quiet hours end time (HH:MM)")
            .setRequired(false)
        ),

      new SlashCommandBuilder()
        .setName("subagents")
        .setDescription("Manage sub-agent runs")
        .addSubcommand((sub) =>
          sub.setName("list").setDescription("List active sub-agent runs")
        )
        .addSubcommand((sub) =>
          sub
            .setName("stop")
            .setDescription("Stop a running sub-agent")
            .addStringOption((opt) =>
              opt
                .setName("run_id")
                .setDescription("Run ID to stop")
                .setRequired(true)
            )
        )
        .addSubcommand((sub) =>
          sub
            .setName("log")
            .setDescription("View sub-agent execution transcript")
            .addStringOption((opt) =>
              opt
                .setName("run_id")
                .setDescription("Run ID to view logs for")
                .setRequired(true)
            )
        )
        .addSubcommand((sub) =>
          sub
            .setName("info")
            .setDescription("View sub-agent run details")
            .addStringOption((opt) =>
              opt
                .setName("run_id")
                .setDescription("Run ID to get info for")
                .setRequired(true)
            )
        )
        .addSubcommand((sub) =>
          sub
            .setName("send")
            .setDescription("Send a message to a running sub-agent")
            .addStringOption((opt) =>
              opt
                .setName("run_id")
                .setDescription("Run ID to message")
                .setRequired(true)
            )
            .addStringOption((opt) =>
              opt
                .setName("message")
                .setDescription("Message to send")
                .setRequired(true)
            )
        ),
    ];

    const rest = new REST().setToken(this.config.botToken);

    try {
      await rest.put(
        Routes.applicationCommands(this.client.user!.id),
        { body: commands.map((c) => c.toJSON()) }
      );
      this.logger.info("Discord slash commands registered");
    } catch (err) {
      this.logger.error({ error: err }, "Failed to register slash commands");
    }
  }
}
