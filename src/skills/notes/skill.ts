import { eq, desc, sql, and, arrayContains } from "drizzle-orm";
import { getDatabase } from "../../db/connection.js";
import { notes } from "../../db/schema.js";
import type { Skill, SkillToolDefinition } from "../base.js";
import type { SkillContext } from "../context.js";
import type { Logger } from "../../utils/logger.js";
import type { Database } from "../../db/index.js";

const DEFAULT_USER_ID = "default";

export class NotesSkill implements Skill {
  readonly name = "notes";
  readonly description =
    "Save, search, list, and delete personal notes with full-text search and tagging";

  private logger!: Logger;
  private db!: Database;

  getTools(): SkillToolDefinition[] {
    return [
      {
        name: "note_save",
        description:
          "Save a new note. Optionally provide a title and tags. Use tag 'context:always' to include the note in every conversation.",
        input_schema: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description: "The note content",
            },
            title: {
              type: "string",
              description:
                "Optional title. If not provided, auto-generated from first ~50 chars of content.",
            },
            tags: {
              type: "array",
              items: { type: "string" },
              description:
                "Optional tags for categorization and filtering (e.g. ['work', 'context:always'])",
            },
          },
          required: ["content"],
        },
      },
      {
        name: "note_search",
        description:
          "Search notes using full-text search. Optionally filter by tags.",
        input_schema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search query for full-text search",
            },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Optional tags to filter results",
            },
            limit: {
              type: "number",
              description: "Max results to return (default 10)",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "note_list",
        description:
          "List recent notes, optionally filtered by tag. Sorted by creation date (newest first).",
        input_schema: {
          type: "object",
          properties: {
            tag: {
              type: "string",
              description: "Optional tag to filter notes",
            },
            limit: {
              type: "number",
              description: "Max results to return (default 20)",
            },
          },
        },
      },
      {
        name: "note_delete",
        description: "Delete a note by its ID.",
        input_schema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "The UUID of the note to delete",
            },
          },
          required: ["id"],
        },
      },
    ];
  }

  async execute(
    toolName: string,
    toolInput: Record<string, unknown>
  ): Promise<string> {
    switch (toolName) {
      case "note_save":
        return this.saveNote(toolInput);
      case "note_search":
        return this.searchNotes(toolInput);
      case "note_list":
        return this.listNotes(toolInput);
      case "note_delete":
        return this.deleteNote(toolInput);
      default:
        return `Unknown tool: ${toolName}`;
    }
  }

  getRequiredConfig(): string[] {
    return [];
  }

  async startup(ctx: SkillContext): Promise<void> {
    this.logger = ctx.logger;
    this.db = getDatabase();
    this.logger.info("Notes skill started");
  }

  async shutdown(): Promise<void> {
    this.logger.info("Notes skill stopped");
  }

  /** Public method: get notes tagged with context:always for system prompt injection. */
  async getAlwaysContextNotes(userId: string): Promise<string[]> {
    const db = this.db;
    const results = await db
      .select({ content: notes.content, title: notes.title })
      .from(notes)
      .where(
        and(
          eq(notes.userId, userId),
          arrayContains(notes.tags, ["context:always"])
        )
      )
      .orderBy(desc(notes.createdAt));

    return results.map(
      (r) => (r.title ? `**${r.title}**: ${r.content}` : r.content)
    );
  }

  private async saveNote(input: Record<string, unknown>): Promise<string> {
    const content = input.content as string;
    const tags = (input.tags as string[] | undefined) ?? [];
    const title =
      (input.title as string | undefined) ??
      content.slice(0, 50).trim() + (content.length > 50 ? "..." : "");

    const [inserted] = await this.db
      .insert(notes)
      .values({
        userId: DEFAULT_USER_ID,
        title,
        content,
        tags,
      })
      .returning({ id: notes.id, title: notes.title });

    return JSON.stringify({
      success: true,
      id: inserted!.id,
      title: inserted!.title,
      message: `Note saved: "${inserted!.title}"`,
    });
  }

  private async searchNotes(input: Record<string, unknown>): Promise<string> {
    const query = input.query as string;
    const tags = input.tags as string[] | undefined;
    const limit = (input.limit as number | undefined) ?? 10;

    const conditions = [
      eq(notes.userId, DEFAULT_USER_ID),
      sql`${notes.searchVector} @@ plainto_tsquery('english', ${query})`,
    ];

    if (tags && tags.length > 0) {
      conditions.push(arrayContains(notes.tags, tags));
    }

    const results = await this.db
      .select({
        id: notes.id,
        title: notes.title,
        content: notes.content,
        tags: notes.tags,
        createdAt: notes.createdAt,
        rank: sql<number>`ts_rank(${notes.searchVector}, plainto_tsquery('english', ${query}))`,
      })
      .from(notes)
      .where(and(...conditions))
      .orderBy(
        sql`ts_rank(${notes.searchVector}, plainto_tsquery('english', ${query})) DESC`
      )
      .limit(limit);

    if (results.length === 0) {
      return JSON.stringify({
        results: [],
        message: `No notes found matching "${query}"`,
      });
    }

    return JSON.stringify({
      results: results.map((r) => ({
        id: r.id,
        title: r.title,
        content:
          r.content.length > 200
            ? r.content.slice(0, 200) + "..."
            : r.content,
        tags: r.tags,
        createdAt: r.createdAt,
      })),
      count: results.length,
    });
  }

  private async listNotes(input: Record<string, unknown>): Promise<string> {
    const tag = input.tag as string | undefined;
    const limit = (input.limit as number | undefined) ?? 20;

    const conditions = [eq(notes.userId, DEFAULT_USER_ID)];

    if (tag) {
      conditions.push(arrayContains(notes.tags, [tag]));
    }

    const results = await this.db
      .select({
        id: notes.id,
        title: notes.title,
        content: notes.content,
        tags: notes.tags,
        createdAt: notes.createdAt,
      })
      .from(notes)
      .where(and(...conditions))
      .orderBy(desc(notes.createdAt))
      .limit(limit);

    if (results.length === 0) {
      return JSON.stringify({
        results: [],
        message: tag
          ? `No notes found with tag "${tag}"`
          : "No notes found",
      });
    }

    return JSON.stringify({
      results: results.map((r) => ({
        id: r.id,
        title: r.title,
        snippet:
          r.content.length > 100
            ? r.content.slice(0, 100) + "..."
            : r.content,
        tags: r.tags,
        createdAt: r.createdAt,
      })),
      count: results.length,
    });
  }

  private async deleteNote(input: Record<string, unknown>): Promise<string> {
    const id = input.id as string;

    const deleted = await this.db
      .delete(notes)
      .where(and(eq(notes.id, id), eq(notes.userId, DEFAULT_USER_ID)))
      .returning({ id: notes.id });

    if (deleted.length === 0) {
      return JSON.stringify({
        success: false,
        message: `Note with id "${id}" not found`,
      });
    }

    return JSON.stringify({
      success: true,
      message: `Note "${id}" deleted`,
    });
  }
}
