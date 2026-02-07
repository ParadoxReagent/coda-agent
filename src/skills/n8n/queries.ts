import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { Database } from "../../db/index.js";
import { n8nEvents } from "../../db/schema.js";
import type { N8nEventFilters, N8nEventSummary } from "./types.js";

export class N8nQueries {
  constructor(private db: Database) {}

  async getEvents(filters: N8nEventFilters) {
    const conditions = [];

    if (filters.hoursBack) {
      const since = new Date(Date.now() - filters.hoursBack * 3600000);
      conditions.push(gte(n8nEvents.timestamp, since));
    }

    if (filters.types && filters.types.length > 0) {
      conditions.push(inArray(n8nEvents.type, filters.types));
    }

    if (filters.categories && filters.categories.length > 0) {
      conditions.push(inArray(n8nEvents.category, filters.categories));
    }

    if (filters.tags && filters.tags.length > 0) {
      for (const tag of filters.tags) {
        conditions.push(sql`${tag} = ANY(${n8nEvents.tags})`);
      }
    }

    if (filters.sourceWorkflow) {
      conditions.push(eq(n8nEvents.sourceWorkflow, filters.sourceWorkflow));
    }

    if (filters.onlyUnprocessed) {
      conditions.push(eq(n8nEvents.processed, false));
    }

    if (filters.minPriority === "high") {
      conditions.push(eq(n8nEvents.priority, "high"));
    } else if (filters.minPriority === "normal") {
      conditions.push(
        sql`${n8nEvents.priority} IN ('high', 'normal')`
      );
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    return this.db
      .select()
      .from(n8nEvents)
      .where(whereClause)
      .orderBy(
        sql`CASE ${n8nEvents.priority}
          WHEN 'high' THEN 1
          WHEN 'normal' THEN 2
          WHEN 'low' THEN 3
        END`,
        desc(n8nEvents.timestamp)
      );
  }

  async getSummary(filters: N8nEventFilters): Promise<N8nEventSummary> {
    const events = await this.getEvents(filters);

    const summary: N8nEventSummary = {
      total: events.length,
      by_type: {},
      by_category: {},
      by_priority: {},
      by_workflow: {},
      recent_types: [],
    };

    const seenTypes = new Set<string>();

    for (const event of events) {
      summary.by_type[event.type] = (summary.by_type[event.type] || 0) + 1;

      if (event.category) {
        summary.by_category[event.category] =
          (summary.by_category[event.category] || 0) + 1;
      }

      summary.by_priority[event.priority] =
        (summary.by_priority[event.priority] || 0) + 1;

      if (event.sourceWorkflow) {
        summary.by_workflow[event.sourceWorkflow] =
          (summary.by_workflow[event.sourceWorkflow] || 0) + 1;
      }

      if (!seenTypes.has(event.type)) {
        seenTypes.add(event.type);
        summary.recent_types.push(event.type);
      }
    }

    return summary;
  }

  async markProcessed(eventIds: number[]): Promise<number> {
    if (eventIds.length === 0) return 0;

    const result = await this.db
      .update(n8nEvents)
      .set({
        processed: true,
        processedAt: new Date(),
      })
      .where(inArray(n8nEvents.id, eventIds));

    return result.length;
  }

  async insertEvent(event: {
    type: string;
    category?: string;
    priority: string;
    timestamp: Date;
    data: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    tags?: string[];
    sourceWorkflow?: string;
  }): Promise<void> {
    await this.db.insert(n8nEvents).values({
      type: event.type,
      category: event.category || null,
      priority: event.priority,
      timestamp: event.timestamp,
      data: event.data,
      metadata: event.metadata || {},
      tags: event.tags || [],
      sourceWorkflow: event.sourceWorkflow || null,
    });
  }

  async getEventTypes(hoursBack: number = 168): Promise<string[]> {
    const since = new Date(Date.now() - hoursBack * 3600000);

    const results = await this.db
      .selectDistinct({ type: n8nEvents.type })
      .from(n8nEvents)
      .where(gte(n8nEvents.timestamp, since))
      .orderBy(n8nEvents.type);

    return results.map((r) => r.type);
  }
}
