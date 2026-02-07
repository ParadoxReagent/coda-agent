import { ImapFlow } from "imapflow";
import { categorizeEmail } from "./categorizer.js";
import { RETENTION } from "../../utils/retention.js";
import type { EmailMetadata, EmailCategorizationRules } from "./types.js";
import type { SkillRedisClient } from "../context.js";
import type { EventBus } from "../../core/events.js";
import type { Logger } from "../../utils/logger.js";
import type { GmailClient } from "./gmail-client.js";

export interface EmailPollerConfig {
  // IMAP config (optional — used only for legacy IMAP path)
  host?: string;
  port?: number;
  user?: string;
  pass?: string;
  tls?: boolean;
  folders?: string[];

  // Gmail API config (optional — used for OAuth path)
  gmailClient?: GmailClient;
  labels?: string[];

  // Common
  pollIntervalSeconds: number;
  categorizationRules: EmailCategorizationRules;
}

export class EmailPoller {
  private config: EmailPollerConfig;
  private redis: SkillRedisClient;
  private eventBus: EventBus;
  private logger: Logger;
  private pollInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    config: EmailPollerConfig,
    redis: SkillRedisClient,
    eventBus: EventBus,
    logger: Logger
  ) {
    this.config = config;
    this.redis = redis;
    this.eventBus = eventBus;
    this.logger = logger;
  }

  start(): void {
    // Run immediately, then on interval
    this.poll().catch((err) => {
      this.logger.error({ error: err }, "Initial email poll failed");
    });

    this.pollInterval = setInterval(
      () =>
        this.poll().catch((err) => {
          this.logger.error({ error: err }, "Email poll failed");
        }),
      this.config.pollIntervalSeconds * 1000
    );

    this.logger.info(
      { intervalSec: this.config.pollIntervalSeconds },
      "Email poller started"
    );
  }

  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.logger.info("Email poller stopped");
  }

  /** Fetch cached emails from Redis for tool calls. */
  async getCachedEmails(
    folderOrLabel: string,
    hoursBack: number = 24
  ): Promise<EmailMetadata[]> {
    const indexKey = `emailIndex:${folderOrLabel}`;
    const indexData = await this.redis.get(indexKey);
    if (!indexData) return [];

    const ids: string[] = JSON.parse(indexData);
    const cutoff = Date.now() - hoursBack * 3600_000;
    const emails: EmailMetadata[] = [];

    for (const id of ids) {
      const cached = await this.redis.get(`email:${folderOrLabel}:${id}`);
      if (!cached) continue;

      const email: EmailMetadata = JSON.parse(cached);
      if (new Date(email.date).getTime() >= cutoff) {
        emails.push(email);
      }
    }

    return emails.sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
    );
  }

  /** Single poll cycle. */
  async poll(): Promise<void> {
    if (this.config.gmailClient) {
      await this.pollGmail();
    } else {
      await this.pollImap();
    }
  }

  // ─── Gmail API polling ──────────────────────────────────────────

  private async pollGmail(): Promise<void> {
    const labels = this.config.labels ?? ["INBOX"];
    for (const label of labels) {
      await this.pollLabel(label);
    }
  }

  private async pollLabel(labelId: string): Promise<void> {
    const gmailClient = this.config.gmailClient!;
    const lastCheckedKey = `lastChecked:${labelId}`;
    const lastChecked = await this.redis.get(lastCheckedKey);

    // Build query for new messages since last check
    let query: string | undefined;
    if (lastChecked) {
      const epochSeconds = Math.floor(Date.parse(lastChecked) / 1000);
      query = `after:${epochSeconds}`;
    }

    const response = await gmailClient.listMessages([labelId], 100, undefined, query);
    const messageRefs = response.messages ?? [];

    if (messageRefs.length === 0) {
      await this.redis.set(lastCheckedKey, new Date().toISOString());
      return;
    }

    const messages: EmailMetadata[] = [];

    for (const ref of messageRefs) {
      if (!ref.id) continue;

      // Skip already-cached messages
      const cacheKey = `email:${labelId}:${ref.id}`;
      const existing = await this.redis.get(cacheKey);
      if (existing) continue;

      const fullMessage = await gmailClient.getMessage(ref.id, "metadata");
      const email = this.parseGmailMessage(fullMessage, labelId);
      messages.push(email);
    }

    if (messages.length === 0) {
      await this.redis.set(lastCheckedKey, new Date().toISOString());
      return;
    }

    // Cache in Redis
    const indexKey = `emailIndex:${labelId}`;
    const existingIndex = await this.redis.get(indexKey);
    const existingIds: string[] = existingIndex ? JSON.parse(existingIndex) : [];

    for (const email of messages) {
      await this.redis.set(
        `email:${labelId}:${email.messageId}`,
        JSON.stringify(email),
        RETENTION.EMAIL_CACHE
      );
      existingIds.push(email.messageId);
    }

    await this.redis.set(
      indexKey,
      JSON.stringify(existingIds),
      RETENTION.EMAIL_CACHE
    );

    await this.redis.set(lastCheckedKey, new Date().toISOString());

    // Publish alerts for urgent emails
    for (const email of messages) {
      if (email.category === "urgent") {
        await this.eventBus.publish({
          eventType: "alert.email.urgent",
          timestamp: new Date().toISOString(),
          sourceSkill: "email",
          payload: {
            messageId: email.messageId,
            from: email.from,
            subject: email.subject,
          },
          severity: "high",
        });
      }
    }

    this.logger.info(
      {
        label: labelId,
        newMessages: messages.length,
        urgent: messages.filter((m) => m.category === "urgent").length,
      },
      "Gmail API poll complete"
    );
  }

  private parseGmailMessage(
    message: { id?: string | null; internalDate?: string | null; snippet?: string | null; labelIds?: string[] | null; payload?: { headers?: Array<{ name?: string | null; value?: string | null }> | null } | null },
    labelId: string
  ): EmailMetadata {
    const headers = message.payload?.headers ?? [];
    const getHeader = (name: string) =>
      headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";

    const from = getHeader("from");
    const to = getHeader("to").split(",").map((s) => s.trim()).filter(Boolean);
    const cc = getHeader("cc").split(",").map((s) => s.trim()).filter(Boolean);
    const subject = getHeader("subject") || "(no subject)";
    const date = message.internalDate
      ? new Date(parseInt(message.internalDate)).toISOString()
      : new Date().toISOString();

    const email: EmailMetadata = {
      messageId: message.id ?? "",
      from,
      to,
      cc,
      subject,
      date,
      snippet: message.snippet ?? "",
      labels: message.labelIds ?? [],
      folder: labelId,
      category: "informational",
    };

    email.category = categorizeEmail(email, this.config.categorizationRules);
    return email;
  }

  // ─── Legacy IMAP polling ────────────────────────────────────────

  private async pollImap(): Promise<void> {
    const client = new ImapFlow({
      host: this.config.host!,
      port: this.config.port!,
      secure: this.config.tls!,
      auth: {
        user: this.config.user!,
        pass: this.config.pass!,
      },
      logger: false,
    });

    try {
      await client.connect();

      for (const folder of this.config.folders ?? ["INBOX"]) {
        await this.pollFolder(client, folder);
      }
    } finally {
      await client.logout().catch(() => {});
    }
  }

  private async pollFolder(
    client: ImapFlow,
    folder: string
  ): Promise<void> {
    const lock = await client.getMailboxLock(folder);

    try {
      // Get last UID we've seen
      const lastUidKey = `lastUid:${folder}`;
      const lastUidStr = await this.redis.get(lastUidKey);
      const lastUid = lastUidStr ? parseInt(lastUidStr, 10) : 0;

      // Fetch messages newer than lastUid
      const range = lastUid > 0 ? `${lastUid + 1}:*` : "1:*";

      const messages: EmailMetadata[] = [];

      for await (const msg of client.fetch(range, {
        uid: true,
        envelope: true,
        flags: true,
        bodyStructure: true,
        source: false,
      })) {
        if (msg.uid <= lastUid) continue;

        const envelope = msg.envelope;
        if (!envelope) continue;

        const from =
          envelope.from?.[0]
            ? `${envelope.from[0].name ?? ""} <${envelope.from[0].address ?? ""}>`
            : "unknown";
        const to = (envelope.to ?? []).map(
          (a: { name?: string; address?: string }) =>
            a.address ?? ""
        );
        const cc = (envelope.cc ?? []).map(
          (a: { name?: string; address?: string }) =>
            a.address ?? ""
        );

        const email: EmailMetadata = {
          uid: msg.uid,
          messageId: envelope.messageId ?? `imap-${msg.uid}`,
          from,
          to,
          cc,
          subject: envelope.subject ?? "(no subject)",
          date: envelope.date?.toISOString() ?? new Date().toISOString(),
          snippet: "",
          flags: Array.from(msg.flags ?? []),
          folder,
          category: "informational",
        };

        // Categorize
        email.category = categorizeEmail(email, this.config.categorizationRules);

        messages.push(email);
      }

      if (messages.length === 0) return;

      // Cache in Redis
      const indexKey = `emailIndex:${folder}`;
      const existingIndex = await this.redis.get(indexKey);
      const existingIds: string[] = existingIndex
        ? JSON.parse(existingIndex)
        : [];

      for (const email of messages) {
        const id = email.uid?.toString() ?? email.messageId;
        await this.redis.set(
          `email:${folder}:${id}`,
          JSON.stringify(email),
          RETENTION.EMAIL_CACHE
        );
        existingIds.push(id);
      }

      await this.redis.set(
        indexKey,
        JSON.stringify(existingIds),
        RETENTION.EMAIL_CACHE
      );

      // Update lastUid
      const maxUid = Math.max(...messages.map((m) => m.uid ?? 0));
      await this.redis.set(lastUidKey, maxUid.toString());

      // Publish alerts for urgent emails
      for (const email of messages) {
        if (email.category === "urgent") {
          await this.eventBus.publish({
            eventType: "alert.email.urgent",
            timestamp: new Date().toISOString(),
            sourceSkill: "email",
            payload: {
              uid: email.uid,
              from: email.from,
              subject: email.subject,
            },
            severity: "high",
          });
        }
      }

      this.logger.info(
        {
          folder,
          newMessages: messages.length,
          urgent: messages.filter((m) => m.category === "urgent").length,
        },
        "Email poll complete"
      );
    } finally {
      lock.release();
    }
  }
}
