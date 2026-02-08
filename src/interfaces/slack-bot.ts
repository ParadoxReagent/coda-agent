import { App } from "@slack/bolt";
import type { Orchestrator } from "../core/orchestrator.js";
import type { Logger } from "../utils/logger.js";

interface SlackBotConfig {
  appToken: string;
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

export class SlackBot {
  private app: App;
  private config: SlackBotConfig;
  private orchestrator: Orchestrator;
  private logger: Logger;
  private allowedUserIds: Set<string>;

  constructor(
    config: SlackBotConfig,
    orchestrator: Orchestrator,
    _providerManager: unknown,
    _skills: unknown,
    logger: Logger
  ) {
    this.config = config;
    this.orchestrator = orchestrator;
    this.logger = logger;
    this.allowedUserIds = new Set(config.allowedUserIds);

    this.app = new App({
      token: config.botToken,
      appToken: config.appToken,
      socketMode: true,
    });

    this.setupHandlers();
  }

  async start(): Promise<void> {
    await this.app.start();
    this.logger.info("Slack bot connected (Socket Mode)");
  }

  async stop(): Promise<void> {
    await this.app.stop();
    this.logger.info("Slack bot disconnected");
  }

  async sendNotification(
    content: string | { blocks: unknown[] }
  ): Promise<void> {
    try {
      if (typeof content === "string") {
        await this.app.client.chat.postMessage({
          channel: this.config.channelId,
          text: content,
        });
      } else {
        await this.app.client.chat.postMessage({
          channel: this.config.channelId,
          blocks: content.blocks as Parameters<typeof this.app.client.chat.postMessage>[0] extends { blocks?: infer B } ? B : never,
          text: "Alert notification",
        });
      }
    } catch (err) {
      this.logger.error({ error: err }, "Failed to send Slack notification");
    }
  }

  private setupHandlers(): void {
    this.app.message(async ({ message, say }) => {
      // Type guard for regular messages
      const msg = message as unknown as Record<string, unknown>;

      // Skip bot messages and subtypes
      if (msg.subtype) return;
      if (!msg.user || !msg.text) return;

      const userId = msg.user as string;
      const text = msg.text as string;
      const channel = msg.channel as string | undefined;
      const threadTs = msg.thread_ts as string | undefined;
      const ts = msg.ts as string | undefined;

      // Security: only respond to allowed users in designated channel
      if (channel !== this.config.channelId) return;
      if (!this.allowedUserIds.has(userId)) return;

      this.logger.debug({ userId }, "Processing Slack message");

      try {
        const response = await this.orchestrator.handleMessage(
          userId,
          text,
          "slack"
        );

        // Reply in thread if this was in a thread, otherwise start a new thread
        const replyThread = threadTs ?? ts;

        for (const chunk of chunkResponse(response, 3000)) {
          await say({
            text: chunk,
            thread_ts: replyThread,
          });
        }

        // Add checkmark reaction
        if (ts && channel) {
          await this.app.client.reactions.add({
            channel,
            timestamp: ts,
            name: "white_check_mark",
          }).catch(() => {
            // Ignore reaction failures
          });
        }
      } catch (err) {
        this.logger.error({ error: err }, "Slack orchestrator error");

        // Add warning reaction
        if (ts && channel) {
          await this.app.client.reactions.add({
            channel,
            timestamp: ts,
            name: "warning",
          }).catch(() => {});
        }

        await say({
          text: "Sorry, I encountered an error processing your message. Please try again.",
          thread_ts: threadTs ?? ts,
        });
      }
    });
  }
}
