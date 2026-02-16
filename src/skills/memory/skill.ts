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
  private llm?: { chat: (params: { system: string; messages: Array<{ role: "user" | "assistant"; content: string }>; maxTokens?: number }) => Promise<{ text: string | null }> };
  private conversations?: { getAllHistories: () => Map<string, Array<{ role: string; content: string; channel: string; timestamp: number }>> };

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
              enum: ["conversation", "fact", "preference", "event", "note", "summary"],
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
            user_id: {
              type: "string",
              description: "Optional user ID to scope the memory to a specific user",
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
            user_id: {
              type: "string",
              description: "Optional user ID to scope the search to a specific user",
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
            user_id: {
              type: "string",
              description: "Optional user ID to scope the context to a specific user",
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
    this.llm = ctx.llm;
    this.conversations = ctx.conversations;

    const config = ctx.config as unknown as MemoryConfig;
    this.client = new MemoryClient({
      base_url: config.base_url ?? "http://memory-service:8010",
      api_key: config.api_key,
    });

    if (config.context_injection) {
      this.contextInjectionEnabled = config.context_injection.enabled ?? true;
      this.contextMaxTokens = config.context_injection.max_tokens ?? 1500;
    }

    // Register daily summarization cron job
    if (ctx.scheduler && this.llm && this.conversations) {
      ctx.scheduler.registerTask({
        name: "daily_summarize",
        cronExpression: "0 23 * * *", // 11 PM daily
        handler: () => this.runDailySummarization(),
        description: "Generate daily conversation summaries and extract facts",
      });
      this.logger.info("Daily summarization cron job registered (11 PM daily)");
    } else if (!this.llm || !this.conversations) {
      this.logger.debug("Daily summarization disabled (missing llm or conversations context)");
    }

    this.logger.info("Memory skill started");
  }

  async shutdown(): Promise<void> {
    this.logger.info("Memory skill stopped");
  }

  /**
   * Public method for auto-ingesting conversation turns.
   * Fire-and-forget: logs errors but doesn't throw.
   */
  async autoIngest(
    content: string,
    userId?: string,
    tags?: string[]
  ): Promise<void> {
    try {
      await this.client.ingest({
        content,
        content_type: "conversation",
        tags: [...(tags ?? []), "auto-ingested"],
        importance: 0.3,
        user_id: userId,
      });
      this.logger.debug({ userId, contentLength: content.length }, "Auto-ingested conversation");
    } catch (err) {
      this.logger.error({ error: err, userId }, "Failed to auto-ingest conversation");
    }
  }

  /**
   * Public method for orchestrator context injection.
   * Returns assembled memory context for the given user message.
   * Results are cached in Redis for 5 minutes.
   */
  async getRelevantMemories(
    query: string,
    maxTokens?: number,
    userId?: string
  ): Promise<string | null> {
    if (!this.contextInjectionEnabled) return null;

    const cacheKey = `ctx:${userId ?? 'anon'}:${this.hashQuery(query)}`;
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) return cached;

      const response = await this.client.context({
        query,
        max_tokens: maxTokens ?? this.contextMaxTokens,
        user_id: userId,
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
      content_type: input.content_type as "fact" | "preference" | "conversation" | "event" | "note" | "summary",
      tags: (input.tags as string[]) ?? [],
      importance: (input.importance as number) ?? 0.5,
      user_id: input.user_id as string | undefined,
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
      user_id: input.user_id as string | undefined,
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
      user_id: input.user_id as string | undefined,
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
      user_id: input.user_id as string | undefined,
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

  /**
   * Daily summarization: generates narrative summaries and extracts facts from today's conversations.
   * Runs at 11 PM daily via cron job.
   */
  private async runDailySummarization(): Promise<void> {
    if (!this.llm || !this.conversations) {
      this.logger.warn("Cannot run daily summarization: missing llm or conversations context");
      return;
    }

    this.logger.info("Starting daily summarization");

    try {
      const allHistories = this.conversations.getAllHistories();
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todayTimestamp = today.getTime();
      const dateStr = today.toISOString().slice(0, 10);

      let processedUsers = 0;
      let totalSummaries = 0;

      for (const [userId, messages] of allHistories.entries()) {
        // Filter to today's messages
        const todayMessages = messages.filter((m) => m.timestamp >= todayTimestamp);

        // Skip if less than 3 messages today
        if (todayMessages.length < 3) {
          this.logger.debug({ userId, messageCount: todayMessages.length }, "Skipping user (insufficient messages)");
          continue;
        }

        processedUsers++;

        // Build conversation text for LLM
        const conversationText = todayMessages
          .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
          .join("\n\n");

        // Call LLM to generate summary and extract facts
        const prompt = `You are analyzing a day's worth of conversations to create a memory summary.

Today's date: ${dateStr}

Conversation:
${conversationText}

Generate two things:

1. SUMMARY: Write a 2-3 sentence narrative summary starting with "On ${dateStr}, ..." that captures the main topics and activities.

2. FACTS: Extract key facts, preferences, or decisions as a JSON array. Each fact should have:
   - content: the fact text
   - content_type: "fact", "preference", or "event"
   - importance: 0.0-1.0
   - tags: array of relevant tags

Format your response exactly as:
SUMMARY:
[your summary here]

FACTS:
[your JSON array here]

If no facts to extract, return an empty array for FACTS.`;

        try {
          const response = await this.llm.chat({
            system: "You are a memory summarization assistant. Extract key information from conversations.",
            messages: [{ role: "user", content: prompt }],
            maxTokens: 2000,
          });

          if (!response.text) {
            this.logger.warn({ userId }, "LLM returned no text for summarization");
            continue;
          }

          // Parse the response
          const { summary, facts } = this.parseSummarizationResult(response.text);

          // Ingest summary
          if (summary) {
            await this.client.ingest({
              content: summary,
              content_type: "summary",
              tags: ["daily-summary", dateStr],
              importance: 0.7,
              user_id: userId,
            });
            totalSummaries++;
            this.logger.debug({ userId, summaryLength: summary.length }, "Summary ingested");
          }

          // Ingest extracted facts
          for (const fact of facts) {
            await this.client.ingest({
              content: fact.content,
              content_type: fact.content_type as "fact" | "preference" | "event",
              tags: [...(fact.tags ?? []), "extracted-from-summary", dateStr],
              importance: fact.importance ?? 0.5,
              user_id: userId,
            });
          }

          if (facts.length > 0) {
            this.logger.debug({ userId, factCount: facts.length }, "Facts extracted and ingested");
          }
        } catch (err) {
          this.logger.error({ error: err, userId }, "Failed to summarize conversation for user");
        }
      }

      this.logger.info(
        { processedUsers, totalSummaries },
        "Daily summarization completed"
      );

      await this.eventBus.publish({
        eventType: "memory.daily_summary",
        timestamp: new Date().toISOString(),
        sourceSkill: this.name,
        payload: { processedUsers, totalSummaries, date: dateStr },
        severity: "low",
      });
    } catch (err) {
      this.logger.error({ error: err }, "Daily summarization failed");
    }
  }

  /**
   * Parse LLM summarization result into summary text and facts array.
   * Handles malformed output gracefully.
   */
  private parseSummarizationResult(text: string): {
    summary: string | null;
    facts: Array<{ content: string; content_type: string; importance: number; tags: string[] }>;
  } {
    let summary: string | null = null;
    let facts: Array<{ content: string; content_type: string; importance: number; tags: string[] }> = [];

    try {
      // Split on markers
      const summaryMatch = text.match(/SUMMARY:\s*\n([\s\S]*?)(?=\nFACTS:|\n*$)/i);
      const factsMatch = text.match(/FACTS:\s*\n([\s\S]*?)$/i);

      if (summaryMatch && summaryMatch[1]) {
        summary = summaryMatch[1].trim();
      }

      if (factsMatch && factsMatch[1]) {
        const factsText = factsMatch[1].trim();
        // Try to parse as JSON
        try {
          const parsed = JSON.parse(factsText);
          if (Array.isArray(parsed)) {
            facts = parsed.filter(
              (f) =>
                typeof f === "object" &&
                f !== null &&
                typeof f.content === "string" &&
                f.content.length > 0
            );
          }
        } catch {
          // Not valid JSON, ignore
          this.logger.debug("Failed to parse FACTS as JSON, skipping");
        }
      }
    } catch (err) {
      this.logger.warn({ error: err }, "Error parsing summarization result");
    }

    return { summary, facts };
  }
}
