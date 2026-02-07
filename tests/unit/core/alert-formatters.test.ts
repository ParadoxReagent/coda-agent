import { describe, it, expect } from "vitest";
import {
  formatAlertForDiscord,
  formatAlertForSlack,
  formatAlertPlainText,
  formatUnifiNewClient,
  formatUnifiBandwidthSpike,
  formatUnifiDeviceOffline,
  formatEmailUrgent,
  formatReminderDue,
} from "../../../src/core/alert-formatters.js";
import type { CodaEvent } from "../../../src/core/events.js";

function createEvent(overrides: Partial<CodaEvent> = {}): CodaEvent {
  return {
    eventType: "alert.test.event",
    timestamp: new Date().toISOString(),
    sourceSkill: "test",
    payload: {},
    severity: "medium",
    ...overrides,
  };
}

describe("formatAlertForDiscord", () => {
  it("returns object with embeds array", () => {
    const result = formatAlertForDiscord(createEvent());
    expect(result.embeds).toBeInstanceOf(Array);
    expect(result.embeds).toHaveLength(1);
  });

  it("uses red color (0xFF0000) for high severity", () => {
    const result = formatAlertForDiscord(createEvent({ severity: "high" }));
    const embed = result.embeds[0] as Record<string, unknown>;
    expect(embed.color).toBe(0xff0000);
  });

  it("uses orange color (0xFF8C00) for medium severity", () => {
    const result = formatAlertForDiscord(createEvent({ severity: "medium" }));
    const embed = result.embeds[0] as Record<string, unknown>;
    expect(embed.color).toBe(0xff8c00);
  });

  it("uses blue color (0x3498DB) for low severity", () => {
    const result = formatAlertForDiscord(createEvent({ severity: "low" }));
    const embed = result.embeds[0] as Record<string, unknown>;
    expect(embed.color).toBe(0x3498db);
  });

  it("includes timestamp", () => {
    const ts = "2025-01-15T10:00:00.000Z";
    const result = formatAlertForDiscord(createEvent({ timestamp: ts }));
    const embed = result.embeds[0] as Record<string, unknown>;
    expect(embed.timestamp).toBe(ts);
  });

  it("includes source skill in footer", () => {
    const result = formatAlertForDiscord(
      createEvent({ sourceSkill: "email" })
    );
    const embed = result.embeds[0] as Record<string, unknown>;
    const footer = embed.footer as Record<string, string>;
    expect(footer.text).toContain("email");
  });

  it("includes payload fields in embed fields", () => {
    const result = formatAlertForDiscord(
      createEvent({
        payload: { from: "test@example.com", subject: "Test" },
      })
    );
    const embed = result.embeds[0] as Record<string, unknown>;
    const fields = embed.fields as Array<Record<string, unknown>>;
    const fieldNames = fields.map((f) => f.name);
    expect(fieldNames).toContain("from");
    expect(fieldNames).toContain("subject");
  });
});

describe("formatAlertForSlack", () => {
  it("returns Block Kit structure with blocks array", () => {
    const result = formatAlertForSlack(createEvent());
    expect(result.blocks).toBeInstanceOf(Array);
    expect(result.blocks.length).toBeGreaterThan(0);
  });

  it("includes header block with severity icon", () => {
    const result = formatAlertForSlack(createEvent({ severity: "high" }));
    const header = result.blocks[0] as Record<string, unknown>;
    expect(header.type).toBe("header");
    const text = header.text as Record<string, string>;
    expect(text.text).toContain("[HIGH]");
  });

  it("includes context block with source and timestamp", () => {
    const result = formatAlertForSlack(
      createEvent({ sourceSkill: "unifi" })
    );
    const context = result.blocks.find(
      (b: unknown) => (b as Record<string, string>).type === "context"
    ) as Record<string, unknown>;
    expect(context).toBeDefined();
    const elements = context.elements as Array<Record<string, string>>;
    expect(elements[0]!.text).toContain("unifi");
  });
});

describe("formatAlertPlainText", () => {
  it("includes severity tag for high", () => {
    const result = formatAlertPlainText(createEvent({ severity: "high" }));
    expect(result).toContain("[HIGH]");
  });

  it("includes severity tag for medium", () => {
    const result = formatAlertPlainText(createEvent({ severity: "medium" }));
    expect(result).toContain("[MEDIUM]");
  });

  it("includes severity tag for low", () => {
    const result = formatAlertPlainText(createEvent({ severity: "low" }));
    expect(result).toContain("[LOW]");
  });

  it("includes source skill info", () => {
    const result = formatAlertPlainText(
      createEvent({ sourceSkill: "email" })
    );
    expect(result).toContain("Source: email");
  });

  it("handles missing payload gracefully", () => {
    const result = formatAlertPlainText(createEvent({ payload: {} }));
    expect(result).toBeDefined();
    expect(typeof result).toBe("string");
  });
});

describe("event-specific formatters", () => {
  describe("formatUnifiNewClient", () => {
    it("formats new client event", () => {
      const event = createEvent({
        payload: {
          hostname: "iPhone-15",
          mac: "AA:BB:CC:DD:EE:FF",
          ipAddress: "192.168.1.42",
        },
      });
      const result = formatUnifiNewClient(event);
      expect(result).toContain("iPhone-15");
      expect(result).toContain("AA:BB:CC:DD:EE:FF");
      expect(result).toContain("192.168.1.42");
    });

    it("handles missing fields", () => {
      const event = createEvent({ payload: {} });
      const result = formatUnifiNewClient(event);
      expect(result).toContain("Unknown");
    });
  });

  describe("formatUnifiBandwidthSpike", () => {
    it("formats bandwidth spike event", () => {
      const event = createEvent({
        payload: {
          hostname: "NAS",
          currentMbps: 500,
          baselineMbps: 50,
        },
      });
      const result = formatUnifiBandwidthSpike(event);
      expect(result).toContain("NAS");
      expect(result).toContain("500");
      expect(result).toContain("50");
    });
  });

  describe("formatUnifiDeviceOffline", () => {
    it("formats device offline event", () => {
      const event = createEvent({
        payload: {
          hostname: "Printer",
          lastSeen: "2025-01-15T09:00:00Z",
        },
      });
      const result = formatUnifiDeviceOffline(event);
      expect(result).toContain("Printer");
      expect(result).toContain("2025-01-15T09:00:00Z");
    });
  });

  describe("formatEmailUrgent", () => {
    it("formats urgent email event", () => {
      const event = createEvent({
        payload: {
          from: "ceo@company.com",
          subject: "Board meeting update",
        },
      });
      const result = formatEmailUrgent(event);
      expect(result).toContain("ceo@company.com");
      expect(result).toContain("Board meeting update");
    });
  });

  describe("formatReminderDue", () => {
    it("formats reminder due event", () => {
      const event = createEvent({
        payload: {
          title: "Call dentist",
          dueAt: "2025-01-15T14:00:00Z",
        },
      });
      const result = formatReminderDue(event);
      expect(result).toContain("Call dentist");
      expect(result).toContain("2025-01-15T14:00:00Z");
    });
  });
});
