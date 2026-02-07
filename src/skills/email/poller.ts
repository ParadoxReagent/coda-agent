import { ImapFlow } from "imapflow";
import { categorizeEmail } from "./categorizer.js";
import { RETENTION } from "../../utils/retention.js";
import type { EmailMetadata, EmailCategorizationRules } from "./types.js";
import type { SkillRedisClient } from "../context.js";
import type { EventBus } from "../../core/events.js";
import type { Logger } from "../../utils/logger.js";

export interface EmailPollerConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  tls: boolean;
  folders: string[];
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
    folder: string,
    hoursBack: number = 24
  ): Promise<EmailMetadata[]> {
    const indexKey = `emailIndex:${folder}`;
    const indexData = await this.redis.get(indexKey);
    if (!indexData) return [];

    const uids: number[] = JSON.parse(indexData);
    const cutoff = Date.now() - hoursBack * 3600_000;
    const emails: EmailMetadata[] = [];

    for (const uid of uids) {
      const cached = await this.redis.get(`email:${folder}:${uid}`);
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

  /** Single poll cycle: connect, fetch new messages, disconnect. */
  async poll(): Promise<void> {
    const client = new ImapFlow({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.tls,
      auth: {
        user: this.config.user,
        pass: this.config.pass,
      },
      logger: false,
    });

    try {
      await client.connect();

      for (const folder of this.config.folders) {
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
          messageId: envelope.messageId ?? "",
          from,
          to,
          cc,
          subject: envelope.subject ?? "(no subject)",
          date: envelope.date?.toISOString() ?? new Date().toISOString(),
          snippet: "", // Snippet populated if body is fetched
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
      const existingUids: number[] = existingIndex
        ? JSON.parse(existingIndex)
        : [];

      for (const email of messages) {
        await this.redis.set(
          `email:${folder}:${email.uid}`,
          JSON.stringify(email),
          RETENTION.EMAIL_CACHE
        );
        existingUids.push(email.uid);
      }

      await this.redis.set(
        indexKey,
        JSON.stringify(existingUids),
        RETENTION.EMAIL_CACHE
      );

      // Update lastUid
      const maxUid = Math.max(...messages.map((m) => m.uid));
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
