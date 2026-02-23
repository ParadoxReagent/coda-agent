import { describe, it, expect, vi, beforeEach } from "vitest";
import { Orchestrator } from "../../src/core/orchestrator.js";
import { SkillRegistry } from "../../src/skills/registry.js";
import { ContextStore } from "../../src/core/context.js";
import { ConfirmationManager } from "../../src/core/confirmation.js";
import { NotesSkill } from "../../src/skills/notes/skill.js";
import {
  createMockProvider,
  createMockEventBus,
  createMockLogger,
  createMockSkillContext,
} from "../helpers/mocks.js";
import {
  createTextResponse,
  TEST_USER_ID,
  TEST_CHANNEL,
} from "../helpers/fixtures.js";
import type { ProviderManager } from "../../src/core/llm/manager.js";

// Mock database for the notes skill
const mockOrderBy = vi.fn();
const mockWhere = vi.fn();
const mockFrom = vi.fn();
const mockSelect = vi.fn();
const mockInsert = vi.fn();
const mockValues = vi.fn();
const mockReturning = vi.fn();

const mockDb = {
  select: mockSelect,
  insert: mockInsert,
  delete: vi.fn(),
};

vi.mock("../../src/db/connection.js", () => ({
  getDatabase: () => mockDb,
}));

function createMockProviderManager(
  provider: ReturnType<typeof createMockProvider>
) {
  return {
    getForUser: vi.fn().mockResolvedValue({
      provider,
      model: "mock-model",
    }),
    getForUserTiered: vi.fn().mockResolvedValue({
      provider,
      model: "mock-model",
      failedOver: false,
    }),
    isTierEnabled: vi.fn(() => false),
    trackUsage: vi.fn().mockResolvedValue(undefined),
  } as unknown as ProviderManager;
}

describe("Notes Context Integration", () => {
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    vi.clearAllMocks();
    logger = createMockLogger();
  });

  describe("context:always notes in system prompt", () => {
    it("includes context:always notes in the system prompt", async () => {
      // Setup DB mock to return context notes
      mockOrderBy.mockResolvedValue([
        { title: "My Preferences", content: "I prefer morning meetings before 10am" },
        { title: null, content: "Timezone is America/New_York" },
      ]);
      mockWhere.mockReturnValue({ orderBy: mockOrderBy });
      mockFrom.mockReturnValue({ where: mockWhere });
      mockSelect.mockReturnValue({ from: mockFrom });

      const provider = createMockProvider({
        responses: [createTextResponse("Hello! I'll keep your preferences in mind.")],
      });
      const providerManager = createMockProviderManager(provider);
      const eventBus = createMockEventBus();
      const context = new ContextStore(logger);
      const confirmation = new ConfirmationManager(logger);
      const registry = new SkillRegistry(logger);

      // Register a real NotesSkill
      const notesSkill = new NotesSkill();
      registry.register(notesSkill);

      const ctx = createMockSkillContext("notes");
      await notesSkill.startup(ctx);

      const orchestrator = new Orchestrator(
        providerManager,
        registry,
        context,
        eventBus,
        confirmation,
        logger
      );

      await orchestrator.handleMessage(TEST_USER_ID, "hello", TEST_CHANNEL);

      // Verify the system prompt includes the context notes
      const chatCall = provider.chatMock.mock.calls[0]![0];
      expect(chatCall.system).toContain("User notes (always visible)");
      expect(chatCall.system).toContain("My Preferences");
      expect(chatCall.system).toContain("morning meetings");
      expect(chatCall.system).toContain("Timezone is America/New_York");
    });

    it("system prompt works when no context notes exist", async () => {
      // Empty result
      mockOrderBy.mockResolvedValue([]);
      mockWhere.mockReturnValue({ orderBy: mockOrderBy });
      mockFrom.mockReturnValue({ where: mockWhere });
      mockSelect.mockReturnValue({ from: mockFrom });

      const provider = createMockProvider({
        responses: [createTextResponse("Hello!")],
      });
      const providerManager = createMockProviderManager(provider);
      const eventBus = createMockEventBus();
      const context = new ContextStore(logger);
      const confirmation = new ConfirmationManager(logger);
      const registry = new SkillRegistry(logger);

      const notesSkill = new NotesSkill();
      registry.register(notesSkill);
      await notesSkill.startup(createMockSkillContext("notes"));

      const orchestrator = new Orchestrator(
        providerManager,
        registry,
        context,
        eventBus,
        confirmation,
        logger
      );

      await orchestrator.handleMessage(TEST_USER_ID, "hello", TEST_CHANNEL);

      const chatCall = provider.chatMock.mock.calls[0]![0];
      // Should NOT include the notes section when there are no notes
      expect(chatCall.system).not.toContain("User notes (always visible)");
    });

    it("system prompt works when notes skill is not registered", async () => {
      const provider = createMockProvider({
        responses: [createTextResponse("Hello!")],
      });
      const providerManager = createMockProviderManager(provider);
      const eventBus = createMockEventBus();
      const context = new ContextStore(logger);
      const confirmation = new ConfirmationManager(logger);
      const registry = new SkillRegistry(logger);

      // No notes skill registered
      const orchestrator = new Orchestrator(
        providerManager,
        registry,
        context,
        eventBus,
        confirmation,
        logger
      );

      const response = await orchestrator.handleMessage(
        TEST_USER_ID,
        "hello",
        TEST_CHANNEL
      );

      // Should still work without crashing
      expect(response.text).toBe("Hello!");
      const chatCall = provider.chatMock.mock.calls[0]![0];
      expect(chatCall.system).not.toContain("User notes (always visible)");
    });
  });

  describe("note save-then-search flow", () => {
    it("saves a note and can retrieve it via getAlwaysContextNotes", async () => {
      const notesSkill = new NotesSkill();
      await notesSkill.startup(createMockSkillContext("notes"));

      // Mock save
      mockReturning.mockResolvedValue([{ id: "note-1", title: "API Keys" }]);
      mockValues.mockReturnValue({ returning: mockReturning });
      mockInsert.mockReturnValue({ values: mockValues });

      const saveResult = await notesSkill.execute("note_save", {
        content: "OpenAI key is sk-xxx",
        title: "API Keys",
        tags: ["context:always"],
      });

      const savedParsed = JSON.parse(saveResult);
      expect(savedParsed.success).toBe(true);
      expect(savedParsed.title).toBe("API Keys");

      // Now mock getAlwaysContextNotes to return the saved note
      mockOrderBy.mockResolvedValue([
        { title: "API Keys", content: "OpenAI key is sk-xxx" },
      ]);
      mockWhere.mockReturnValue({ orderBy: mockOrderBy });
      mockFrom.mockReturnValue({ where: mockWhere });
      mockSelect.mockReturnValue({ from: mockFrom });

      const contextNotes =
        await notesSkill.getAlwaysContextNotes("default");
      expect(contextNotes).toHaveLength(1);
      expect(contextNotes[0]).toContain("API Keys");
      expect(contextNotes[0]).toContain("OpenAI key is sk-xxx");
    });
  });
});
