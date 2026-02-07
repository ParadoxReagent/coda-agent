import type {
  LLMProvider,
  LLMChatParams,
  LLMResponse,
  ProviderCapabilities,
} from "../../src/core/llm/provider.js";
import type { Skill, SkillToolDefinition } from "../../src/skills/base.js";
import type { SkillContext } from "../../src/skills/context.js";
import type { EventBus, CodaEvent } from "../../src/core/events.js";
import type { Logger } from "../../src/utils/logger.js";
import { vi } from "vitest";

// ---- Mock Logger ----
export function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
    level: "silent",
  } as unknown as Logger;
}

// ---- Mock Providers ----
export interface MockProviderOptions {
  name?: string;
  responses?: LLMResponse[];
  capabilities?: Partial<ProviderCapabilities>;
}

export function createMockProvider(
  options: MockProviderOptions = {}
): LLMProvider & { chatMock: ReturnType<typeof vi.fn> } {
  const responseQueue = [...(options.responses ?? [])];

  const defaultResponse: LLMResponse = {
    text: "Mock response",
    toolCalls: [],
    stopReason: "end_turn",
    usage: { inputTokens: 100, outputTokens: 50 },
    model: "mock-model",
    provider: options.name ?? "mock",
  };

  const chatMock = vi.fn(async (_params: LLMChatParams): Promise<LLMResponse> => {
    return responseQueue.shift() ?? defaultResponse;
  });

  return {
    name: options.name ?? "mock",
    capabilities: {
      tools: true,
      parallelToolCalls: true,
      usageMetrics: true,
      jsonMode: true,
      streaming: true,
      ...options.capabilities,
    },
    chat: chatMock,
    chatMock,
  };
}

export function createMockAnthropicProvider(
  responses?: LLMResponse[]
): ReturnType<typeof createMockProvider> {
  return createMockProvider({
    name: "anthropic",
    responses,
    capabilities: {
      tools: true,
      parallelToolCalls: true,
      usageMetrics: true,
    },
  });
}

export function createMockGoogleProvider(
  responses?: LLMResponse[]
): ReturnType<typeof createMockProvider> {
  return createMockProvider({
    name: "google",
    responses,
    capabilities: {
      tools: true,
      parallelToolCalls: false,
      usageMetrics: true,
    },
  });
}

export function createMockOpenAIProvider(
  responses?: LLMResponse[]
): ReturnType<typeof createMockProvider> {
  return createMockProvider({
    name: "openai",
    responses,
    capabilities: {
      tools: true,
      parallelToolCalls: true,
      usageMetrics: true,
    },
  });
}

// ---- Mock Skill ----
export interface MockSkillOptions {
  name?: string;
  description?: string;
  tools?: SkillToolDefinition[];
  executeResult?: string;
  executeFn?: (
    toolName: string,
    toolInput: Record<string, unknown>
  ) => Promise<string>;
  requiredConfig?: string[];
}

export function createMockSkill(options: MockSkillOptions = {}): Skill {
  const tools: SkillToolDefinition[] = options.tools ?? [
    {
      name: `${options.name ?? "mock"}_action`,
      description: "A mock action",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "A query" },
        },
      },
    },
  ];

  return {
    name: options.name ?? "mock",
    description: options.description ?? "A mock skill",
    getTools: () => tools,
    execute:
      options.executeFn ??
      vi.fn(async () => options.executeResult ?? "Mock result"),
    getRequiredConfig: () => options.requiredConfig ?? [],
    startup: vi.fn(async (_ctx: SkillContext) => {}),
    shutdown: vi.fn(async () => {}),
  };
}

