export interface MemoryIngestRequest {
  content: string;
  content_type: "conversation" | "fact" | "preference" | "event" | "note" | "summary";
  tags?: string[];
  importance?: number;
  source_type?: string;
  source_id?: string;
  metadata?: Record<string, unknown>;
  user_id?: string;
}

export interface MemoryIngestResponse {
  id: string;
  content_hash: string;
  message: string;
}

export interface MemorySearchRequest {
  query: string;
  content_types?: string[];
  tags?: string[];
  limit?: number;
  min_similarity?: number;
  include_archived?: boolean;
  user_id?: string;
}

export interface MemorySearchResult {
  id: string;
  content: string;
  content_type: string;
  tags: string[];
  importance: number;
  relevance_score: number;
  created_at: string;
  source_type?: string;
  metadata?: Record<string, unknown>;
}

export interface MemorySearchResponse {
  results: MemorySearchResult[];
  count: number;
  query: string;
}

export interface MemoryContextRequest {
  query: string;
  max_tokens?: number;
  content_types?: string[];
  user_id?: string;
}

export interface MemoryContextResponse {
  context: string;
  memory_count: number;
  total_tokens_estimate: number;
}

export interface MemoryListResponse {
  results: MemoryDetail[];
  count: number;
}

export interface MemoryDetail {
  id: string;
  content: string;
  content_type: string;
  tags: string[];
  importance: number;
  source_type: string | null;
  source_id: string | null;
  metadata: Record<string, unknown>;
  content_hash: string | null;
  access_count: number;
  accessed_at: string | null;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
}

export interface MemoryConfig {
  base_url: string;
  api_key: string;
  context_injection?: {
    enabled?: boolean;
    max_tokens?: number;
  };
}
