import type {
  MemoryIngestRequest,
  MemoryIngestResponse,
  MemorySearchRequest,
  MemorySearchResponse,
  MemoryContextRequest,
  MemoryContextResponse,
  MemoryListResponse,
  MemoryDetail,
  MemoryConfig,
} from "./types.js";

export class MemoryClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(config: MemoryConfig) {
    this.baseUrl = config.base_url.replace(/\/+$/, "");
    this.apiKey = config.api_key;
  }

  async ingest(req: MemoryIngestRequest): Promise<MemoryIngestResponse> {
    return this.post("/ingest", req, 10_000);
  }

  async search(req: MemorySearchRequest): Promise<MemorySearchResponse> {
    return this.post("/search", req, 5_000);
  }

  async context(req: MemoryContextRequest): Promise<MemoryContextResponse> {
    return this.post("/context", req, 5_000);
  }

  async list(params?: {
    content_type?: string;
    tag?: string;
    limit?: number;
    offset?: number;
    user_id?: string;
  }): Promise<MemoryListResponse> {
    const searchParams = new URLSearchParams();
    if (params?.content_type) searchParams.set("content_type", params.content_type);
    if (params?.tag) searchParams.set("tag", params.tag);
    if (params?.limit) searchParams.set("limit", String(params.limit));
    if (params?.offset) searchParams.set("offset", String(params.offset));
    if (params?.user_id) searchParams.set("user_id", params.user_id);
    const qs = searchParams.toString();
    return this.get(`/memories${qs ? `?${qs}` : ""}`, 5_000);
  }

  async getById(id: string): Promise<MemoryDetail> {
    return this.get(`/memories/${encodeURIComponent(id)}`, 5_000);
  }

  async deleteById(id: string): Promise<{ success: boolean; message: string }> {
    return this.request("DELETE", `/memories/${encodeURIComponent(id)}`, undefined, 5_000);
  }

  private async post<T>(path: string, body: unknown, timeoutMs: number): Promise<T> {
    return this.request("POST", path, body, timeoutMs);
  }

  private async get<T>(path: string, timeoutMs: number): Promise<T> {
    return this.request("GET", path, undefined, timeoutMs);
  }

  private async request<T>(
    method: string,
    path: string,
    body: unknown | undefined,
    timeoutMs: number,
    attempt = 0,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const resp = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": this.apiKey,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        const err = new Error(`Memory service ${method} ${path}: ${resp.status} ${text}`);
        // Retry once on 5xx or timeout
        if (attempt === 0 && resp.status >= 500) {
          return this.request(method, path, body, timeoutMs, 1);
        }
        throw err;
      }

      return (await resp.json()) as T;
    } catch (err) {
      if (attempt === 0 && err instanceof Error && err.name === "AbortError") {
        return this.request(method, path, body, timeoutMs, 1);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
}
