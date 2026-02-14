import type { Skill, SkillToolDefinition } from "../base.js";
import type { SkillContext } from "../context.js";
import type { Logger } from "../../utils/logger.js";
import type { EventBus } from "../../core/events.js";
import { MemoryClient } from "./client.js";
import type { MemoryConfig } from "./types.js";

const CONTEXT_CACHE_TTL = 300; // 5 minutes

export class MemorySkill implements Skill {
  readonly name = "memory";
  readonly description =
    "Save and retrieve semantic memories. Use memory_save to remember important information, memory_search to find relevant memories by meaning, and memory_context to get assembled context for a topic.";

  private logger!: Logger;
  private client!: MemoryClient;
  private eventBus!: EventBus;
  private redis!: { get: (k: string) => Promise<string | null>; set: (k: string, v: string, ttl?: number) => Promise<void>; del: (k: string) => Promise<void> };
  private contextInjectionEnabled = true;
  private contextMaxTokens = 1500;

  getTools(): SkillToolDefinition[] {
    return [
      {
        name: "memory_save",
        description:
          "Save information to long-term memory. Use this to remember facts, preferences, events, or important conversation details that may be useful later.",
        input_schema: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description: "The information to remember",
            },
            content_type: {
              type: "string",
              enum: ["conversation", "fact", "preference", "event", "note"],
              description: "Category of memory",
            },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Optional tags for categorization",
            },
            importance: {
              type: "number",
              description:
                "Importance from 0 to 1 (default 0.5). Use higher values for critical facts.",
            },
          },
          required: ["content", "content_type"],
        },
      },
      {
        name: "memory_search",
        description:
          "Search memories by meaning (semantic search). Returns memories similar to the query.",
        sensitive: true,
        input_schema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search query — describe what you're looking for",
            },
            content_types: {
              type: "array",
              items: { type: "string" },
              description: "Optional filter by content types",
            },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Optional filter by tags",
            },
            limit: {
              type: "number",
              description: "Max results (default 10)",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "memory_context",
        description:
          "Get assembled context from memories for a topic. Returns a formatted summary of relevant memories within a token budget.",
        sensitive: true,
        input_schema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Topic to get context for",
            },
            max_tokens: {
              type: "number",
              description: "Token budget for context (default 1500)",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "memory_list",
        description:
          "List recent memories, optionally filtered by content type or tag.",
        sensitive: true,
        input_schema: {
          type: "object",
          properties: {
            content_type: {
              type: "string",
              description: "Filter by content type",
            },
            tag: {
              type: "string",
              description: "Filter by tag",
            },
            limit: {
              type: "number",
              description: "Max results (default 20)",
            },
          },
        },
      },
      {
        name: "memory_delete",
        description: "Delete (archive) a memory by its ID.",
        input_schema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Memory UUID to delete" },
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
      case "memory_save":
        return this.save(toolInput);
      case "memory_search":
        return this.search(toolInput);
      case "memory_context":
        return this.getContext(toolInput);
      case "memory_list":
        return this.list(toolInput);
      case "memory_delete":
        return this.delete(toolInput);
      default:
        return `Unknown tool: ${toolName}`;
    }
  }

  getRequiredConfig(): string[] {
    return ["api_key"];
  }

  async startup(ctx: SkillContext): Promise<void> {
    this.logger = ctx.logger;
    this.redis = ctx.redis;
    this.eventBus = ctx.eventBus;

    const config = ctx.config as unknown as MemoryConfig;
    this.client = new MemoryClient({
      base_url: config.base_url ?? "http://memory-service:8010",
      api_key: config.api_key,
    });

    if (config.context_injection) {
      this.contextInjectionEnabled = config.context_injection.enabled ?? true;
      this.contextMaxTokens = config.context_injection.max_tokens ?? 1500;
    }

    this.logger.info("Memory skill started");
  }

  async shutdown(): Promise<void> {
    this.logger.info("Memory skill stopped");
  }

  /**
   * Public method for orchestrator context injection.
   * Returns assembled memory context for the given user message.
   * Results are cached in Redis for 5 minutes.
   */
  async getRelevantMemories(
    query: string,
    maxTokens?: number
  ): Promise<string | null> {
    if (!this.contextInjectionEnabled) return null;

    const cacheKey = `ctx:${this.hashQuery(query)}`;
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) return cached;

      const response = await this.client.context({
        query,
        max_tokens: maxTokens ?? this.contextMaxTokens,
      });

      if (!response.context) return null;

      await this.redis.set(cacheKey, response.context, CONTEXT_CACHE_TTL);
      return response.context;
    } catch (err) {
      this.logger.error(
        { error: err },
        "Failed to fetch memory context"
      );
      return null;
    }
  }

  private hashQuery(query: string): string {
    // Simple hash for cache key — not cryptographic
    let hash = 0;
    for (let i = 0; i < query.length; i++) {
      hash = ((hash << 5) - hash + query.charCodeAt(i)) | 0;
    }
    return hash.toString(36);
  }

  private async save(input: Record<string, unknown>): Promise<string> {
    const result = await this.client.ingest({
      content: input.content as string,
      content_type: input.content_type as "fact" | "preference" | "conversation" | "event" | "note",
      tags: (input.tags as string[]) ?? [],
      importance: (input.importance as number) ?? 0.5,
    });

    this.logger.info(
      { memoryId: result.id, contentType: input.content_type },
      "Memory saved"
    );

    await this.eventBus.publish({
      eventType: "memory.saved",
      timestamp: new Date().toISOString(),
      sourceSkill: this.name,
      payload: { memoryId: result.id, contentType: input.content_type },
      severity: "low",
    });

    return JSON.stringify({
      success: true,
      id: result.id,
      message: "Memory saved successfully",
    });
  }

  private async search(input: Record<string, unknown>): Promise<string> {
    const response = await this.client.search({
      query: input.query as string,
      content_types: input.content_types as string[] | undefined,
      tags: input.tags as string[] | undefined,
      limit: (input.limit as number) ?? 10,
    });

    await this.eventBus.publish({
      eventType: "memory.searched",
      timestamp: new Date().toISOString(),
      sourceSkill: this.name,
      payload: { query: input.query, resultCount: response.count },
      severity: "low",
    });

    if (response.count === 0) {
      return JSON.stringify({
        results: [],
        message: `No memories found matching "${input.query}"`,
      });
    }

    return JSON.stringify({
      results: response.results.map((r) => ({
        id: r.id,
        content:
          r.content.length > 200
            ? r.content.slice(0, 200) + "..."
            : r.content,
        content_type: r.content_type,
        tags: r.tags,
        relevance: r.relevance_score,
        created_at: r.created_at,
      })),
      count: response.count,
    });
  }

  private async getContext(input: Record<string, unknown>): Promise<string> {
    const response = await this.client.context({
      query: input.query as string,
      max_tokens: (input.max_tokens as number) ?? 1500,
    });

    return JSON.stringify({
      context: response.context,
      memory_count: response.memory_count,
      tokens_used: response.total_tokens_estimate,
    });
  }

  private async list(input: Record<string, unknown>): Promise<string> {
    const response = await this.client.list({
      content_type: input.content_type as string | undefined,
      tag: input.tag as string | undefined,
      limit: (input.limit as number) ?? 20,
    });

    if (response.count === 0) {
      return JSON.stringify({
        results: [],
        message: "No memories found",
      });
    }

    return JSON.stringify({
      results: response.results.map((r) => ({
        id: r.id,
        content:
          r.content.length > 100
            ? r.content.slice(0, 100) + "..."
            : r.content,
        content_type: r.content_type,
        tags: r.tags,
        importance: r.importance,
        created_at: r.created_at,
      })),
      count: response.count,
    });
  }

  private async delete(input: Record<string, unknown>): Promise<string> {
    const id = input.id as string;
    const result = await this.client.deleteById(id);

    await this.eventBus.publish({
      eventType: "memory.deleted",
      timestamp: new Date().toISOString(),
      sourceSkill: this.name,
      payload: { memoryId: id },
      severity: "low",
    });

    return JSON.stringify({
      success: result.success,
      message: result.message,
    });
  }
}
