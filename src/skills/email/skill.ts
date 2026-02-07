import { ImapFlow } from "imapflow";
import { EmailPoller } from "./poller.js";
import { GmailClient } from "./gmail-client.js";
import { OAuthManager } from "../../auth/oauth-manager.js";
import { TokenStorage } from "../../auth/token-storage.js";
import type { EmailCategorizationRules } from "./types.js";
import type { Skill, SkillToolDefinition } from "../base.js";
import type { SkillContext } from "../context.js";
import type { Logger } from "../../utils/logger.js";

export class EmailSkill implements Skill {
  readonly name = "email";
  readonly description =
    "Check, read, search, and flag emails with automatic categorization";

  private logger!: Logger;
  private poller!: EmailPoller;
  private gmailClient?: GmailClient;
  private imapConfig?: {
    host: string;
    port: number;
    user: string;
    pass: string;
    tls: boolean;
  };

  getTools(): SkillToolDefinition[] {
    return [
      {
        name: "email_check",
        description:
          "Check for new emails. Returns a summary grouped by category (urgent, needs_response, informational, low_priority).",
        input_schema: {
          type: "object",
          properties: {
            folder: {
              type: "string",
              description: "Folder/label to check (default: INBOX)",
            },
            hours_back: {
              type: "number",
              description: "Hours of email to check (default: 24)",
            },
          },
        },
      },
      {
        name: "email_read",
        description: "Read a specific email by message ID from the cache.",
        input_schema: {
          type: "object",
          properties: {
            message_id: {
              type: "string",
              description: "The message ID of the email",
            },
            uid: {
              type: "number",
              description: "The UID of the email (legacy IMAP)",
            },
            folder: {
              type: "string",
              description: "Folder/label (default: INBOX)",
            },
          },
        },
      },
      {
        name: "email_search",
        description:
          "Search cached emails by query, sender, or date range.",
        input_schema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search text (matches subject and from)",
            },
            sender: {
              type: "string",
              description: "Filter by sender address",
            },
            hours_back: {
              type: "number",
              description: "Limit to last N hours (default: 24)",
            },
          },
        },
      },
      {
        name: "email_flag",
        description: "Flag or unflag an email (star, mark read/unread).",
        input_schema: {
          type: "object",
          properties: {
            message_id: {
              type: "string",
              description: "The message ID of the email",
            },
            uid: {
              type: "number",
              description: "The UID of the email (legacy IMAP)",
            },
            folder: {
              type: "string",
              description: "Folder (default: INBOX)",
            },
            flag: {
              type: "string",
              enum: ["\\Flagged", "\\Seen", "\\Answered"],
              description: "Flag to add/remove",
            },
            remove: {
              type: "boolean",
              description: "If true, remove the flag instead of adding it",
            },
          },
          required: ["flag"],
        },
      },
    ];
  }

  async execute(
    toolName: string,
    toolInput: Record<string, unknown>
  ): Promise<string> {
    switch (toolName) {
      case "email_check":
        return this.checkEmails(toolInput);
      case "email_read":
        return this.readEmail(toolInput);
      case "email_search":
        return this.searchEmails(toolInput);
      case "email_flag":
        return this.flagEmail(toolInput);
      default:
        return `Unknown tool: ${toolName}`;
    }
  }

  getRequiredConfig(): string[] {
    return [];
  }

  async startup(ctx: SkillContext): Promise<void> {
    this.logger = ctx.logger;

    const oauthConfig = ctx.config.oauth as
      | { client_id: string; client_secret: string; redirect_port?: number; scopes?: string[] }
      | undefined;
    const gmailUser = ctx.config.gmail_user as string | undefined;

    if (oauthConfig && gmailUser) {
      // Gmail API with OAuth path


      const oauthManager = new OAuthManager({
        clientId: oauthConfig.client_id,
        clientSecret: oauthConfig.client_secret,
        redirectPort: oauthConfig.redirect_port ?? 3000,
        scopes: oauthConfig.scopes ?? [
          "https://www.googleapis.com/auth/gmail.readonly",
          "https://www.googleapis.com/auth/gmail.modify",
        ],
      });

      const tokenStorage = new TokenStorage(ctx.db);
      this.gmailClient = new GmailClient(oauthManager, tokenStorage, gmailUser);

      const labels = (ctx.config.labels as string[] | undefined) ?? ["INBOX"];
      const pollInterval =
        (ctx.config.poll_interval_seconds as number | undefined) ?? 300;
      const categorization = ctx.config.categorization as
        | Record<string, unknown>
        | undefined;

      const rules: EmailCategorizationRules = {
        urgentSenders: (categorization?.urgent_senders as string[] | undefined) ?? [],
        urgentKeywords: (categorization?.urgent_keywords as string[] | undefined) ?? [],
        knownContacts: (categorization?.known_contacts as string[] | undefined) ?? [],
      };

      this.poller = new EmailPoller(
        {
          gmailClient: this.gmailClient,
          labels,
          pollIntervalSeconds: pollInterval,
          categorizationRules: rules,
        },
        ctx.redis,
        ctx.eventBus,
        this.logger
      );

      this.poller.start();
      this.logger.info("Email skill started (Gmail API with OAuth2)");
    } else {
      // Legacy IMAP path


      this.imapConfig = {
        host: ctx.config.imap_host as string,
        port: (ctx.config.imap_port as number | undefined) ?? 993,
        user: ctx.config.imap_user as string,
        pass: ctx.config.imap_pass as string,
        tls: (ctx.config.imap_tls as boolean | undefined) ?? true,
      };

      const folders = (ctx.config.folders as string[] | undefined) ?? ["INBOX"];
      const pollInterval =
        (ctx.config.poll_interval_seconds as number | undefined) ?? 300;
      const categorization = ctx.config.categorization as
        | Record<string, unknown>
        | undefined;

      const rules: EmailCategorizationRules = {
        urgentSenders: (categorization?.urgent_senders as string[] | undefined) ?? [],
        urgentKeywords: (categorization?.urgent_keywords as string[] | undefined) ?? [],
        knownContacts: (categorization?.known_contacts as string[] | undefined) ?? [],
      };

      this.poller = new EmailPoller(
        {
          ...this.imapConfig,
          folders,
          pollIntervalSeconds: pollInterval,
          categorizationRules: rules,
        },
        ctx.redis,
        ctx.eventBus,
        this.logger
      );

      this.poller.start();
      this.logger.info("Email skill started (legacy IMAP)");
    }
  }

  async shutdown(): Promise<void> {
    this.poller.stop();
    this.logger.info("Email skill stopped");
  }

  private async checkEmails(
    input: Record<string, unknown>
  ): Promise<string> {
    const folder = (input.folder as string | undefined) ?? "INBOX";
    const hoursBack = (input.hours_back as number | undefined) ?? 24;

    const emails = await this.poller.getCachedEmails(folder, hoursBack);

    if (emails.length === 0) {
      return JSON.stringify({
        summary: {},
        total: 0,
        message: "No recent emails found.",
      });
    }

    // Group by category
    const grouped: Record<string, EmailSummary[]> = {};
    for (const email of emails) {
      if (!grouped[email.category]) {
        grouped[email.category] = [];
      }
      grouped[email.category]!.push({
        messageId: email.messageId,
        uid: email.uid,
        from: email.from,
        subject: email.subject,
        date: email.date,
      });
    }

    return JSON.stringify({
      summary: grouped,
      total: emails.length,
      urgent: grouped["urgent"]?.length ?? 0,
      needsResponse: grouped["needs_response"]?.length ?? 0,
    });
  }

  private async readEmail(
    input: Record<string, unknown>
  ): Promise<string> {
    const messageId = input.message_id as string | undefined;
    const uid = input.uid as number | undefined;
    const folder = (input.folder as string | undefined) ?? "INBOX";

    const emails = await this.poller.getCachedEmails(folder, 48);
    const email = emails.find((e) => {
      if (messageId && e.messageId === messageId) return true;
      if (uid && e.uid === uid) return true;
      return false;
    });

    if (!email) {
      return JSON.stringify({
        success: false,
        message: `Email not found in cache. It may have expired.`,
      });
    }

    return JSON.stringify({
      messageId: email.messageId,
      uid: email.uid,
      from: email.from,
      to: email.to,
      cc: email.cc,
      subject: email.subject,
      date: email.date,
      category: email.category,
      labels: email.labels,
      flags: email.flags,
      snippet: email.snippet,
    });
  }

  private async searchEmails(
    input: Record<string, unknown>
  ): Promise<string> {
    const query = (input.query as string | undefined) ?? "";
    const sender = input.sender as string | undefined;
    const hoursBack = (input.hours_back as number | undefined) ?? 24;

    const emails = await this.poller.getCachedEmails("INBOX", hoursBack);
    const lowerQuery = query.toLowerCase();
    const lowerSender = sender?.toLowerCase();

    const filtered = emails.filter((email) => {
      if (lowerQuery && !(
        email.subject.toLowerCase().includes(lowerQuery) ||
        email.from.toLowerCase().includes(lowerQuery)
      )) {
        return false;
      }
      if (lowerSender && !email.from.toLowerCase().includes(lowerSender)) {
        return false;
      }
      return true;
    });

    if (filtered.length === 0) {
      return JSON.stringify({
        results: [],
        message: "No matching emails found.",
      });
    }

    return JSON.stringify({
      results: filtered.map((e) => ({
        messageId: e.messageId,
        uid: e.uid,
        from: e.from,
        subject: e.subject,
        date: e.date,
        category: e.category,
      })),
      count: filtered.length,
    });
  }

  private async flagEmail(
    input: Record<string, unknown>
  ): Promise<string> {
    const messageId = input.message_id as string | undefined;
    const uid = input.uid as number | undefined;
    const folder = (input.folder as string | undefined) ?? "INBOX";
    const flag = input.flag as string;
    const remove = (input.remove as boolean | undefined) ?? false;

    if (this.gmailClient && messageId) {
      return this.flagEmailGmail(messageId, flag, remove);
    } else if (this.imapConfig && uid) {
      return this.flagEmailImap(uid, folder, flag, remove);
    } else {
      return JSON.stringify({
        success: false,
        message: "Missing message_id (for Gmail) or uid (for IMAP)",
      });
    }
  }

  private async flagEmailGmail(
    messageId: string,
    flag: string,
    remove: boolean
  ): Promise<string> {
    // Map IMAP flags to Gmail label operations
    try {
      if (flag === "\\Seen") {
        // "Seen" means remove UNREAD label; "unseen" means add UNREAD
        await this.gmailClient!.modifyMessage(
          messageId,
          remove ? ["UNREAD"] : undefined,
          remove ? undefined : ["UNREAD"]
        );
      } else if (flag === "\\Flagged") {
        await this.gmailClient!.modifyMessage(
          messageId,
          remove ? undefined : ["STARRED"],
          remove ? ["STARRED"] : undefined
        );
      } else {
        return JSON.stringify({
          success: false,
          message: `Unsupported flag for Gmail API: ${flag}. Supported: \\Flagged, \\Seen`,
        });
      }

      return JSON.stringify({
        success: true,
        message: `${remove ? "Removed" : "Added"} flag "${flag}" on email ${messageId}`,
      });
    } catch (err) {
      return JSON.stringify({
        success: false,
        message: `Failed to ${remove ? "remove" : "add"} flag: ${err instanceof Error ? err.message : "Unknown error"}`,
      });
    }
  }

  private async flagEmailImap(
    uid: number,
    folder: string,
    flag: string,
    remove: boolean
  ): Promise<string> {
    const client = new ImapFlow({
      host: this.imapConfig!.host,
      port: this.imapConfig!.port,
      secure: this.imapConfig!.tls,
      auth: {
        user: this.imapConfig!.user,
        pass: this.imapConfig!.pass,
      },
      logger: false,
    });

    try {
      await client.connect();
      const lock = await client.getMailboxLock(folder);

      try {
        if (remove) {
          await client.messageFlagsRemove({ uid: uid.toString() }, [flag], {
            uid: true,
          });
        } else {
          await client.messageFlagsAdd({ uid: uid.toString() }, [flag], {
            uid: true,
          });
        }
      } finally {
        lock.release();
      }

      return JSON.stringify({
        success: true,
        message: `${remove ? "Removed" : "Added"} flag "${flag}" on email ${uid}`,
      });
    } catch (err) {
      return JSON.stringify({
        success: false,
        message: `Failed to ${remove ? "remove" : "add"} flag: ${err instanceof Error ? err.message : "Unknown error"}`,
      });
    } finally {
      await client.logout().catch(() => {});
    }
  }
}

interface EmailSummary {
  messageId: string;
  uid?: number;
  from: string;
  subject: string;
  date: string;
}
