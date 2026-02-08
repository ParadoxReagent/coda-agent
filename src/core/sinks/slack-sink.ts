import type { AlertSink } from "../alerts.js";
import type { SlackBot } from "../../interfaces/slack-bot.js";

/**
 * Alert sink that delivers alerts through the Slack bot.
 * Supports both plain text and Block Kit formatted messages.
 */
export class SlackAlertSink implements AlertSink {
  private bot: SlackBot;

  constructor(bot: SlackBot) {
    this.bot = bot;
  }

  async send(_channel: string, message: string): Promise<void> {
    await this.bot.sendNotification(message);
  }

  async sendRich(_channel: string, formatted: unknown): Promise<void> {
    await this.bot.sendNotification(
      formatted as string | { blocks: unknown[] }
    );
  }
}
