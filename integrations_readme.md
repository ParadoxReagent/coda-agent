# Integrations

External service connectors that require credentials and/or polling. Located in `src/integrations/`.

## n8n

Ingests events from [n8n](https://n8n.io) automation workflows. Accepts any event type — emails, GitHub PRs, server alerts, etc.

| Tool | Description |
|------|-------------|
| `n8n_query_events` | Query events with flexible filtering by type, category, priority, tags |
| `n8n_get_summary` | Statistical overview of events by type, category, priority |
| `n8n_list_event_types` | Discover what event types exist in the system |
| `n8n_mark_processed` | Mark events as read/processed |

## Firecrawl

Web scraping, crawling, URL discovery, and search via [Firecrawl](https://firecrawl.dev) (API v2). Supports both Firecrawl Cloud and self-hosted instances ([GitHub](https://github.com/firecrawl/firecrawl)).

| Tool | Description |
|------|-------------|
| `firecrawl_scrape` | Scrape a single URL and return clean markdown. Params: `url` (required), `only_main_content`, `formats`, `wait_for` |
| `firecrawl_crawl` | Start an async website crawl. Returns a job ID to poll. Params: `url` (required), `max_depth` (1-5), `limit` (1-50), `include_paths`, `exclude_paths` |
| `firecrawl_crawl_status` | Check crawl job progress and retrieve results. Params: `job_id` (required) |
| `firecrawl_map` | Discover all URLs on a website. Params: `url` (required), `search`, `limit` |
| `firecrawl_search` | Web search with content extraction from top results. Params: `query` (required), `limit` (1-10), `lang`, `country` |

### Setup

**Firecrawl Cloud** (default) — requires an API key:

```bash
# Environment variable
FIRECRAWL_API_KEY=fc-...
```

Or in `config.yaml`:

```yaml
firecrawl:
  api_key: "fc-..."
```

**Self-hosted** — no API key needed:

```yaml
firecrawl:
  api_url: "http://localhost:3002"
```

### Configuration

All options with defaults:

```yaml
firecrawl:
  api_key: "fc-..."                          # required for cloud, optional for self-hosted
  api_url: "https://api.firecrawl.dev"       # change for self-hosted
  defaults:
    only_main_content: true                  # strip nav/footer from scrapes
    output_format: "markdown"                # "markdown" or "html"
    timeout_ms: 30000                        # per-request timeout
    max_content_length: 50000                # truncate content beyond this (bytes)
  rate_limit:
    max_requests: 30                         # requests per window
    window_seconds: 60                       # rate limit window
  cache_ttl_seconds: 3600                    # cache scrape/search results (1 hour)
```

**Env overrides:** `FIRECRAWL_API_KEY`, `FIRECRAWL_API_URL`

### How It Works

- **Scrape and search results are cached** in Redis (default 1 hour) — repeated calls to the same URL return instantly.
- **Crawls are async** — `firecrawl_crawl` returns immediately with a job ID; use `firecrawl_crawl_status` to poll for results.
- **Crawl limit is capped at 50 pages** to prevent runaway costs.
- **All external content is sanitized** before being returned to the LLM to prevent prompt injection.
- **Content is truncated** at `max_content_length` (default 50KB) with a `truncated: true` flag when exceeded.

### Agent Skill: Web Research

Activate the `web-research` agent skill via `skill_activate` for guided research strategies including quick fact-finding, documentation exploration, and deep multi-source research. See [skills_readme.md](skills_readme.md#web-research) for details.
