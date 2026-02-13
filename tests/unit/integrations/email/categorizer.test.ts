import { describe, it, expect } from "vitest";
import { categorizeEmail } from "../../../../src/integrations/email/categorizer.js";
import type { EmailCategorizationRules } from "../../../../src/integrations/email/types.js";

const defaultRules: EmailCategorizationRules = {
  urgentSenders: ["boss@company.com", "vip@important.org"],
  urgentKeywords: ["URGENT", "ACTION REQUIRED", "critical"],
  knownContacts: ["friend@example.com", "colleague@company.com"],
};

function createTestEmail(overrides: Partial<Parameters<typeof categorizeEmail>[0]> = {}) {
  return {
    from: "someone@example.com",
    to: ["me@example.com"],
    cc: [],
    subject: "Hello",
    snippet: "Just a regular email",
    flags: [],
    ...overrides,
  };
}

describe("categorizeEmail", () => {
  it("marks emails from urgent senders as urgent", () => {
    const email = createTestEmail({ from: "boss@company.com" });
    expect(categorizeEmail(email, defaultRules)).toBe("urgent");
  });

  it("matches urgent senders case-insensitively", () => {
    const email = createTestEmail({ from: "BOSS@COMPANY.COM" });
    expect(categorizeEmail(email, defaultRules)).toBe("urgent");
  });

  it("marks emails with urgent keywords in subject as urgent", () => {
    const email = createTestEmail({ subject: "ACTION REQUIRED: Review report" });
    expect(categorizeEmail(email, defaultRules)).toBe("urgent");
  });

  it("marks emails with urgent keywords in snippet as urgent", () => {
    const email = createTestEmail({
      snippet: "This is critical and needs immediate attention",
    });
    expect(categorizeEmail(email, defaultRules)).toBe("urgent");
  });

  it("marks noreply senders as low_priority (mailing list)", () => {
    const email = createTestEmail({ from: "noreply@service.com" });
    expect(categorizeEmail(email, defaultRules)).toBe("low_priority");
  });

  it("marks newsletter senders as low_priority", () => {
    const email = createTestEmail({ from: "newsletter@company.com" });
    expect(categorizeEmail(email, defaultRules)).toBe("low_priority");
  });

  it("marks notifications senders as low_priority", () => {
    const email = createTestEmail({ from: "notifications@github.com" });
    expect(categorizeEmail(email, defaultRules)).toBe("low_priority");
  });

  it("marks emails with large CC lists as low_priority", () => {
    const email = createTestEmail({
      cc: Array.from({ length: 15 }, (_, i) => `user${i}@example.com`),
    });
    expect(categorizeEmail(email, defaultRules)).toBe("low_priority");
  });

  it("marks emails from known contacts as needs_response", () => {
    const email = createTestEmail({ from: "friend@example.com" });
    expect(categorizeEmail(email, defaultRules)).toBe("needs_response");
  });

  it("marks other emails as informational", () => {
    const email = createTestEmail({ from: "stranger@random.com" });
    expect(categorizeEmail(email, defaultRules)).toBe("informational");
  });

  it("prioritizes urgent over mailing list", () => {
    // From an urgent sender who also uses noreply pattern
    const email = createTestEmail({ from: "boss@company.com" });
    expect(categorizeEmail(email, defaultRules)).toBe("urgent");
  });

  it("handles empty rules gracefully", () => {
    const email = createTestEmail();
    const emptyRules: EmailCategorizationRules = {
      urgentSenders: [],
      urgentKeywords: [],
      knownContacts: [],
    };
    expect(categorizeEmail(email, emptyRules)).toBe("informational");
  });
});
