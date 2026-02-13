---
name: memory
description: "Save and retrieve information by meaning using semantic vector embeddings."
---

# Memory Skill

Save and retrieve information by meaning using semantic vector embeddings.

## Tools

### `memory_save`

Save information to long-term memory. The LLM uses this to remember facts, preferences, events, or conversation details.

| Parameter | Type | Required | Description |
|-----------|----------|----------|----------------------------------------------|
| `content` | `string` | Yes | The information to remember |
| `content_type` | `string` | Yes | One of: `conversation`, `fact`, `preference`, `event`, `note` |
| `tags` | `string[]` | No | Tags for categorization |
| `importance` | `number` | No | 0.0 to 1.0 (default: 0.5) |

### `memory_search`

Semantic search — finds memories by meaning, not just keywords.

| Parameter | Type | Required | Description |
|-----------|------------|----------|----------------------------------------|
| `query` | `string` | Yes | Describe what you're looking for |
| `content_types` | `string[]` | No | Filter by content types |
| `tags` | `string[]` | No | Filter by tags |
| `limit` | `number` | No | Max results (default: 10) |

### `memory_context`

Get assembled context from relevant memories within a token budget.

| Parameter | Type | Required | Description |
|-----------|----------|----------|--------------------------------------|
| `query` | `string` | Yes | Topic to get context for |
| `max_tokens` | `number` | No | Token budget (default: 1500) |

### `memory_list`

List recent memories, optionally filtered.

| Parameter | Type | Required | Description |
|-----------|----------|----------|-------------------------------|
| `content_type` | `string` | No | Filter by content type |
| `tag` | `string` | No | Filter by tag |
| `limit` | `number` | No | Max results (default: 20) |

### `memory_delete`

Soft-delete (archive) a memory by ID.

| Parameter | Type | Required | Description |
|-----------|----------|----------|--------------------------|
| `id` | `string` | Yes | The UUID of the memory |

## Configuration

**Required.** The memory skill only registers if an API key is configured.

```yaml
memory:
  base_url: "http://memory-service:8010"   # Memory service URL
  api_key: "your-secret-key"               # Shared API key
  context_injection:
    enabled: true                          # Auto-inject memories into system prompt
    max_tokens: 1500                       # Token budget for injected context
```

### Environment Variable Overrides

| Variable | Description |
|---|---|
| `MEMORY_API_KEY` | Memory service API key |
| `MEMORY_SERVICE_URL` | Memory service base URL |

## How It Works

1. When `memory_save` is called, the content is sent to the Python memory service
2. The service generates a 384-dimensional embedding using `all-MiniLM-L6-v2`
3. The embedding and content are stored in PostgreSQL via pgvector
4. When `memory_search` is called, the query is embedded and compared via cosine similarity
5. Results are ranked by a combined score (similarity + importance + recency + access frequency)

## Context Injection

Relevant memories are automatically injected into the system prompt for each conversation turn. This means the LLM can reference past information without explicitly searching. Results are cached for 5 minutes.

## Example Conversations

```
User: "I'm allergic to shellfish, please remember that"
Assistant: [calls memory_save with content: "User is allergic to shellfish",
            content_type: "fact", tags: ["health", "allergy"], importance: 0.9]
  → "I've saved that to my memory. I'll remember your shellfish allergy."

User: "What do you know about my dietary restrictions?"
Assistant: [calls memory_search with query: "dietary restrictions allergies food"]
  → "Based on my memory, you're allergic to shellfish."

User: "My favorite programming language is Rust"
Assistant: [calls memory_save with content: "User's favorite programming language is Rust",
            content_type: "preference", tags: ["coding"], importance: 0.6]
  → "Noted — I'll remember you prefer Rust."

User: "What do I like to code in?"
  → (context injection surfaces the Rust preference automatically)
  → "You've mentioned that Rust is your favorite programming language."

User: "Show me what you've remembered about me"
Assistant: [calls memory_list]
  → Lists all stored memories with content types and tags.

User: "Delete the memory about shellfish"
Assistant: [calls memory_delete with id: "..."]
  → "Memory archived. I won't reference your shellfish allergy anymore."
```
