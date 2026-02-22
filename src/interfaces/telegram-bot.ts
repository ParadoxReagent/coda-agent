import { Bot, type Context, InputFile } from "grammy";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Orchestrator } from "../core/orchestrator.js";
import type { Logger } from "../utils/logger.js";
import type { InboundAttachment, OrchestratorResponse } from "../core/types.js";
import { ContentSanitizer } from "../core/sanitizer.js";
import { TempDirManager } from "../core/temp-dir.js";
import { formatUserFacingError } from "./user-facing-error.js";

interface TelegramBotConfig {
  botToken: string;
  chatId: string;
  allowedUserIds: string[];
}

interface TelegramFileInfo {
  fileId: string;
  fileName: string;
  mimeType?: string;
  sizeBytes?: number;
}

/** Chunk a string into pieces of max `size` characters. */
function chunkResponse(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}

export class TelegramBot {
  private bot: Bot;
  private config: TelegramBotConfig;
  private orchestrator: Orchestrator;
  private logger: Logger;
  private allowedUserIds: Set<string>;

  constructor(
    config: TelegramBotConfig,
    orchestrator: Orchestrator,
    logger: Logger
  ) {
    this.config = config;
    this.orchestrator = orchestrator;
    this.logger = logger;
    this.allowedUserIds = new Set(config.allowedUserIds);

    this.bot = new Bot(config.botToken);
    this.setupHandlers();
  }

  async start(): Promise<void> {
    this.bot.start();
    this.logger.info("Telegram bot connected (long polling)");
  }

  async stop(): Promise<void> {
    this.bot.stop();
    this.logger.info("Telegram bot disconnected");
  }

  async sendNotification(content: string): Promise<void> {
    try {
      await this.bot.api.sendMessage(this.config.chatId, content);
    } catch (err) {
      this.logger.error({ error: err }, "Failed to send Telegram notification");
    }
  }

  private isAllowed(ctx: Context): boolean {
    const chatId = ctx.chat?.id;
    const from = ctx.from;

    if (!chatId || !from) return false;
    if (from.is_bot) return false;
    if (String(chatId) !== this.config.chatId) return false;
    if (!this.allowedUserIds.has(String(from.id))) return false;

    return true;
  }

  private setupHandlers(): void {
    this.bot.on("message:text", async (ctx) => {
      if (!this.isAllowed(ctx)) return;

      const userId = String(ctx.from.id);
      const text = ctx.message.text ?? "";

      await this.handleIncoming(ctx, userId, text, undefined);
    });

    this.bot.on("message:document", async (ctx) => {
      if (!this.isAllowed(ctx)) return;

      const userId = String(ctx.from.id);
      const text = ctx.message.caption ?? "";
      const doc = ctx.message.document;

      await this.handleIncoming(ctx, userId, text, [
        {
          fileId: doc.file_id,
          fileName: doc.file_name ?? `document_${doc.file_id}`,
          mimeType: doc.mime_type,
          sizeBytes: doc.file_size,
        },
      ]);
    });

    this.bot.on("message:photo", async (ctx) => {
      if (!this.isAllowed(ctx)) return;

      const userId = String(ctx.from.id);
      const text = ctx.message.caption ?? "";
      const photos = ctx.message.photo;
      // Pick highest-resolution photo (last in array)
      const photo = photos[photos.length - 1]!;

      await this.handleIncoming(ctx, userId, text, [
        {
          fileId: photo.file_id,
          fileName: `photo_${photo.file_id}.jpg`,
          mimeType: "image/jpeg",
          sizeBytes: photo.file_size,
        },
      ]);
    });
  }

  private async handleIncoming(
    ctx: Context,
    userId: string,
    text: string,
    fileInfos: TelegramFileInfo[] | undefined
  ): Promise<void> {
    this.logger.debug({ userId, hasFiles: !!fileInfos }, "Processing Telegram message");

    await ctx.replyWithChatAction("typing");

    let tempDir: string | undefined;
    let orchestratorResponse: OrchestratorResponse | undefined;

    try {
      tempDir = await TempDirManager.create("coda-telegram-");
      const outputDir = join(tempDir, "output");
      await mkdir(outputDir, { recursive: true });

      let attachments: InboundAttachment[] | undefined;
      if (fileInfos && fileInfos.length > 0) {
        attachments = [];

        const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB (Telegram bot API limit)

        for (const fileInfo of fileInfos) {
          if (fileInfo.sizeBytes && fileInfo.sizeBytes > MAX_FILE_SIZE) {
            await ctx.reply(
              `File "${fileInfo.fileName}" is too large (${(fileInfo.sizeBytes / 1024 / 1024).toFixed(1)} MB). Maximum size is 20 MB.`
            );
            continue;
          }

          try {
            const fileObj = await ctx.api.getFile(fileInfo.fileId);
            const fileUrl = `https://api.telegram.org/file/bot${this.config.botToken}/${fileObj.file_path}`;
            const response = await fetch(fileUrl);

            if (!response.ok) {
              this.logger.warn(
                { fileName: fileInfo.fileName, status: response.status },
                "Failed to download Telegram file"
              );
              continue;
            }

            const buffer = Buffer.from(await response.arrayBuffer());
            const localPath = join(tempDir, fileInfo.fileName);
            await writeFile(localPath, buffer);

            attachments.push({
              name: fileInfo.fileName,
              localPath,
              mimeType: fileInfo.mimeType,
              sizeBytes: fileInfo.sizeBytes ?? buffer.length,
            });

            this.logger.debug(
              { fileName: fileInfo.fileName },
              "Downloaded Telegram file attachment"
            );
          } catch (err) {
            this.logger.error(
              { fileName: fileInfo.fileName, error: err },
              "Error downloading Telegram file"
            );
          }
        }

        if (attachments.length === 0) {
          attachments = undefined;
        }
      }

      orchestratorResponse = await this.orchestrator.handleMessage(
        userId,
        text,
        "telegram",
        attachments,
        tempDir
      );

      const sanitized = ContentSanitizer.sanitizeForTelegram(orchestratorResponse.text);

      // Send response files
      if (orchestratorResponse.files && orchestratorResponse.files.length > 0) {
        for (const file of orchestratorResponse.files) {
          try {
            await ctx.replyWithDocument(new InputFile(file.path, file.name));
            this.logger.debug({ fileName: file.name }, "Sent Telegram response file");
          } catch (err) {
            this.logger.error({ fileName: file.name, error: err }, "Failed to send Telegram file");
          }
        }
      }

      // Send text in chunks (Telegram limit: 4096 chars)
      for (const chunk of chunkResponse(sanitized, 4000)) {
        await ctx.reply(chunk);
      }
    } catch (err) {
      this.logger.error({ error: err }, "Telegram orchestrator error");

      try {
        await ctx.reply(formatUserFacingError(err));
      } catch (sendErr) {
        this.logger.error({ error: sendErr }, "Failed to send Telegram error reply");
      }
    } finally {
      if (tempDir) {
        const shouldCleanup = orchestratorResponse && !orchestratorResponse.pendingConfirmation;

        if (shouldCleanup) {
          await TempDirManager.cleanup(tempDir);
        } else if (!orchestratorResponse) {
          this.logger.warn(
            { tempDir },
            "Preserving temp directory due to error (may have pending confirmation)"
          );
        }
      }
    }
  }
}
