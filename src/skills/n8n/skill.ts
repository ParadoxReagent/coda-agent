import type { Skill, SkillToolDefinition } from "../base.js";
import type { SkillContext } from "../context.js";
import type { EventBus } from "../../core/events.js";
import type { Logger } from "../../utils/logger.js";
import type { Database } from "../../db/index.js";
import { ContentSanitizer } from "../../core/sanitizer.js";
import { N8nQueries } from "./queries.js";
import type { N8nEventFilters } from "./types.js";

export class N8nSkill implements Skill {
  readonly name = "n8n";
  readonly description =
    "Access data ingested from n8n workflows — emails, calendar events, alerts, and any custom event type";

  private logger!: Logger;
  private db!: Database;
  private eventBus!: EventBus;
  private queries!: N8nQueries;

  getTools(): SkillToolDefinition[] {
    return [
      {
        name: "n8n_query_events",
        description:
          "Query events from n8n workflows with flexible filtering. Supports any event type sent from n8n. Use for morning briefings, checking specific event types, or searching by tags/categories.",
        input_schema: {
          type: "object",
          properties: {
            types: {
              type: "array",
              items: { type: "string" },
              description:
                "Filter by specific event types (e.g., ['email', 'github_pr', 'slack_message']). Leave empty for all types.",
            },
            categories: {
              type: "array",
              items: {
                type: "string",
                enum: [
                  "communication",
                  "calendar",
                  "system",
                  "business",
                  "development",
                  "monitoring",
                  "custom",
                ],
              },
              description: "Filter by event categories",
            },
            tags: {
              type: "array",
              items: { type: "string" },
              description:
                "Filter by tags (events must have ALL specified tags)",
            },
            hours_back: {
              type: "number",
              description:
                "How many hours to look back (default: 12 for overnight)",
              minimum: 1,
              maximum: 168,
            },
            only_unprocessed: {
              type: "boolean",
              description: "Only show unprocessed items (default: true)",
            },
            min_priority: {
              type: "string",
              enum: ["high", "normal", "low"],
              description: "Minimum priority level to include",
            },
            source_workflow: {
              type: "string",
              description: "Filter by specific n8n workflow name/ID",
            },
          },
        },
      },
      {
        name: "n8n_get_summary",
        description:
          "Get a statistical summary of events including counts by type, category, priority, and workflow. Useful for quick overview or discovering what types of events are available.",
        input_schema: {
          type: "object",
          properties: {
            hours_back: {
              type: "number",
              description: "How many hours to look back (default: 24)",
              minimum: 1,
            },
            only_unprocessed: {
              type: "boolean",
              description: "Only count unprocessed events (default: true)",
            },
          },
        },
      },
      {
        name: "n8n_list_event_types",
        description:
          "List all unique event types seen in the last N hours. Useful for discovering what kinds of events are being sent from n8n.",
        input_schema: {
          type: "object",
          properties: {
            hours_back: {
              type: "number",
              description:
                "How many hours to look back (default: 168 = 1 week)",
              minimum: 1,
            },
          },
        },
      },
      {
        name: "n8n_mark_processed",
        description:
          "Mark specific events as processed/read. Use after user acknowledges or acts on events.",
        input_schema: {
          type: "object",
          properties: {
            event_ids: {
              type: "array",
              items: { type: "number" },
              description: "Array of event IDs to mark as processed",
              minItems: 1,
            },
          },
          required: ["event_ids"],
        },
      },
    ];
  }

  async execute(
    toolName: string,
    toolInput: Record<string, unknown>
  ): Promise<string> {
    try {
      switch (toolName) {
        case "n8n_query_events":
          return await this.queryEvents(toolInput);
        case "n8n_get_summary":
          return await this.getSummary(toolInput);
        case "n8n_list_event_types":
          return await this.listEventTypes(toolInput);
        case "n8n_mark_processed":
          return await this.markProcessed(toolInput);
        default:
          return JSON.stringify({
            success: false,
            message: `Unknown tool: ${toolName}`,
          });
      }
    } catch (err) {
      this.logger.error({ error: err, tool: toolName }, "Tool execution failed");
      return JSON.stringify({
        success: false,
        message: `Error executing ${toolName}: ${err instanceof Error ? err.message : "Unknown error"}`,
      });
    }
  }

  getRequiredConfig(): string[] {
    return [];
  }

  async startup(ctx: SkillContext): Promise<void> {
    this.db = ctx.db;
    this.eventBus = ctx.eventBus;
    this.logger = ctx.logger;
    this.queries = new N8nQueries(this.db);

    // Subscribe to n8n events from webhook service
    ctx.eventBus.subscribe("n8n.*", async (event) => {
      try {
        const payload = event.payload;

        this.logger.info(
          {
            type: payload.type,
            category: payload.category,
            workflow: payload.source_workflow,
          },
          "Received n8n event from webhook"
        );

        await this.queries.insertEvent({
          type: payload.type as string,
          category: payload.category as string | undefined,
          priority: payload.priority as string,
          timestamp: new Date(payload.timestamp as string),
          data: payload.data as Record<string, unknown>,
          metadata: (payload.metadata as Record<string, unknown>) || {},
          tags: (payload.tags as string[]) || [],
          sourceWorkflow: payload.source_workflow as string | undefined,
        });

        // Route high-priority events as alerts
        if (payload.priority === "high") {
          await this.eventBus.publish({
            eventType: `alert.n8n.${(payload.category as string) || "urgent"}`,
            timestamp: new Date().toISOString(),
            sourceSkill: this.name,
            payload: {
              type: payload.type,
              summary: this.generateAlertSummary(payload),
              timestamp: payload.timestamp,
            },
            severity: "high",
          });
        }
      } catch (err) {
        this.logger.error({ error: err }, "Failed to process n8n event");
      }
    });

    this.logger.info("n8n skill started and subscribed to event bus");
  }

