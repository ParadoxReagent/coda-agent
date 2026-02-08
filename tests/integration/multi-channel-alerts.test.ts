import { describe, it, expect, vi, beforeEach } from "vitest";
import { AlertRouter, type AlertSink } from "../../src/core/alerts.js";
import { createMockLogger, createMockEventBus } from "../helpers/mocks.js";

describe("Multi-Channel Alert Delivery", () => {
  let router: AlertRouter;
  let discordSink: AlertSink & { sentMessages: unknown[] };
  let slackSink: AlertSink & { sentMessages: unknown[] };
  let eventBus: ReturnType<typeof createMockEventBus>;

  beforeEach(() => {
    discordSink = {
      sentMessages: [],
      send: vi.fn(async (_channel, message) => {
        discordSink.sentMessages.push({ type: "text", message });
      }),
      sendRich: vi.fn(async (_channel, formatted) => {
        discordSink.sentMessages.push({ type: "rich", formatted });
      }),
    };

    slackSink = {
      sentMessages: [],
      send: vi.fn(async (_channel, message) => {
        slackSink.sentMessages.push({ type: "text", message });
      }),
      sendRich: vi.fn(async (_channel, formatted) => {
        slackSink.sentMessages.push({ type: "rich", formatted });
      }),
    };

    router = new AlertRouter(createMockLogger(), null, null, {
      rules: {
        "alert.test.both": {
          severity: "high",
          channels: ["discord", "slack"],
          quietHours: false,
          cooldown: 0,
        },
        "alert.test.discord_only": {
          severity: "medium",
          channels: ["discord"],
          quietHours: false,
          cooldown: 0,
        },
        "alert.test.slack_only": {
          severity: "low",
          channels: ["slack"],
          quietHours: false,
          cooldown: 0,
        },
      },
    });

    router.registerSink("discord", discordSink);
    router.registerSink("slack", slackSink);

    eventBus = createMockEventBus();
    router.attachToEventBus(eventBus);
  });

  it("delivers to both Discord and Slack", async () => {
    await eventBus.publish({
      eventType: "alert.test.both",
      timestamp: new Date().toISOString(),
      sourceSkill: "test",
      payload: { message: "Alert for both channels" },
      severity: "high",
    });

    expect(discordSink.sentMessages.length).toBe(1);
    expect(slackSink.sentMessages.length).toBe(1);
  });

  it("delivers Discord-only events only to Discord", async () => {
    await eventBus.publish({
      eventType: "alert.test.discord_only",
      timestamp: new Date().toISOString(),
      sourceSkill: "test",
      payload: { message: "Discord only" },
      severity: "medium",
    });

    expect(discordSink.sentMessages.length).toBe(1);
    expect(slackSink.sentMessages.length).toBe(0);
  });

  it("delivers Slack-only events only to Slack", async () => {
    await eventBus.publish({
      eventType: "alert.test.slack_only",
      timestamp: new Date().toISOString(),
      sourceSkill: "test",
      payload: { message: "Slack only" },
      severity: "low",
    });

    expect(discordSink.sentMessages.length).toBe(0);
    expect(slackSink.sentMessages.length).toBe(1);
  });

  it("Discord uses rich embed format", async () => {
    await eventBus.publish({
      eventType: "alert.test.discord_only",
      timestamp: new Date().toISOString(),
      sourceSkill: "test",
      payload: { message: "Rich alert" },
      severity: "medium",
    });

    expect(discordSink.sendRich).toHaveBeenCalled();
    const formatted = discordSink.sentMessages[0] as { type: string; formatted: unknown };
    expect(formatted.type).toBe("rich");
    const richContent = formatted.formatted as { embeds: unknown[] };
    expect(richContent.embeds).toBeDefined();
    expect(richContent.embeds.length).toBeGreaterThan(0);
  });

  it("Slack uses Block Kit format", async () => {
    await eventBus.publish({
      eventType: "alert.test.slack_only",
      timestamp: new Date().toISOString(),
      sourceSkill: "test",
      payload: { message: "Block Kit alert" },
      severity: "low",
    });

    expect(slackSink.sendRich).toHaveBeenCalled();
    const formatted = slackSink.sentMessages[0] as { type: string; formatted: unknown };
    expect(formatted.type).toBe("rich");
    const richContent = formatted.formatted as { blocks: unknown[] };
    expect(richContent.blocks).toBeDefined();
    expect(richContent.blocks.length).toBeGreaterThan(0);
  });
});
