import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EmailPoller } from "../../../../src/skills/email/poller.js";
import {
  createMockSkillContext,
  createMockEventBus,
  createMockLogger,
} from "../../../helpers/mocks.js";
import type { SkillRedisClient } from "../../../../src/skills/context.js";

// Mock ImapFlow
const mockFetch = vi.fn();
const mockConnect = vi.fn();
const mockLogout = vi.fn();
const mockGetMailboxLock = vi.fn();
const mockRelease = vi.fn();

vi.mock("imapflow", () => ({
  ImapFlow: vi.fn().mockImplementation(() => ({
    connect: mockConnect,
    logout: mockLogout,
    getMailboxLock: mockGetMailboxLock,
    fetch: mockFetch,
  })),
}));

const defaultConfig = {
  host: "imap.example.com",
  port: 993,
  user: "user@example.com",
  pass: "password",
  tls: true,
  folders: ["INBOX"],
  pollIntervalSeconds: 300,
  categorizationRules: {
    urgentSenders: ["boss@company.com"],
    urgentKeywords: ["URGENT"],
    knownContacts: ["friend@example.com"],
  },
};

function createMockMessage(uid: number, overrides: Record<string, unknown> = {}) {
  return {
    uid,
    envelope: {
      from: [{ name: "Sender", address: "sender@example.com" }],
      to: [{ address: "me@example.com" }],
      cc: [],
      subject: `Test Email ${uid}`,
      date: new Date("2025-01-15T10:00:00Z"),
      messageId: `<msg-${uid}@example.com>`,
      ...overrides,
    },
    flags: new Set(["\\Seen"]),
  };
}

describe("EmailPoller", () => {
  let poller: EmailPoller;
  let redis: SkillRedisClient;
  let eventBus: ReturnType<typeof createMockEventBus>;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    vi.clearAllMocks();

    const ctx = createMockSkillContext("email");
    redis = ctx.redis;
    eventBus = createMockEventBus();
    logger = createMockLogger();

    mockGetMailboxLock.mockResolvedValue({ release: mockRelease });
    mockConnect.mockResolvedValue(undefined);
    mockLogout.mockResolvedValue(undefined);

    poller = new EmailPoller(defaultConfig, redis, eventBus, logger);
  });

  afterEach(() => {
    poller.stop();
  });

  describe("poll", () => {
    it("fetches new messages and caches them", async () => {
      // Mock fetch returns an async iterable
      const messages = [createMockMessage(1), createMockMessage(2)];
      mockFetch.mockReturnValue({
        [Symbol.asyncIterator]() {
          let i = 0;
          return {
            next() {
              if (i < messages.length) {
                return Promise.resolve({ value: messages[i++], done: false });
              }
              return Promise.resolve({ value: undefined, done: true });
            },
          };
        },
      });

      await poller.poll();

      expect(mockConnect).toHaveBeenCalled();
      expect(mockGetMailboxLock).toHaveBeenCalledWith("INBOX");
      expect(mockRelease).toHaveBeenCalled();
      expect(mockLogout).toHaveBeenCalled();

      // Verify emails were cached
      const cached1 = await redis.get("email:INBOX:1");
      expect(cached1).not.toBeNull();
      const parsed = JSON.parse(cached1!);
      expect(parsed.subject).toBe("Test Email 1");
    });

    it("publishes alert for urgent emails", async () => {
      const urgentMsg = createMockMessage(1, {
        from: [{ name: "Boss", address: "boss@company.com" }],
        subject: "Important task",
      });

      mockFetch.mockReturnValue({
        [Symbol.asyncIterator]() {
          let done = false;
          return {
            next() {
              if (!done) {
                done = true;
                return Promise.resolve({ value: urgentMsg, done: false });
              }
              return Promise.resolve({ value: undefined, done: true });
            },
          };
        },
      });

      await poller.poll();

      expect(eventBus.publishedEvents).toHaveLength(1);
      expect(eventBus.publishedEvents[0]!.eventType).toBe(
        "alert.email.urgent"
      );
      expect(eventBus.publishedEvents[0]!.severity).toBe("high");
    });

    it("does not publish alert for non-urgent emails", async () => {
      const normalMsg = createMockMessage(1);

      mockFetch.mockReturnValue({
        [Symbol.asyncIterator]() {
          let done = false;
          return {
            next() {
              if (!done) {
                done = true;
                return Promise.resolve({ value: normalMsg, done: false });
              }
              return Promise.resolve({ value: undefined, done: true });
            },
          };
        },
      });

      await poller.poll();

      const urgentEvents = eventBus.publishedEvents.filter(
        (e) => e.eventType === "alert.email.urgent"
      );
      expect(urgentEvents).toHaveLength(0);
    });

    it("tracks lastUid to only fetch new messages", async () => {
      // Pre-set lastUid
      await redis.set("lastUid:INBOX", "5");

      const newMsg = createMockMessage(6);
      const oldMsg = createMockMessage(3); // Should be skipped

      mockFetch.mockReturnValue({
        [Symbol.asyncIterator]() {
          const msgs = [oldMsg, newMsg];
          let i = 0;
          return {
            next() {
              if (i < msgs.length) {
                return Promise.resolve({ value: msgs[i++], done: false });
              }
              return Promise.resolve({ value: undefined, done: true });
            },
          };
        },
      });

      await poller.poll();

      // Only msg uid=6 should be cached (uid=3 skipped since <= lastUid)
      const cached3 = await redis.get("email:INBOX:3");
      expect(cached3).toBeNull();
      const cached6 = await redis.get("email:INBOX:6");
      expect(cached6).not.toBeNull();

      // lastUid should be updated to 6
      const newLastUid = await redis.get("lastUid:INBOX");
      expect(newLastUid).toBe("6");
    });
  });

  describe("getCachedEmails", () => {
    it("returns cached emails within time range", async () => {
      const email = {
        uid: 1,
        from: "test@example.com",
        subject: "Test",
        date: new Date().toISOString(),
        category: "informational",
      };

      await redis.set("emailIndex:INBOX", JSON.stringify([1]));
      await redis.set("email:INBOX:1", JSON.stringify(email));

      const result = await poller.getCachedEmails("INBOX", 24);

      expect(result).toHaveLength(1);
      expect(result[0]!.subject).toBe("Test");
    });

    it("returns empty array when no index exists", async () => {
      const result = await poller.getCachedEmails("INBOX", 24);
      expect(result).toEqual([]);
    });

    it("filters out old emails", async () => {
      const oldDate = new Date(
        Date.now() - 48 * 3600_000
      ).toISOString();
      const email = {
        uid: 1,
        from: "test@example.com",
        subject: "Old",
        date: oldDate,
        category: "informational",
      };

      await redis.set("emailIndex:INBOX", JSON.stringify([1]));
      await redis.set("email:INBOX:1", JSON.stringify(email));

      const result = await poller.getCachedEmails("INBOX", 24);
      expect(result).toHaveLength(0);
    });
  });
});
