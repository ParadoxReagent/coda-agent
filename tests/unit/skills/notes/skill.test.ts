import { describe, it, expect, vi, beforeEach } from "vitest";
import { NotesSkill } from "../../../../src/skills/notes/skill.js";
import { createMockSkillContext } from "../../../helpers/mocks.js";

// Mock the database connection module
const mockReturning = vi.fn();
const mockLimit = vi.fn();
const mockOrderBy = vi.fn();
const mockWhere = vi.fn();
const mockFrom = vi.fn();
const mockSelect = vi.fn();
const mockInsert = vi.fn();
const mockValues = vi.fn();
const mockDelete = vi.fn();

const mockDb = {
  select: mockSelect,
  insert: mockInsert,
  delete: mockDelete,
};

vi.mock("../../../../src/db/connection.js", () => ({
  getDatabase: () => mockDb,
}));

function setupSelectChain(results: unknown[]) {
  mockLimit.mockResolvedValue(results);
  // orderBy can be terminal (returns thenable) or chained (.limit())
  const orderByResult = Object.assign(Promise.resolve(results), { limit: mockLimit });
  mockOrderBy.mockReturnValue(orderByResult);
  mockWhere.mockReturnValue({ orderBy: mockOrderBy, limit: mockLimit });
  mockFrom.mockReturnValue({ where: mockWhere, orderBy: mockOrderBy });
  mockSelect.mockReturnValue({ from: mockFrom });
}

function setupInsertChain(results: unknown[]) {
  mockReturning.mockResolvedValue(results);
  mockValues.mockReturnValue({ returning: mockReturning });
  mockInsert.mockReturnValue({ values: mockValues });
}

function setupDeleteChain(results: unknown[]) {
  mockReturning.mockResolvedValue(results);
  mockWhere.mockReturnValue({ returning: mockReturning });
  mockDelete.mockReturnValue({ where: mockWhere });
}

