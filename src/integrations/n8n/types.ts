export interface N8nEvent {
  id: number;
  type: string;
  category: string | null;
  priority: string;
  timestamp: Date;
  data: Record<string, unknown>;
  metadata: Record<string, unknown>;
  tags: string[];
  sourceWorkflow: string | null;
  processed: boolean;
  processedAt: Date | null;
  createdAt: Date;
}

export interface N8nEventFilters {
  types?: string[];
  categories?: string[];
  tags?: string[];
  hoursBack?: number;
  onlyUnprocessed?: boolean;
  minPriority?: "high" | "normal" | "low";
  sourceWorkflow?: string;
}

export interface N8nEventSummary {
  total: number;
  by_type: Record<string, number>;
  by_category: Record<string, number>;
  by_priority: Record<string, number>;
  by_workflow: Record<string, number>;
  recent_types: string[];
}
