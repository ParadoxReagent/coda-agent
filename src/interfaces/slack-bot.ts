import { App } from "@slack/bolt";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Orchestrator } from "../core/orchestrator.js";
import type { Logger } from "../utils/logger.js";
import type { InboundAttachment } from "../core/types.js";
import { ContentSanitizer } from "../core/sanitizer.js";
import { TempDirManager } from "../core/temp-dir.js";

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

      // Skip bot messages and non-file_share subtypes
      if (msg.subtype && msg.subtype !== "file_share") return;
      if (!msg.user) return;

      const userId = msg.user as string;
      const text = (msg.text as string | undefined) ?? "";
      const channel = msg.channel as string | undefined;
      const threadTs = msg.thread_ts as string | undefined;
      const ts = msg.ts as string | undefined;
      const files = msg.files as Array<{
        id: string;
        name: string;
        mimetype?: string;
        size?: number;
        url_private_download?: string;
      }> | undefined;

      // Security: only respond to allowed users in designated channel
      if (channel !== this.config.channelId) return;
      if (!this.allowedUserIds.has(userId)) return;

      // Skip if no text and no files
      if (!text && (!files || files.length === 0)) return;

      this.logger.debug({ userId, hasFiles: !!files }, "Processing Slack message");

      let tempDir: string | undefined;

      try {
        // Always create temp directory and output subdirectory for code execution
        tempDir = await TempDirManager.create("coda-slack-");
        const outputDir = join(tempDir, "output");
        await mkdir(outputDir, { recursive: true });

        // Download file attachments if present
        let attachments: InboundAttachment[] | undefined;
        if (files && files.length > 0) {
          attachments = [];

          const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB limit

          for (const file of files) {
            // Enforce file size limit
            if (file.size && file.size > MAX_FILE_SIZE) {
              await say({
                text: `File "${file.name}" is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum size is 25 MB.`,
                thread_ts: threadTs ?? ts,
              });
              continue;
            }

            if (!file.url_private_download) {
              this.logger.warn(
                { fileName: file.name },
                "File has no download URL"
              );
              continue;
            }

            try {
              // Download file with bot token authorization
              const response = await fetch(file.url_private_download, {
                headers: {
                  Authorization: `Bearer ${this.config.botToken}`,
                },
              });

              if (!response.ok) {
                this.logger.warn(
                  { fileName: file.name, status: response.status },
                  "Failed to download file"
                );
                continue;
              }

              const buffer = Buffer.from(await response.arrayBuffer());
              const localPath = join(tempDir, file.name);
              await writeFile(localPath, buffer);

              attachments.push({
                name: file.name,
                localPath,
                mimeType: file.mimetype,
                sizeBytes: file.size ?? buffer.length,
              });

              this.logger.debug(
                { fileName: file.name, size: file.size },
                "Downloaded file attachment"
              );
            } catch (err) {
              this.logger.error(
                { fileName: file.name, error: err },
                "Error downloading file"
              );
            }
          }

          if (attachments.length === 0) {
            attachments = undefined;
          }
        }

        const response = await this.orchestrator.handleMessage(
          userId,
          text,
          "slack",
          attachments,
          tempDir
        );

        // Sanitize output to prevent channel-wide mentions
        const sanitized = ContentSanitizer.sanitizeForSlack(response.text);

        // Reply in thread if this was in a thread, otherwise start a new thread
        const replyThread = threadTs ?? ts;

        // Send text response
        for (const chunk of chunkResponse(sanitized, 3000)) {
          await say({
            text: chunk,
            thread_ts: replyThread,
          });
        }

        // Upload response files if present
        if (response.files && response.files.length > 0 && channel) {
          for (const file of response.files) {
            try {
              const uploadParams: any = {
                channel_id: channel,
                file: file.path,
                filename: file.name,
              };
              if (replyThread) {
                uploadParams.thread_ts = replyThread;
              }
              await this.app.client.files.uploadV2(uploadParams);
              this.logger.debug(
                { fileName: file.name },
                "Uploaded response file"
              );
            } catch (err) {
              this.logger.error(
                { fileName: file.name, error: err },
                "Failed to upload response file"
              );
            }
          }
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
      } finally {
        // Clean up temp directory
        if (tempDir) {
          await TempDirManager.cleanup(tempDir);
        }
      }
    });
  }
}
