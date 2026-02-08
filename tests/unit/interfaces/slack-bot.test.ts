import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @slack/bolt before importing SlackBot
const mockSay = vi.fn();
const mockReactionsAdd = vi.fn().mockResolvedValue({ ok: true });
const mockChatPostMessage = vi.fn();
const mockAppStart = vi.fn().mockResolvedValue(undefined);
const mockAppStop = vi.fn().mockResolvedValue(undefined);

let messageHandler: (args: Record<string, unknown>) => Promise<void>;

vi.mock("@slack/bolt", () => ({
  App: vi.fn().mockImplementation(() => ({
    message: (handler: (args: Record<string, unknown>) => Promise<void>) => {
      messageHandler = handler;
    },
    start: mockAppStart,
    stop: mockAppStop,
    client: {
      reactions: { add: mockReactionsAdd },
      chat: { postMessage: mockChatPostMessage },
    },
  })),
}));

import { SlackBot } from "../../../src/interfaces/slack-bot.js";
import { createMockLogger } from "../../helpers/mocks.js";
import type { Orchestrator } from "../../../src/core/orchestrator.js";
import type { ProviderManager } from "../../../src/core/llm/manager.js";
import type { SkillRegistry } from "../../../src/skills/registry.js";

describe("SlackBot", () => {
  let bot: SlackBot;
  const mockOrchestrator = {
    handleMessage: vi.fn().mockResolvedValue("Bot response"),
  } as unknown as Orchestrator;
  const mockProviderManager = {} as unknown as ProviderManager;
  const mockSkills = {} as unknown as SkillRegistry;

  const config = {
    appToken: "xapp-test",
    botToken: "xoxb-test",
    channelId: "C123456",
    allowedUserIds: ["U001", "U002"],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    bot = new SlackBot(
      config,
      mockOrchestrator,
      mockProviderManager,
      mockSkills,
      createMockLogger()
    );
  });

  it("starts and stops the app", async () => {
    await bot.start();
    expect(mockAppStart).toHaveBeenCalled();

    await bot.stop();
    expect(mockAppStop).toHaveBeenCalled();
  });

  it("ignores messages from non-allowed users", async () => {
    await messageHandler({
      message: {
        user: "U999",
        text: "hello",
        channel: "C123456",
        ts: "123.456",
      },
      say: mockSay,
    });

    expect(mockOrchestrator.handleMessage).not.toHaveBeenCalled();
    expect(mockSay).not.toHaveBeenCalled();
  });

  it("ignores messages from wrong channel", async () => {
    await messageHandler({
      message: {
        user: "U001",
        text: "hello",
        channel: "C999999",
        ts: "123.456",
      },
      say: mockSay,
    });

    expect(mockOrchestrator.handleMessage).not.toHaveBeenCalled();
  });

  it("forwards allowed messages to orchestrator", async () => {
    await messageHandler({
      message: {
        user: "U001",
        text: "what is the weather?",
        channel: "C123456",
        ts: "123.456",
      },
      say: mockSay,
    });

    expect(mockOrchestrator.handleMessage).toHaveBeenCalledWith(
      "U001",
      "what is the weather?",
      "slack"
    );
    expect(mockSay).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Bot response",
        thread_ts: "123.456",
      })
    );
  });

  it("uses thread replies for multi-turn", async () => {
    await messageHandler({
      message: {
        user: "U001",
        text: "follow up",
        channel: "C123456",
        ts: "456.789",
        thread_ts: "123.456",
      },
      say: mockSay,
    });

    expect(mockSay).toHaveBeenCalledWith(
      expect.objectContaining({
        thread_ts: "123.456",
      })
    );
  });

  it("adds checkmark reaction on success", async () => {
    await messageHandler({
      message: {
        user: "U001",
        text: "do something",
        channel: "C123456",
        ts: "123.456",
      },
      say: mockSay,
    });

    expect(mockReactionsAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "white_check_mark",
        timestamp: "123.456",
      })
    );
  });

  it("sends notification as plain text", async () => {
    await bot.sendNotification("Test alert");
    expect(mockChatPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C123456",
        text: "Test alert",
      })
    );
  });

  it("sends notification with blocks", async () => {
    const blocks = {
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "test" } }],
    };
    await bot.sendNotification(blocks);
    expect(mockChatPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C123456",
        blocks: blocks.blocks,
      })
    );
  });

  it("ignores messages with subtypes (bot messages, etc)", async () => {
    await messageHandler({
      message: {
        user: "U001",
        text: "hello",
        channel: "C123456",
        ts: "123.456",
        subtype: "bot_message",
      },
      say: mockSay,
    });

    expect(mockOrchestrator.handleMessage).not.toHaveBeenCalled();
  });
});
