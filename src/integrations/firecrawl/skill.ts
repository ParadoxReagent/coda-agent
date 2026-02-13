import { FirecrawlClient } from "./client.js";
import type { Skill, SkillToolDefinition } from "../../skills/base.js";
import type { SkillContext } from "../../skills/context.js";
import type { SkillRedisClient } from "../../skills/context.js";
import type { Logger } from "../../utils/logger.js";
import { ContentSanitizer } from "../../core/sanitizer.js";

const DEFAULT_MAX_CONTENT_LENGTH = 50_000;
const DEFAULT_CACHE_TTL = 3600;

export class FirecrawlSkill implements Skill {
  readonly name = "firecrawl";
  readonly description =
    "Web scraping, crawling, URL mapping, and search via Firecrawl";
  readonly kind = "integration" as const;

  private logger!: Logger;
  private client!: FirecrawlClient;
  private redis!: SkillRedisClient;
  private maxContentLength = DEFAULT_MAX_CONTENT_LENGTH;
  private cacheTtl = DEFAULT_CACHE_TTL;

  getTools(): SkillToolDefinition[] {
    return [
      {
        name: "firecrawl_scrape",
        description:
          "Scrape a single URL and return its content as clean markdown.",
        input_schema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "The URL to scrape",
            },
            only_main_content: {
              type: "boolean",
              description:
                "Extract only the main content, excluding nav/footer (default true)",
            },
            formats: {
              type: "array",
              items: { type: "string" },
              description:
                'Output formats, e.g. ["markdown"], ["html"], or ["markdown","html"] (default ["markdown"])',
            },
            wait_for: {
              type: "number",
              description:
                "Milliseconds to wait for dynamic content to load before scraping",
            },
          },
          required: ["url"],
        },
      },
      {
        name: "firecrawl_crawl",
        description:
          "Start an async crawl of a website. Returns a job ID to poll with firecrawl_crawl_status.",
        input_schema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "The starting URL to crawl",
            },
            max_depth: {
              type: "number",
              description: "Maximum link depth to follow (1-5, default 2)",
            },
            limit: {
              type: "number",
              description:
                "Maximum number of pages to crawl (1-50, default 10)",
            },
            include_paths: {
              type: "array",
              items: { type: "string" },
              description:
                "Only crawl URLs matching these glob patterns (e.g. ['/docs/*'])",
            },
            exclude_paths: {
              type: "array",
              items: { type: "string" },
              description:
                "Skip URLs matching these glob patterns (e.g. ['/blog/*'])",
            },
          },
          required: ["url"],
        },
      },
      {
        name: "firecrawl_crawl_status",
        description:
          "Check the status of a crawl job and retrieve results when complete.",
        input_schema: {
          type: "object",
          properties: {
            job_id: {
              type: "string",
              description: "The crawl job ID returned by firecrawl_crawl",
            },
          },
          required: ["job_id"],
        },
      },
      {
        name: "firecrawl_map",
        description:
          "Discover all URLs on a website. Optionally filter by a search term.",
        input_schema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "The website URL to map",
            },
            search: {
              type: "string",
              description: "Optional search term to filter discovered URLs",
            },
            limit: {
              type: "number",
              description: "Maximum number of URLs to return",
            },
          },
          required: ["url"],
        },
      },
      {
        name: "firecrawl_search",
        description:
          "Search the web and extract content from top results.",
        input_schema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "The search query",
            },
            limit: {
              type: "number",
              description:
                "Number of results to return (1-10, default 5)",
            },
            lang: {
              type: "string",
              description: "Language code (e.g. 'en', 'es')",
            },
            country: {
              type: "string",
              description: "Country code (e.g. 'us', 'gb')",
            },
          },
          required: ["query"],
        },
      },
    ];
  }

  async execute(
    toolName: string,
    toolInput: Record<string, unknown>
  ): Promise<string> {
    switch (toolName) {
      case "firecrawl_scrape":
        return this.scrape(toolInput);
      case "firecrawl_crawl":
        return this.crawl(toolInput);
      case "firecrawl_crawl_status":
        return this.crawlStatus(toolInput);
      case "firecrawl_map":
        return this.mapUrls(toolInput);
      case "firecrawl_search":
        return this.search(toolInput);
      default:
        return `Unknown tool: ${toolName}`;
    }
  }

  getRequiredConfig(): string[] {
    return [];
  }

  async startup(ctx: SkillContext): Promise<void> {
    this.logger = ctx.logger;
    this.redis = ctx.redis;

    const cfg = ctx.config;
    const apiUrl = (cfg.api_url as string) ?? "https://api.firecrawl.dev";
    const apiKey = cfg.api_key as string | undefined;
    const defaults = (cfg.defaults as Record<string, unknown>) ?? {};
    const timeoutMs = (defaults.timeout_ms as number) ?? 30_000;
    this.maxContentLength =
      (defaults.max_content_length as number) ?? DEFAULT_MAX_CONTENT_LENGTH;
    this.cacheTtl = (cfg.cache_ttl_seconds as number) ?? DEFAULT_CACHE_TTL;

    this.client = new FirecrawlClient({ apiUrl, apiKey, timeoutMs });
    this.logger.info({ apiUrl }, "Firecrawl skill started");
  }

  async shutdown(): Promise<void> {
    this.logger?.info("Firecrawl skill stopped");
  }

  // --- Tool implementations ---

  private async scrape(input: Record<string, unknown>): Promise<string> {
    const url = input.url as string;
    const cacheKey = `scrape:${url}`;

    const cached = await this.redis.get(cacheKey);
    if (cached) {
      this.logger.debug({ url }, "Returning cached scrape result");
      return cached;
    }

    const result = await this.client.scrape({
      url,
      onlyMainContent: (input.only_main_content as boolean) ?? true,
      formats: input.formats as string[] | undefined,
      waitFor: input.wait_for as number | undefined,
    });

    if (!result.success) {
      return JSON.stringify({ success: false, error: result.error });
    }

    const markdown = this.truncateContent(result.data?.markdown ?? "");
    const sanitized = ContentSanitizer.sanitizeApiResponse(markdown.content);

    const response = JSON.stringify({
      success: true,
      url,
      markdown: sanitized,
      truncated: markdown.truncated,
      metadata: result.data?.metadata ?? {},
    });

    await this.redis.set(cacheKey, response, this.cacheTtl);
    return response;
  }

  private async crawl(input: Record<string, unknown>): Promise<string> {
    const url = input.url as string;
    const maxDepth = Math.min(Math.max((input.max_depth as number) ?? 2, 1), 5);
    const limit = Math.min(Math.max((input.limit as number) ?? 10, 1), 50);

    const result = await this.client.crawlStart({
      url,
      maxDepth,
      limit,
      includePaths: input.include_paths as string[] | undefined,
      excludePaths: input.exclude_paths as string[] | undefined,
    });

    if (!result.success) {
      return JSON.stringify({ success: false, error: result.error });
    }

    return JSON.stringify({
      success: true,
      job_id: result.id,
      message: `Crawl started for ${url}. Use firecrawl_crawl_status with job_id to check progress.`,
    });
  }

  private async crawlStatus(input: Record<string, unknown>): Promise<string> {
    const jobId = input.job_id as string;
    const result = await this.client.crawlStatus(jobId);

    if (!result.success) {
      return JSON.stringify({ success: false, error: result.error });
    }

    const pages = (result.data ?? []).map((page) => {
      const markdown = this.truncateContent(page.markdown ?? "");
      return {
        url: page.sourceURL,
        markdown: ContentSanitizer.sanitizeApiResponse(markdown.content),
        truncated: markdown.truncated,
        metadata: page.metadata ?? {},
      };
    });

    return JSON.stringify({
      success: true,
      status: result.status,
      total: result.total,
      completed: result.completed,
      pages,
    });
  }

  private async mapUrls(input: Record<string, unknown>): Promise<string> {
    const url = input.url as string;
    const result = await this.client.map({
      url,
      search: input.search as string | undefined,
      limit: input.limit as number | undefined,
    });

    if (!result.success) {
      return JSON.stringify({ success: false, error: result.error });
    }

    return JSON.stringify({
      success: true,
      url,
      links: result.links ?? [],
      count: (result.links ?? []).length,
    });
  }

  private async search(input: Record<string, unknown>): Promise<string> {
    const query = input.query as string;
    const limit = Math.min(Math.max((input.limit as number) ?? 5, 1), 10);
    const cacheKey = `search:${query}:${limit}`;

    const cached = await this.redis.get(cacheKey);
    if (cached) {
      this.logger.debug({ query }, "Returning cached search result");
      return cached;
    }

    const result = await this.client.search({
      query,
      limit,
      lang: input.lang as string | undefined,
      country: input.country as string | undefined,
    });

    if (!result.success) {
      return JSON.stringify({ success: false, error: result.error });
    }

    const results = (result.data ?? []).map((item) => {
      const markdown = this.truncateContent(item.markdown ?? "");
      return {
        url: item.url,
        title: item.title,
        description: item.description,
        markdown: ContentSanitizer.sanitizeApiResponse(markdown.content),
        truncated: markdown.truncated,
      };
    });

    const response = JSON.stringify({
      success: true,
      query,
      results,
      count: results.length,
    });

    await this.redis.set(cacheKey, response, this.cacheTtl);
    return response;
  }

  private truncateContent(content: string): {
    content: string;
    truncated: boolean;
  } {
    if (content.length <= this.maxContentLength) {
      return { content, truncated: false };
    }
    return {
      content: content.slice(0, this.maxContentLength),
      truncated: true,
    };
  }
}
