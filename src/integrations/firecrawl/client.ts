/**
 * Thin HTTP client for Firecrawl REST API v1.
 * Uses native fetch — no SDK dependency.
 */

export interface FirecrawlClientOptions {
  apiUrl: string;
  apiKey?: string;
  timeoutMs: number;
}

export interface ScrapeParams {
  url: string;
  formats?: string[];
  onlyMainContent?: boolean;
  waitFor?: number;
}

export interface CrawlParams {
  url: string;
  maxDepth?: number;
  limit?: number;
  includePaths?: string[];
  excludePaths?: string[];
}

export interface MapParams {
  url: string;
  search?: string;
  limit?: number;
}

export interface SearchParams {
  query: string;
  limit?: number;
  lang?: string;
  country?: string;
}

export interface ScrapeResult {
  success: boolean;
  data?: {
    markdown?: string;
    html?: string;
    metadata?: Record<string, unknown>;
  };
  error?: string;
}

export interface CrawlStartResult {
  success: boolean;
  id?: string;
  error?: string;
}

export interface CrawlStatusResult {
  success: boolean;
  status?: string;
  total?: number;
  completed?: number;
  data?: Array<{
    markdown?: string;
    html?: string;
    metadata?: Record<string, unknown>;
    sourceURL?: string;
  }>;
  error?: string;
}

export interface MapResult {
  success: boolean;
  links?: string[];
  error?: string;
}

export interface SearchResult {
  success: boolean;
  data?: Array<{
    url?: string;
    markdown?: string;
    title?: string;
    description?: string;
  }>;
  error?: string;
}

export class FirecrawlClient {
  private apiUrl: string;
  private apiKey?: string;
  private timeoutMs: number;

  constructor(options: FirecrawlClientOptions) {
    this.apiUrl = options.apiUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs;
  }

  async scrape(params: ScrapeParams): Promise<ScrapeResult> {
    return this.post<ScrapeResult>("/v1/scrape", {
      url: params.url,
      formats: params.formats ?? ["markdown"],
      onlyMainContent: params.onlyMainContent ?? true,
      waitFor: params.waitFor,
    });
  }

  async crawlStart(params: CrawlParams): Promise<CrawlStartResult> {
    return this.post<CrawlStartResult>("/v1/crawl", {
      url: params.url,
      maxDepth: params.maxDepth ?? 2,
      limit: params.limit ?? 10,
      includePaths: params.includePaths,
      excludePaths: params.excludePaths,
    });
  }

  async crawlStatus(jobId: string): Promise<CrawlStatusResult> {
    return this.get<CrawlStatusResult>(`/v1/crawl/${encodeURIComponent(jobId)}`);
  }

  async map(params: MapParams): Promise<MapResult> {
    return this.post<MapResult>("/v1/map", {
      url: params.url,
      search: params.search,
      limit: params.limit,
    });
  }

  async search(params: SearchParams): Promise<SearchResult> {
    return this.post<SearchResult>("/v1/search", {
      query: params.query,
      limit: params.limit ?? 5,
      lang: params.lang,
      country: params.country,
    });
  }

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (this.apiKey) {
        headers["Authorization"] = `Bearer ${this.apiKey}`;
      }

      const res = await fetch(`${this.apiUrl}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return { success: false, error: `HTTP ${res.status}: ${text}` } as T;
      }

      return (await res.json()) as T;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message } as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private async get<T>(path: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = {};
      if (this.apiKey) {
        headers["Authorization"] = `Bearer ${this.apiKey}`;
      }

      const res = await fetch(`${this.apiUrl}${path}`, {
        method: "GET",
        headers,
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return { success: false, error: `HTTP ${res.status}: ${text}` } as T;
      }

      return (await res.json()) as T;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message } as T;
    } finally {
      clearTimeout(timer);
    }
  }
}