  async shutdown(): Promise<void> {
    this.logger?.info("n8n skill shutdown");
  }

  private async queryEvents(
    input: Record<string, unknown>
  ): Promise<string> {
    const filters: N8nEventFilters = {
      types: input.types as string[] | undefined,
      categories: input.categories as string[] | undefined,
      tags: input.tags as string[] | undefined,
      hoursBack: (input.hours_back as number) ?? 12,
      onlyUnprocessed: (input.only_unprocessed as boolean) ?? true,
      minPriority: input.min_priority as
        | "high"
        | "normal"
        | "low"
        | undefined,
      sourceWorkflow: input.source_workflow as string | undefined,
    };

    const events = await this.queries.getEvents(filters);

    if (events.length === 0) {
      const filterDesc: string[] = [];
      if (filters.types?.length)
        filterDesc.push(`types: ${filters.types.join(", ")}`);
      if (filters.categories?.length)
        filterDesc.push(`categories: ${filters.categories.join(", ")}`);
      if (filters.tags?.length)
        filterDesc.push(`tags: ${filters.tags.join(", ")}`);

      return JSON.stringify({
        results: [],
        count: 0,
        message: `No events found${filterDesc.length ? ` matching ${filterDesc.join("; ")}` : ""}.`,
      });
    }

    const formattedEvents = events.map((e) => this.formatEvent(e));

    return JSON.stringify({
      count: events.length,
      filters_applied: {
        time_range_hours: filters.hoursBack,
        types: filters.types || "all",
        categories: filters.categories || "all",
        tags: filters.tags || "none",
        workflow: filters.sourceWorkflow || "all",
        only_unprocessed: filters.onlyUnprocessed,
      },
      events: formattedEvents,
    });
  }

  private async getSummary(
    input: Record<string, unknown>
  ): Promise<string> {
    const hoursBack = (input.hours_back as number) ?? 24;
    const onlyUnprocessed = (input.only_unprocessed as boolean) ?? true;

    const summary = await this.queries.getSummary({
      hoursBack,
      onlyUnprocessed,
    });

    return JSON.stringify(summary);
  }

  private async listEventTypes(
    input: Record<string, unknown>
  ): Promise<string> {
    const hoursBack = (input.hours_back as number) ?? 168;

    const types = await this.queries.getEventTypes(hoursBack);

    if (types.length === 0) {
      return JSON.stringify({
        count: 0,
        types: [],
        message: "No events found in the specified time range.",
      });
    }

    return JSON.stringify({
      count: types.length,
      types,
      time_range_hours: hoursBack,
    });
  }

  private async markProcessed(
    input: Record<string, unknown>
  ): Promise<string> {
    const eventIds = input.event_ids as number[];

    if (!Array.isArray(eventIds) || eventIds.length === 0) {
      return JSON.stringify({
        success: false,
        message: "No event IDs provided",
      });
    }

    const count = await this.queries.markProcessed(eventIds);

    this.logger.info({ count, eventIds }, "Marked events as processed");

    await this.eventBus.publish({
      eventType: "n8n.events.processed",
      timestamp: new Date().toISOString(),
      sourceSkill: this.name,
      payload: { count, eventIds },
      severity: "low",
    });

    return JSON.stringify({
      success: true,
      message: `Marked ${count} event(s) as processed`,
    });
  }

  private formatEvent(
    event: Record<string, unknown>
  ): Record<string, unknown> {
    const data = event.data as Record<string, unknown>;
    const sanitizedData = this.sanitizeEventData(data);

    return {
      id: event.id,
      type: event.type,
      category: event.category,
      priority: event.priority,
      timestamp:
        event.timestamp instanceof Date
          ? event.timestamp.toISOString()
          : event.timestamp,
      tags: event.tags,
      source_workflow: event.sourceWorkflow,
      data: sanitizedData,
      metadata: event.metadata,
    };
  }

  private sanitizeEventData(
    data: Record<string, unknown>
  ): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(data)) {
      if (typeof value === "string") {
        sanitized[key] = ContentSanitizer.sanitizeApiResponse(value);
      } else if (typeof value === "object" && value !== null) {
        sanitized[key] = Array.isArray(value)
          ? value.map((v) =>
              typeof v === "object" && v !== null
                ? this.sanitizeEventData(v as Record<string, unknown>)
                : v
            )
          : this.sanitizeEventData(value as Record<string, unknown>);
      } else {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }

  private generateAlertSummary(payload: Record<string, unknown>): string {
    const data = payload.data as Record<string, unknown> | undefined;
    if (data?.subject) return ContentSanitizer.sanitizeEmailMetadata(data.subject as string);
    if (data?.title) return ContentSanitizer.sanitizeEmailMetadata(data.title as string);
    if (data?.message) return ContentSanitizer.sanitizeEmailMetadata(data.message as string);
    if (data?.summary) return ContentSanitizer.sanitizeEmailMetadata(data.summary as string);

    return `${payload.type} event from ${ContentSanitizer.sanitizeHostname((payload.source_workflow as string) || "n8n")}`;
  }
}
