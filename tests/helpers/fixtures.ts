import type { LLMResponse, LLMToolCall } from "../../src/core/llm/provider.js";
import type { EmailMetadata } from "../../src/skills/email/types.js";
import type { MockCalendarEvent } from "./mocks.js";

export const TEST_USER_ID = "test-user-123";
export const TEST_CHANNEL = "discord";

export function createTextResponse(
  text: string,
  provider: string = "mock"
): LLMResponse {
  return {
    text,
    toolCalls: [],
    stopReason: "end_turn",
    usage: { inputTokens: 100, outputTokens: 50 },
    model: "mock-model",
    provider,
  };
}

export function createToolUseResponse(
  toolCalls: LLMToolCall[],
  provider: string = "mock",
  text: string | null = null
): LLMResponse {
  return {
    text,
    toolCalls,
    stopReason: "tool_use",
    usage: { inputTokens: 150, outputTokens: 75 },
    model: "mock-model",
    provider,
  };
}

export function createToolCall(
  name: string,
  input: Record<string, unknown> = {},
  id?: string
): LLMToolCall {
  return {
    id: id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
    name,
    input,
  };
}

export function createNullUsageResponse(
  text: string,
  provider: string = "ollama"
): LLMResponse {
  return {
    text,
    toolCalls: [],
    stopReason: "end_turn",
    usage: { inputTokens: null, outputTokens: null },
    model: "llama3.1:8b",
    provider,
  };
}

// ---- Phase 2 Fixture Factories ----

export function createTestEmails(count: number): EmailMetadata[] {
  return Array.from({ length: count }, (_, i) => ({
    uid: i + 1,
    messageId: `<msg-${i + 1}@example.com>`,
    from: `sender${i + 1}@example.com`,
    to: ["me@example.com"],
    cc: [],
    subject: `Test Email ${i + 1}`,
    date: new Date(Date.now() - i * 3600_000).toISOString(),
    snippet: `This is test email ${i + 1}`,
    flags: [],
    folder: "INBOX",
    category: i === 0 ? "urgent" as const : "informational" as const,
  }));
}

export function createTestEvents(count: number): MockCalendarEvent[] {
  const baseDate = new Date("2025-01-15T09:00:00Z");
  return Array.from({ length: count }, (_, i) => ({
    id: `event-${i + 1}`,
    title: `Meeting ${i + 1}`,
    startTime: new Date(baseDate.getTime() + i * 3600_000),
    endTime: new Date(baseDate.getTime() + (i + 1) * 3600_000),
    location: i % 2 === 0 ? `Room ${i + 1}` : undefined,
    description: `Description for meeting ${i + 1}`,
    attendees: [`attendee${i + 1}@example.com`],
    allDay: false,
  }));
}

export function createTestReminders(count: number) {
  const baseDate = new Date("2025-01-15T10:00:00Z");
  return Array.from({ length: count }, (_, i) => ({
    id: `rem-${i + 1}`,
    userId: "default",
    title: `Reminder ${i + 1}`,
    description: i % 2 === 0 ? `Details for reminder ${i + 1}` : null,
    dueAt: new Date(baseDate.getTime() + i * 3600_000),
    recurring: null,
    status: "pending" as const,
    channel: null,
    snoozedUntil: null,
    createdAt: new Date(baseDate.getTime() - 86400_000),
    completedAt: null,
  }));
}

export function createTestNotes(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `note-${i + 1}`,
    userId: "default",
    title: `Note ${i + 1}`,
    content: `Content for note ${i + 1}`,
    tags: i === 0 ? ["context:always"] : [`tag-${i}`],
    searchVector: null,
    createdAt: new Date(Date.now() - i * 3600_000),
    updatedAt: new Date(Date.now() - i * 3600_000),
  }));
}
