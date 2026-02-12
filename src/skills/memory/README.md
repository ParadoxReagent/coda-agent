# Memory Skill

Save, search, and retrieve information by meaning using semantic vector embeddings. Unlike notes (keyword search), memory uses an embedding model to find information that is *similar* in meaning to your query — even when no keywords overlap.

## Prerequisites

- **PostgreSQL with pgvector** — the `pgvector/pgvector:pg16` Docker image (drop-in replacement for `postgres:16-alpine`)
- **Memory service** — a Python FastAPI microservice that runs the embedding model and handles vector operations

Both are included in the Docker Compose setup and require no manual installation.

## Architecture

```
┌──────────────┐     HTTP      ┌──────────────────┐
│  MemorySkill │ ───────────── │  memory-service   │
│  (TypeScript)│   /ingest     │  (Python/FastAPI) │
│              │   /search     │                   │
│              │   /context    │  sentence-        │
│              │   /memories   │  transformers     │
└──────────────┘               │  all-MiniLM-L6-v2 │
                               └────────┬─────────┘
                                        │ asyncpg
                               ┌────────▼─────────┐
                               │   PostgreSQL      │
                               │   pgvector        │
                               │   memories table  │
                               └──────────────────┘
```

The TypeScript skill is a thin client that forwards requests to the Python service. The Python service loads a sentence-transformers model (~80 MB), generates 384-dimensional embeddings, and stores/queries them in PostgreSQL via pgvector's HNSW index.

## Configuration

Add a `memory:` section to `config/config.yaml`:

```yaml
memory:
  base_url: "http://memory-service:8010"
  api_key: "your-secret-key"
  context_injection:
    enabled: true       # inject relevant memories into every conversation
    max_tokens: 1500    # token budget for injected context
```

The `api_key` is **required**. Without it, the memory skill will not register.

**Environment variable overrides:**

| Variable | Overrides |
|---|---|
| `MEMORY_API_KEY` | `memory.api_key` |
| `MEMORY_SERVICE_URL` | `memory.base_url` |

Add `MEMORY_API_KEY` to your `.env` file. The same key must also be set as an environment variable for the `memory-service` container (this is handled automatically in `docker-compose.yml`).

## Tools

### `memory_save`

Save information to long-term semantic memory. The LLM decides when something is worth remembering.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `content` | string | yes | The information to remember |
| `content_type` | string | yes | One of: `conversation`, `fact`, `preference`, `event`, `note` |
| `tags` | string[] | | Tags for categorization and filtering |
| `importance` | number | | 0.0 to 1.0 (default 0.5). Higher = more likely to surface in search. |

### `memory_search`

Semantic search — finds memories whose *meaning* is similar to the query, even without shared keywords.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | yes | Describe what you're looking for |
| `content_types` | string[] | | Filter by content types |
| `tags` | string[] | | Filter by tags |
| `limit` | number | | Max results (default: 10) |

### `memory_context`

Assemble a formatted context block from the most relevant memories, fitting within a token budget.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | yes | Topic to get context for |
| `max_tokens` | number | | Token budget (default: 1500) |

### `memory_list`

List recent memories, newest first.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `content_type` | string | | Filter by content type |
| `tag` | string | | Filter by tag |
| `limit` | number | | Max results (default: 20) |

### `memory_delete`

Soft-delete (archive) a memory by its ID. Archived memories are excluded from search results by default.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | UUID of the memory |

## Context Injection

When `context_injection.enabled` is `true` (the default), relevant memories are automatically injected into the system prompt at the start of every conversation turn. This means the LLM can reference previously stored information without the user or LLM needing to explicitly search.

The process:
1. The user's message is sent to the memory service as an embedding query
2. The top matching memories are assembled within the `max_tokens` budget
3. The assembled context is added to the system prompt under "Relevant memories:"
4. Results are cached in Redis for 5 minutes to avoid redundant embedding calls

This is similar to how `context:always` notes work, but memories are selected dynamically based on relevance to the current message.

## How It Differs From Notes

| Feature | Notes | Memory |
|---|---|---|
| Search method | Full-text keyword search (PostgreSQL tsvector) | Semantic vector similarity (pgvector) |
| Storage | Drizzle ORM in TypeScript | Python service with asyncpg |
| Auto-injection | Only `context:always` tagged notes | All memories, ranked by relevance |
| Use case | Explicit note-taking | LLM-driven information retention |
| Infrastructure | PostgreSQL only | PostgreSQL + Python service + embedding model |

Both can coexist. Notes are for explicit, user-driven storage. Memory is for the LLM to selectively remember information it encounters.

## Relevance Scoring

Search results are ranked by a combined score:

```
relevance = 0.60 * cosine_similarity
           + 0.25 * importance
           + 0.10 * temporal_decay(age_days)
           + 0.05 * access_bonus(access_count)
```

- **Cosine similarity** — how close the query embedding is to the memory embedding
- **Importance** — the 0-1 value set when saving the memory
- **Temporal decay** — recent memories score higher: `1 / (1 + age_days * 0.01)`
- **Access bonus** — frequently accessed memories get a small boost: `min(0.1, count * 0.01)`

## Events

The memory skill publishes events to the event bus:

| Event | Severity | When |
|---|---|---|
| `memory.saved` | low | A new memory is stored |
| `memory.searched` | low | A search query is executed |
| `memory.deleted` | low | A memory is archived |

## Docker Setup

The memory service is included in `docker-compose.yml` and starts automatically. It:

- Builds from `./services/memory/Dockerfile`
- Downloads the embedding model at build time (baked into the image)
- Runs on the internal network only (no exposed ports)
- Has a 2 GB memory limit (for the embedding model)
- Health checks via `GET /health` on port 8010
- Start period of 30 seconds (model loading time)

No manual setup is needed beyond setting `MEMORY_API_KEY` in `.env`.

## Troubleshooting

### Memory skill not registering

Check that `MEMORY_API_KEY` is set in `.env`. The skill requires an API key to register.

### Memory service unhealthy

Check logs with `docker compose logs memory-service`. Common issues:
- Model download failed during build — rebuild with `docker compose build memory-service`
- Database connection failed — ensure postgres is healthy first
- Out of memory — the embedding model needs ~500 MB RAM; the container limit is 2 GB

### Searches return no results

- Verify memories exist: use `memory_list` to check
- The minimum similarity threshold is 0.3 by default — very different queries won't match
- Ensure the memory service is running and healthy: `docker compose ps`
