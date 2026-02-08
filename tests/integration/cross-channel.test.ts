import { describe, it, expect, vi, beforeEach } from "vitest";
import { ContextStore } from "../../src/core/context.js";
import { createMockLogger } from "../helpers/mocks.js";

describe("Cross-Channel Context Sharing", () => {
  let context: ContextStore;

  beforeEach(() => {
    context = new ContextStore(createMockLogger());
  });

  it("conversation started on Discord is accessible from Slack (no channel filter)", async () => {
    const userId = "user-123";

    // User sends message on Discord
    await context.save(userId, "discord", "What's my schedule?", {
      text: "You have 3 meetings today.",
    });

    // Get history without channel filter — should include all channels
    const allHistory = await context.getHistory(userId);
    expect(allHistory).toHaveLength(2); // user + assistant
    expect(allHistory[0]!.content).toBe("What's my schedule?");
    expect(allHistory[1]!.content).toBe("You have 3 meetings today.");
  });

  it("channel-filtered history only returns messages from that channel", async () => {
    const userId = "user-123";

    // Messages on Discord
    await context.save(userId, "discord", "Hello from Discord", {
      text: "Hi Discord user!",
    });

    // Messages on Slack
    await context.save(userId, "slack", "Hello from Slack", {
      text: "Hi Slack user!",
    });

    // Filter by Discord
    const discordHistory = await context.getHistory(userId, "discord");
    expect(discordHistory).toHaveLength(2);
    expect(discordHistory[0]!.content).toBe("Hello from Discord");

    // Filter by Slack
    const slackHistory = await context.getHistory(userId, "slack");
    expect(slackHistory).toHaveLength(2);
    expect(slackHistory[0]!.content).toBe("Hello from Slack");

    // Unfiltered returns all
    const allHistory = await context.getHistory(userId);
    expect(allHistory).toHaveLength(4);
  });

  it("context facts are shared across channels for the same user", async () => {
    const userId = "user-123";

    // Save a fact (facts are user-scoped, not channel-scoped)
    await context.saveFact(userId, "preferred_name", "Mike", "personal");

    // Facts should be accessible regardless of channel
    const facts = await context.getFacts(userId);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.key).toBe("preferred_name");
    expect(facts[0]!.value).toBe("Mike");
  });

  it("different users have independent context even on the same channel", async () => {
    const user1 = "user-1";
    const user2 = "user-2";

    await context.save(user1, "discord", "User 1 message", {
      text: "Response to user 1",
    });

    await context.save(user2, "discord", "User 2 message", {
      text: "Response to user 2",
    });

    const user1History = await context.getHistory(user1);
    expect(user1History).toHaveLength(2);
    expect(user1History[0]!.content).toBe("User 1 message");

    const user2History = await context.getHistory(user2);
    expect(user2History).toHaveLength(2);
    expect(user2History[0]!.content).toBe("User 2 message");
  });

  it("facts persist across multiple channel interactions", async () => {
    const userId = "user-123";

    // Set fact during Discord interaction
    await context.saveFact(userId, "timezone", "America/Chicago", "settings");

    // Later, during Slack interaction, update the fact
    await context.saveFact(userId, "timezone", "America/Los_Angeles", "settings");

    // Should have the updated value (not duplicated)
    const facts = await context.getFacts(userId);
    const timezoneFact = facts.find((f) => f.key === "timezone");
    expect(timezoneFact).toBeDefined();
    expect(timezoneFact!.value).toBe("America/Los_Angeles");

    // Should only have one timezone fact
    const timezoneCount = facts.filter((f) => f.key === "timezone").length;
    expect(timezoneCount).toBe(1);
  });
});
