import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EmailPoller } from "../../src/integrations/email/poller.js";
import {
  createMockEventBus,
  createMockLogger,
  createMockSkillContext,
} from "../helpers/mocks.js";
import type { SkillRedisClient } from "../../src/skills/context.js";

// Mock ImapFlow
const mockFetch = vi.fn();
const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockLogout = vi.fn().mockResolvedValue(undefined);
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

function createAsyncIterable(messages: unknown[]) {
  return {
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
  };
}

describe("Email Alerts Integration", () => {
  let poller: EmailPoller;
  let redis: SkillRedisClient;
  let eventBus: ReturnType<typeof createMockEventBus>;
  let logger: ReturnType<typeof createMockLogger>;

  const pollerConfig = {
    host: "imap.example.com",
    port: 993,
    user: "user@example.com",
    pass: "pass",
    tls: true,
    folders: ["INBOX"],
    pollIntervalSeconds: 300,
    categorizationRules: {
      urgentSenders: ["ceo@company.com"],
      urgentKeywords: ["URGENT", "ACTION REQUIRED"],
      knownContacts: ["colleague@company.com"],
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    const ctx = createMockSkillContext("email");
    redis = ctx.redis;
    eventBus = createMockEventBus();
    logger = createMockLogger();

    mockGetMailboxLock.mockResolvedValue({ release: mockRelease });

    poller = new EmailPoller(pollerConfig, redis, eventBus, logger);
  });

  afterEach(() => {
    poller.stop();
  });

  it("publishes alert.email.urgent for emails from urgent senders", async () => {
    mockFetch.mockReturnValue(
      createAsyncIterable([
        {
          uid: 1,
          envelope: {
            from: [{ name: "CEO", address: "ceo@company.com" }],
            to: [{ address: "me@example.com" }],
            cc: [],
            subject: "Board meeting",
            date: new Date("2025-01-15T10:00:00Z"),
            messageId: "<msg-1@company.com>",
          },
          flags: new Set(),
        },
      ])
    );

    await poller.poll();

    const urgentEvents = eventBus.publishedEvents.filter(
      (e) => e.eventType === "alert.email.urgent"
    );
    expect(urgentEvents).toHaveLength(1);
    expect(urgentEvents[0]!.severity).toBe("high");
    expect(urgentEvents[0]!.payload.from).toContain("ceo@company.com");
    expect(urgentEvents[0]!.payload.subject).toBe("Board meeting");
  });

  it("publishes alert for emails with urgent keywords", async () => {
    mockFetch.mockReturnValue(
      createAsyncIterable([
        {
          uid: 2,
          envelope: {
            from: [{ name: "System", address: "alerts@monitoring.com" }],
            to: [{ address: "me@example.com" }],
            cc: [],
            subject: "URGENT: Server down in production",
            date: new Date("2025-01-15T10:00:00Z"),
            messageId: "<msg-2@monitoring.com>",
          },
          flags: new Set(),
        },
      ])
    );

    await poller.poll();

    const urgentEvents = eventBus.publishedEvents.filter(
      (e) => e.eventType === "alert.email.urgent"
    );
    expect(urgentEvents).toHaveLength(1);
    expect(urgentEvents[0]!.payload.subject).toContain("URGENT");
  });

  it("does NOT publish alert for non-urgent emails", async () => {
    mockFetch.mockReturnValue(
      createAsyncIterable([
        {
          uid: 3,
          envelope: {
            from: [{ name: "Newsletter", address: "newsletter@news.com" }],
            to: [{ address: "me@example.com" }],
            cc: [],
            subject: "Weekly digest",
            date: new Date("2025-01-15T10:00:00Z"),
            messageId: "<msg-3@news.com>",
          },
          flags: new Set(),
        },
      ])
    );

    await poller.poll();

    const urgentEvents = eventBus.publishedEvents.filter(
      (e) => e.eventType === "alert.email.urgent"
    );
    expect(urgentEvents).toHaveLength(0);
  });

  it("payload contains only safe fields (no full body)", async () => {
    mockFetch.mockReturnValue(
      createAsyncIterable([
        {
          uid: 4,
          envelope: {
            from: [{ name: "CEO", address: "ceo@company.com" }],
            to: [{ address: "me@example.com" }],
            cc: [],
            subject: "Sensitive topic",
            date: new Date("2025-01-15T10:00:00Z"),
            messageId: "<msg-4@company.com>",
          },
          flags: new Set(),
        },
      ])
    );

    await poller.poll();

    const event = eventBus.publishedEvents[0]!;
    // Only uid, from, and subject — no body/snippet in the alert payload
    expect(event.payload).toHaveProperty("uid");
    expect(event.payload).toHaveProperty("from");
    expect(event.payload).toHaveProperty("subject");
    expect(event.payload).not.toHaveProperty("body");
    expect(event.payload).not.toHaveProperty("emailBody");
  });

  it("handles multiple emails in single poll (mixed urgency)", async () => {
    mockFetch.mockReturnValue(
      createAsyncIterable([
        {
          uid: 5,
          envelope: {
            from: [{ name: "CEO", address: "ceo@company.com" }],
            to: [{ address: "me@example.com" }],
            cc: [],
            subject: "Important update",
            date: new Date("2025-01-15T10:00:00Z"),
            messageId: "<msg-5@company.com>",
          },
          flags: new Set(),
        },
        {
          uid: 6,
          envelope: {
            from: [{ name: "Random", address: "random@example.com" }],
            to: [{ address: "me@example.com" }],
            cc: [],
            subject: "Hello",
            date: new Date("2025-01-15T10:01:00Z"),
            messageId: "<msg-6@example.com>",
          },
          flags: new Set(),
        },
        {
          uid: 7,
          envelope: {
            from: [{ name: "Ops", address: "ops@monitoring.com" }],
            to: [{ address: "me@example.com" }],
            cc: [],
            subject: "ACTION REQUIRED: Deploy approval",
            date: new Date("2025-01-15T10:02:00Z"),
            messageId: "<msg-7@monitoring.com>",
          },
          flags: new Set(),
        },
      ])
    );

    await poller.poll();

    const urgentEvents = eventBus.publishedEvents.filter(
      (e) => e.eventType === "alert.email.urgent"
    );
    // CEO email (urgent sender) + ACTION REQUIRED email (urgent keyword)
    expect(urgentEvents).toHaveLength(2);
  });
});
