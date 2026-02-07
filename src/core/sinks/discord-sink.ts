import type { AlertSink } from "../alerts.js";
import type { DiscordBot } from "../../interfaces/discord-bot.js";

/**
 * Alert sink that delivers alerts through the Discord bot.
 * Supports both plain text and rich embed messages.
 */
export class DiscordAlertSink implements AlertSink {
  private bot: DiscordBot;

  constructor(bot: DiscordBot) {
    this.bot = bot;
  }

  async send(_channel: string, message: string): Promise<void> {
    await this.bot.sendNotification(message);
  }

  async sendRich(_channel: string, formatted: unknown): Promise<void> {
    await this.bot.sendNotification(formatted as string | { embeds: unknown[] });
  }
}
