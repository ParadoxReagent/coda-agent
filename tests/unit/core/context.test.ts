import { describe, it, expect } from "vitest";
import { ContextStore } from "../../../src/core/context.js";
import { createMockLogger } from "../../helpers/mocks.js";

describe("ContextStore", () => {
  it("getHistory returns empty array for new user", async () => {
    const store = new ContextStore(createMockLogger());
    const history = await store.getHistory("new-user");
    expect(history).toEqual([]);
  });

  it("save stores message and getHistory retrieves it", async () => {
    const store = new ContextStore(createMockLogger());
    await store.save("user1", "discord", "Hello", { text: "Hi there!" });

    const history = await store.getHistory("user1", "discord");
    expect(history).toHaveLength(2);
    expect(history[0]).toEqual({ role: "user", content: "Hello" });
    expect(history[1]).toEqual({ role: "assistant", content: "Hi there!" });
  });

  it("history is scoped per user", async () => {
    const store = new ContextStore(createMockLogger());
    await store.save("user1", "discord", "Hello from user1", { text: "Reply 1" });
    await store.save("user2", "discord", "Hello from user2", { text: "Reply 2" });

    const h1 = await store.getHistory("user1", "discord");
    const h2 = await store.getHistory("user2", "discord");

    expect(h1).toHaveLength(2);
    expect(h2).toHaveLength(2);
    expect(h1[0]!.content).toBe("Hello from user1");
    expect(h2[0]!.content).toBe("Hello from user2");
  });

  it("history is scoped per channel", async () => {
    const store = new ContextStore(createMockLogger());
    await store.save("user1", "discord", "Discord msg", { text: "D reply" });
    await store.save("user1", "slack", "Slack msg", { text: "S reply" });

    const discordHistory = await store.getHistory("user1", "discord");
    const slackHistory = await store.getHistory("user1", "slack");

    expect(discordHistory).toHaveLength(2);
    expect(slackHistory).toHaveLength(2);
    expect(discordHistory[0]!.content).toBe("Discord msg");
    expect(slackHistory[0]!.content).toBe("Slack msg");
  });

  it("history respects max message limit (50)", async () => {
    const store = new ContextStore(createMockLogger());
    for (let i = 0; i < 30; i++) {
      await store.save("user1", "discord", `msg ${i}`, { text: `reply ${i}` });
    }
    // 30 saves × 2 messages each = 60, trimmed to 50
    const history = await store.getHistory("user1", "discord");
    expect(history.length).toBeLessThanOrEqual(50);
  });

  it("saveFact persists and getFacts retrieves", async () => {
    const store = new ContextStore(createMockLogger());
    await store.saveFact("user1", "favorite_color", "blue");

    const facts = await store.getFacts("user1");
    expect(facts).toHaveLength(1);
    expect(facts[0]!.key).toBe("favorite_color");
    expect(facts[0]!.value).toBe("blue");
  });

  it("facts are scoped per user", async () => {
    const store = new ContextStore(createMockLogger());
    await store.saveFact("user1", "color", "blue");
    await store.saveFact("user2", "color", "red");

    const f1 = await store.getFacts("user1");
    const f2 = await store.getFacts("user2");

    expect(f1[0]!.value).toBe("blue");
    expect(f2[0]!.value).toBe("red");
  });

  it("saveFact updates existing fact with same key", async () => {
    const store = new ContextStore(createMockLogger());
    await store.saveFact("user1", "color", "blue");
    await store.saveFact("user1", "color", "green");

    const facts = await store.getFacts("user1");
    expect(facts).toHaveLength(1);
    expect(facts[0]!.value).toBe("green");
  });
});
