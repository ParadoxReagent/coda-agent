import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EmailSkill } from "../../../../src/integrations/email/skill.js";
import { createMockSkillContext, createMockEventBus } from "../../../helpers/mocks.js";
import type { EmailMetadata } from "../../../../src/integrations/email/types.js";
import type { SkillContext } from "../../../../src/skills/context.js";

// Mock EmailPoller
const mockStart = vi.fn();
const mockStop = vi.fn();
const mockGetCachedEmails = vi.fn();

vi.mock("../../../../src/integrations/email/poller.js", () => ({
  EmailPoller: vi.fn().mockImplementation(() => ({
    start: mockStart,
    stop: mockStop,
    getCachedEmails: mockGetCachedEmails,
  })),
}));

// Mock ImapFlow for email_flag
const mockImapConnect = vi.fn();
const mockImapLogout = vi.fn();
const mockImapGetMailboxLock = vi.fn();
const mockImapFlagsAdd = vi.fn();
const mockImapFlagsRemove = vi.fn();
const mockImapRelease = vi.fn();

vi.mock("imapflow", () => ({
  ImapFlow: vi.fn().mockImplementation(() => ({
    connect: mockImapConnect,
    logout: mockImapLogout,
    getMailboxLock: mockImapGetMailboxLock,
    messageFlagsAdd: mockImapFlagsAdd,
    messageFlagsRemove: mockImapFlagsRemove,
  })),
}));

function createTestEmailMeta(uid: number, overrides: Partial<EmailMetadata> = {}): EmailMetadata {
  return {
    uid,
    messageId: `<msg-${uid}@test.com>`,
    from: "sender@example.com",
    to: ["me@example.com"],
    cc: [],
    subject: `Test Email ${uid}`,
    date: new Date("2025-01-15T10:00:00Z").toISOString(),
    snippet: "Hello there",
    flags: [],
    folder: "INBOX",
    category: "informational",
    ...overrides,
  };
}

describe("EmailSkill", () => {
  let skill: EmailSkill;
  let ctx: SkillContext;

  beforeEach(async () => {
    vi.clearAllMocks();

    mockImapGetMailboxLock.mockResolvedValue({ release: mockImapRelease });
    mockImapConnect.mockResolvedValue(undefined);
    mockImapLogout.mockResolvedValue(undefined);

    skill = new EmailSkill();
    ctx = {
      ...createMockSkillContext("email"),
      eventBus: createMockEventBus(),
      config: {
        imap_host: "imap.example.com",
        imap_port: 993,
        imap_user: "user@example.com",
        imap_pass: "password",
        imap_tls: true,
        folders: ["INBOX"],
        poll_interval_seconds: 300,
        categorization: {
          urgent_senders: ["boss@company.com"],
          urgent_keywords: ["URGENT"],
          known_contacts: [],
        },
      },
    };

    await skill.startup(ctx);
  });

  afterEach(async () => {
    await skill.shutdown();
  });

  it("has correct metadata", () => {
    expect(skill.name).toBe("email");
    expect(skill.getRequiredConfig()).toEqual([]);
  });

  it("registers 4 tools", () => {
    const tools = skill.getTools();
    expect(tools).toHaveLength(4);
    expect(tools.map((t) => t.name)).toEqual([
      "email_check",
      "email_read",
      "email_search",
      "email_flag",
    ]);
  });

  it("starts poller on startup", () => {
    expect(mockStart).toHaveBeenCalled();
  });

  it("stops poller on shutdown", async () => {
    await skill.shutdown();
    expect(mockStop).toHaveBeenCalled();
  });

  describe("email_check", () => {
    it("returns grouped email summary", async () => {
      mockGetCachedEmails.mockResolvedValue([
        createTestEmailMeta(1, { category: "urgent", from: "boss@company.com" }),
        createTestEmailMeta(2, { category: "informational" }),
        createTestEmailMeta(3, { category: "needs_response" }),
      ]);

      const result = await skill.execute("email_check", {});

      const parsed = JSON.parse(result);
      expect(parsed.total).toBe(3);
      expect(parsed.urgent).toBe(1);
      expect(parsed.needsResponse).toBe(1);
      expect(parsed.summary.urgent).toHaveLength(1);
    });

    it("returns empty message when no emails", async () => {
      mockGetCachedEmails.mockResolvedValue([]);

      const result = await skill.execute("email_check", {});

      const parsed = JSON.parse(result);
      expect(parsed.total).toBe(0);
      expect(parsed.message).toContain("No recent emails");
    });
  });

  describe("email_read", () => {
    it("returns email details by UID", async () => {
      mockGetCachedEmails.mockResolvedValue([
        createTestEmailMeta(42, { subject: "Important email" }),
      ]);

      const result = await skill.execute("email_read", { uid: 42 });

      const parsed = JSON.parse(result);
      expect(parsed.uid).toBe(42);
      expect(parsed.subject).toBe("Important email");
    });

    it("returns error when email not found", async () => {
      mockGetCachedEmails.mockResolvedValue([]);

      const result = await skill.execute("email_read", { uid: 999 });

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.message).toContain("not found");
    });
  });

  describe("email_search", () => {
    it("filters by query in subject", async () => {
      mockGetCachedEmails.mockResolvedValue([
        createTestEmailMeta(1, { subject: "Meeting tomorrow" }),
        createTestEmailMeta(2, { subject: "Invoice attached" }),
      ]);

      const result = await skill.execute("email_search", {
        query: "Meeting",
      });

      const parsed = JSON.parse(result);
      expect(parsed.count).toBe(1);
      expect(parsed.results[0].subject).toBe("Meeting tomorrow");
    });

    it("filters by sender", async () => {
      mockGetCachedEmails.mockResolvedValue([
        createTestEmailMeta(1, { from: "alice@example.com" }),
        createTestEmailMeta(2, { from: "bob@example.com" }),
      ]);

      const result = await skill.execute("email_search", {
        sender: "alice",
      });

      const parsed = JSON.parse(result);
      expect(parsed.count).toBe(1);
      expect(parsed.results[0].from).toBe("alice@example.com");
    });

    it("returns empty when no matches", async () => {
      mockGetCachedEmails.mockResolvedValue([]);

      const result = await skill.execute("email_search", {
        query: "nonexistent",
      });

      const parsed = JSON.parse(result);
      expect(parsed.results).toEqual([]);
    });
  });

  describe("email_flag", () => {
    it("adds a flag to an email", async () => {
      const result = await skill.execute("email_flag", {
        uid: 1,
        flag: "\\Flagged",
      });

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.message).toContain("Added");
      expect(mockImapFlagsAdd).toHaveBeenCalled();
    });

    it("removes a flag from an email", async () => {
      const result = await skill.execute("email_flag", {
        uid: 1,
        flag: "\\Seen",
        remove: true,
      });

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.message).toContain("Removed");
      expect(mockImapFlagsRemove).toHaveBeenCalled();
    });

    it("handles IMAP errors gracefully", async () => {
      mockImapConnect.mockRejectedValue(new Error("Connection refused"));

      const result = await skill.execute("email_flag", {
        uid: 1,
        flag: "\\Flagged",
      });

      const parsed = JSON.parse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.message).toContain("Connection refused");
    });
  });

  it("returns unknown tool message for invalid tool", async () => {
    const result = await skill.execute("email_invalid", {});
    expect(result).toContain("Unknown tool");
  });
});
