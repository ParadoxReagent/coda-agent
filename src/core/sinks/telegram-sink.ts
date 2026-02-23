import type { AlertSink } from "../alerts.js";
import type { TelegramBot } from "../../interfaces/telegram-bot.js";

/**
 * Alert sink that delivers alerts through the Telegram bot.
 * Telegram doesn't support rich embeds, so all alerts are sent as plain text.
 */
export class TelegramAlertSink implements AlertSink {
  private bot: TelegramBot;

  constructor(bot: TelegramBot) {
    this.bot = bot;
  }

  async send(_channel: string, message: string): Promise<void> {
    await this.bot.sendNotification(message);
  }

  async sendRich(_channel: string, formatted: unknown): Promise<void> {
    // formatAlertForTelegram returns a plain text string
    await this.bot.sendNotification(formatted as string);
  }
}