describe("NotesSkill", () => {
  let skill: NotesSkill;

  beforeEach(() => {
    vi.clearAllMocks();
    skill = new NotesSkill();
  });

  it("has correct metadata", () => {
    expect(skill.name).toBe("notes");
    expect(skill.description).toContain("notes");
    expect(skill.getRequiredConfig()).toEqual([]);
  });

  it("registers 4 tools", () => {
    const tools = skill.getTools();
    expect(tools).toHaveLength(4);
    expect(tools.map((t) => t.name)).toEqual([
      "note_save",
      "note_search",
      "note_list",
      "note_delete",
    ]);
  });

  describe("after startup", () => {
    beforeEach(async () => {
      const ctx = createMockSkillContext("notes");
      await skill.startup(ctx);
    });

    describe("note_save", () => {
      it("saves a note with provided title and tags", async () => {
        setupInsertChain([
          { id: "uuid-1", title: "Test Note" },
        ]);

        const result = await skill.execute("note_save", {
          content: "Hello world",
          title: "Test Note",
          tags: ["work"],
        });

        const parsed = JSON.parse(result);
        expect(parsed.success).toBe(true);
        expect(parsed.id).toBe("uuid-1");
        expect(parsed.title).toBe("Test Note");
        expect(mockInsert).toHaveBeenCalled();
      });

      it("auto-generates title from content when not provided", async () => {
        setupInsertChain([
          { id: "uuid-2", title: "Hello world this is a long..." },
        ]);

        const result = await skill.execute("note_save", {
          content: "Hello world this is a long note",
        });

        const parsed = JSON.parse(result);
        expect(parsed.success).toBe(true);
        expect(mockValues).toHaveBeenCalledWith(
          expect.objectContaining({
            content: "Hello world this is a long note",
            tags: [],
          })
        );
      });
    });

    describe("note_search", () => {
      it("returns matching notes", async () => {
        setupSelectChain([
          {
            id: "uuid-1",
            title: "My Note",
            content: "Some content about testing",
            tags: ["dev"],
            createdAt: new Date("2025-01-01"),
            rank: 0.8,
          },
        ]);

        const result = await skill.execute("note_search", {
          query: "testing",
        });

        const parsed = JSON.parse(result);
        expect(parsed.count).toBe(1);
        expect(parsed.results[0].title).toBe("My Note");
      });

      it("returns empty results message when no matches", async () => {
        setupSelectChain([]);

        const result = await skill.execute("note_search", {
          query: "nonexistent",
        });

        const parsed = JSON.parse(result);
        expect(parsed.results).toEqual([]);
        expect(parsed.message).toContain("No notes found");
      });

      it("truncates long content in results", async () => {
        const longContent = "x".repeat(300);
        setupSelectChain([
          {
            id: "uuid-1",
            title: "Long Note",
            content: longContent,
            tags: [],
            createdAt: new Date("2025-01-01"),
            rank: 0.5,
          },
        ]);

        const result = await skill.execute("note_search", {
          query: "test",
        });

        const parsed = JSON.parse(result);
        expect(parsed.results[0].content.length).toBeLessThan(300);
        expect(parsed.results[0].content).toContain("...");
      });
    });

    describe("note_list", () => {
      it("lists recent notes", async () => {
        setupSelectChain([
          {
            id: "uuid-1",
            title: "Note 1",
            content: "Content 1",
            tags: ["work"],
            createdAt: new Date("2025-01-02"),
          },
          {
            id: "uuid-2",
            title: "Note 2",
            content: "Content 2",
            tags: [],
            createdAt: new Date("2025-01-01"),
          },
        ]);

        const result = await skill.execute("note_list", {});

        const parsed = JSON.parse(result);
        expect(parsed.count).toBe(2);
        expect(parsed.results[0].title).toBe("Note 1");
      });

      it("returns empty message when no notes", async () => {
        setupSelectChain([]);

        const result = await skill.execute("note_list", {});

        const parsed = JSON.parse(result);
        expect(parsed.results).toEqual([]);
        expect(parsed.message).toContain("No notes found");
      });

      it("filters by tag", async () => {
        setupSelectChain([
          {
            id: "uuid-1",
            title: "Work Note",
            content: "Work stuff",
            tags: ["work"],
            createdAt: new Date("2025-01-01"),
          },
        ]);

        const result = await skill.execute("note_list", { tag: "work" });

        const parsed = JSON.parse(result);
        expect(parsed.count).toBe(1);
        // Verify where was called (tag filter applied)
        expect(mockWhere).toHaveBeenCalled();
      });
    });

    describe("note_delete", () => {
      it("deletes an existing note", async () => {
        setupDeleteChain([{ id: "uuid-1" }]);

        const result = await skill.execute("note_delete", { id: "uuid-1" });

        const parsed = JSON.parse(result);
        expect(parsed.success).toBe(true);
        expect(parsed.message).toContain("uuid-1");
      });

      it("returns error when note not found", async () => {
        setupDeleteChain([]);

        const result = await skill.execute("note_delete", {
          id: "nonexistent",
        });

        const parsed = JSON.parse(result);
        expect(parsed.success).toBe(false);
        expect(parsed.message).toContain("not found");
      });
    });

    describe("getAlwaysContextNotes", () => {
      it("returns notes tagged with context:always", async () => {
        const data = [
          { title: "Important", content: "Always show this" },
          { title: null, content: "No title note" },
        ];
        mockOrderBy.mockReturnValue(Promise.resolve(data));
        mockWhere.mockReturnValue({ orderBy: mockOrderBy });
        mockFrom.mockReturnValue({ where: mockWhere });
        mockSelect.mockReturnValue({ from: mockFrom });

        const results = await skill.getAlwaysContextNotes("default");

        expect(results).toHaveLength(2);
        expect(results[0]).toContain("Important");
        expect(results[0]).toContain("Always show this");
        expect(results[1]).toBe("No title note");
      });

      it("returns empty array when no context notes exist", async () => {
        mockOrderBy.mockReturnValue(Promise.resolve([]));
        mockWhere.mockReturnValue({ orderBy: mockOrderBy });
        mockFrom.mockReturnValue({ where: mockWhere });
        mockSelect.mockReturnValue({ from: mockFrom });

        const results = await skill.getAlwaysContextNotes("default");
        expect(results).toEqual([]);
      });
    });

    it("returns unknown tool message for invalid tool name", async () => {
      const result = await skill.execute("note_invalid", {});
      expect(result).toContain("Unknown tool");
    });

    describe("SQL injection resistance", () => {
      it("safely handles SQL injection payloads in search queries", async () => {
        // These payloads should be safely parameterized by Drizzle ORM
        const injectionPayloads = [
          "'; DROP TABLE notes; --",
          "1' OR '1'='1",
          "' UNION SELECT * FROM users --",
          "admin'--",
          "' OR 1=1--",
        ];

        for (const payload of injectionPayloads) {
          setupSelectChain([]);

          // Should not throw and should handle safely
          const result = await skill.execute("note_search", {
            query: payload,
          });

          const parsed = JSON.parse(result);
          expect(parsed.results).toEqual([]);
          expect(mockWhere).toHaveBeenCalled();
        }
      });

      it("safely handles SQL injection in tag filters", async () => {
        setupSelectChain([]);

        const result = await skill.execute("note_list", {
          tag: "'; DROP TABLE notes; --",
        });

        const parsed = JSON.parse(result);
        expect(parsed.results).toEqual([]);
        expect(mockWhere).toHaveBeenCalled();
      });

      it("safely handles SQL injection in note IDs", async () => {
        setupDeleteChain([]);

        const result = await skill.execute("note_delete", {
          id: "' OR '1'='1",
        });

        const parsed = JSON.parse(result);
        expect(parsed.success).toBe(false);
        expect(mockWhere).toHaveBeenCalled();
      });
    });
  });
});