// ---- Mock Event Bus ----
export function createMockEventBus(): EventBus & {
  publishedEvents: CodaEvent[];
  handlers: Map<string, ((event: CodaEvent) => Promise<void>)[]>;
} {
  const publishedEvents: CodaEvent[] = [];
  const handlers = new Map<
    string,
    ((event: CodaEvent) => Promise<void>)[]
  >();

  return {
    publishedEvents,
    handlers,
    async publish(event: CodaEvent) {
      publishedEvents.push(event);
      // Dispatch to matching subscribers
      for (const [pattern, fns] of handlers) {
        const regex = new RegExp(
          `^${pattern.replace(/\./g, "\\.").replace(/\*/g, ".*")}$`
        );
        if (regex.test(event.eventType)) {
          for (const fn of fns) {
            await fn(event);
          }
        }
      }
    },
    subscribe(
      pattern: string,
      handler: (event: CodaEvent) => Promise<void>
    ) {
      const existing = handlers.get(pattern) ?? [];
      existing.push(handler);
      handlers.set(pattern, existing);
    },
  };
}

// ---- Mock Skill Context ----
export function createMockSkillContext(
  skillName?: string
): SkillContext {
  const store = new Map<string, string>();

  return {
    config: {},
    logger: createMockLogger(),
    redis: {
      async get(key: string) {
        return store.get(`skill:${skillName ?? "mock"}:${key}`) ?? null;
      },
      async set(key: string, value: string) {
        store.set(`skill:${skillName ?? "mock"}:${key}`, value);
      },
      async del(key: string) {
        store.delete(`skill:${skillName ?? "mock"}:${key}`);
      },
    },
    eventBus: createMockEventBus(),
    db: createMockDatabase() as unknown as SkillContext["db"],
  };
}

// ---- Mock IMAP Client ----
export interface MockIMAPMessage {
  uid: number;
  envelope: {
    from?: Array<{ name?: string; address?: string }>;
    to?: Array<{ address?: string }>;
    cc?: Array<{ address?: string }>;
    subject?: string;
    date?: Date;
    messageId?: string;
  };
  flags: Set<string>;
}

export function createMockIMAPClient(messages: MockIMAPMessage[] = []) {
  const releaseFn = vi.fn();

  return {
    connect: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
    getMailboxLock: vi.fn().mockResolvedValue({ release: releaseFn }),
    messageFlagsAdd: vi.fn().mockResolvedValue(undefined),
    messageFlagsRemove: vi.fn().mockResolvedValue(undefined),
    fetch: vi.fn().mockReturnValue({
      [Symbol.asyncIterator]() {
        let i = 0;
        return {
          next() {
            if (i < messages.length) {
              return Promise.resolve({
                value: messages[i++],
                done: false,
              });
            }
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    }),
    _release: releaseFn,
  };
}

// ---- Mock CalDAV Client ----
export interface MockCalendarEvent {
  id: string;
  title: string;
  startTime: Date;
  endTime: Date;
  location?: string;
  description?: string;
  attendees: string[];
  allDay: boolean;
}

export function createMockCalDAVClient(events: MockCalendarEvent[] = []) {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    getEvents: vi.fn().mockResolvedValue(events),
    createEvent: vi.fn().mockResolvedValue(crypto.randomUUID()),
    searchEvents: vi.fn().mockImplementation(
      (query: string) =>
        events.filter(
          (e) =>
            e.title.toLowerCase().includes(query.toLowerCase()) ||
            e.description?.toLowerCase().includes(query.toLowerCase())
        )
    ),
  };
}

// ---- Mock Database (chainable query builder) ----
export function createMockDatabase() {
  const results: unknown[] = [];
  let pendingResults: unknown[] = [];

  const chain = {
    _setResults(data: unknown[]) {
      pendingResults = data;
    },
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockImplementation(() => ({
      orderBy: vi.fn().mockImplementation(() => ({
        limit: vi.fn().mockImplementation(() => Promise.resolve(pendingResults)),
      })),
      limit: vi.fn().mockImplementation(() => Promise.resolve(pendingResults)),
      returning: vi.fn().mockImplementation(() => Promise.resolve(pendingResults)),
    })),
    orderBy: vi.fn().mockImplementation(() => ({
      limit: vi.fn().mockImplementation(() => Promise.resolve(pendingResults)),
    })),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockImplementation(() => Promise.resolve(pendingResults)),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockImplementation(() => Promise.resolve(pendingResults)),
        }),
      }),
    }),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockImplementation(() => Promise.resolve(pendingResults)),
      }),
    }),
  };

  return chain;
}
