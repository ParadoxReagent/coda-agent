# Integrations

External service connectors that require credentials and/or polling. Located in `src/integrations/`.

## MCP (Model Context Protocol)

Connect to external [MCP servers](https://modelcontextprotocol.io/) and use their tools as first-class coda skills. Each MCP server becomes a separate skill with tools namespaced as `mcp_{serverName}_{toolName}`.

**Supported Transports:**
- **stdio** — Local process execution (for official MCP servers like `@modelcontextprotocol/server-filesystem`)
- **http** — Remote HTTP endpoints (for containerized/remote MCP services)

**Example Tools** (from `@modelcontextprotocol/server-filesystem`):
- `mcp_filesystem_read_file` — Read a file from the filesystem
- `mcp_filesystem_list_directory` — List directory contents
- `mcp_filesystem_search_files` — Search for files by pattern

### Setup

**Local stdio server:**

```yaml
mcp:
  servers:
    filesystem:
      enabled: true
      transport:
        type: stdio
        command: npx
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"]
      tool_blocklist: ["write_file", "delete_file"]  # Read-only mode
```

**Remote HTTP server:**

```yaml
mcp:
  servers:
    github:
      enabled: true
      transport:
        type: http
        url: https://mcp-github.example.com
        headers:
          Authorization: "Bearer ${GITHUB_TOKEN}"  # From env
      requires_confirmation: ["create_issue"]
```

**Docker container (same network):**

```yaml
mcp:
  servers:
    database:
      enabled: true
      transport:
        type: http
        url: http://mcp-database-service:8080
      tool_allowlist: ["query_read_only", "list_tables"]
```

### Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable this server |
| `transport.type` | `stdio\|http` | required | Transport type |
| `timeout_ms` | number | `30000` | Connection timeout |
| `tool_timeout_ms` | number | `60000` | Per-tool execution timeout |
| `tool_allowlist` | string[] | - | Only allow these tools |
| `tool_blocklist` | string[] | `[]` | Block these tools |
| `requires_confirmation` | string[] | `[]` | Tools requiring user approval |
| `sensitive_tools` | string[] | `[]` | Mark tools as sensitive (logged) |
| `max_response_size` | number | `100000` | Max response size (bytes) |

**Environment variable substitution** is supported in all string fields using `${VAR_NAME}` syntax.

### Security

- All MCP responses are wrapped in `<external_data>` tags with injection warnings
- Responses are truncated to `max_response_size` (default 100KB)
- Tools can be filtered at discovery time with allowlist/blocklist
- Dangerous operations can require user confirmation
- Always use HTTPS for remote URLs (except localhost/internal networks)

### Documentation

See [docs/mcp-integration.md](docs/mcp-integration.md) for complete documentation including:
- All configuration options
- Docker deployment examples
- Kubernetes configuration
- Security best practices
- Troubleshooting guide

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

## Interfaces

### Discord

The Discord interface supports file attachments for both inbound and outbound messages.

**Inbound file attachments:**
- Users can upload files (images, PDFs, documents, etc.) with their messages
- Files are downloaded to a temporary directory and made available to the LLM
- File metadata (name, size, MIME type, local path) is included in the message context
- Maximum file size: 25 MB per file (Discord default limit)
- Files are automatically cleaned up after processing

**Outbound file attachments:**
- Agent skills can generate output files (e.g., processed PDFs, reports, images)
- Files are automatically attached to the bot's response message
- Multiple files can be sent in a single response
- Files are sent along with the text response

**Example workflow:**
1. User uploads a PDF file in Discord with message "Extract text from this PDF"
2. LLM activates PDF skill, receives file location
3. LLM calls `code_execute` with Python script to process PDF
4. Docker container processes PDF and writes output to `/workspace/output/`
5. Output files are sent back to user as Discord attachments

### Slack

The Slack interface supports file attachments for both inbound and outbound messages.

**Inbound file attachments:**
- Users can upload files with their messages
- Files are downloaded using Slack's private download URLs with bot token authorization
- File metadata is included in message context
- Maximum file size: 25 MB per file
- Temporary files are cleaned up after processing

**Outbound file attachments:**
- Output files are uploaded to the same channel/thread using `files.uploadV2` API
- Requires `files:write` OAuth scope for the Slack bot
- Multiple files can be uploaded in response to a single message

**OAuth scopes required:**
- `app_mentions:read` — Read mentions
- `chat:write` — Send messages
- `files:read` — Download user-uploaded files
- `files:write` — Upload response files
- `reactions:write` — Add reaction indicators

**Example workflow:**
1. User uploads a document in Slack thread
2. Bot downloads file using `url_private_download` with authorization
3. LLM processes file (e.g., via agent skill with code execution)
4. Bot uploads result file(s) to the same thread using `files.uploadV2`
