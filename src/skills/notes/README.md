# Notes Skill

Save, search, list, and delete personal notes with full-text search and tagging.

## Prerequisites

- **PostgreSQL** — stores notes with full-text search indexes

Database tables are managed by Drizzle migrations. Run `pnpm db:migrate` before first use.

## Configuration

Add a `notes:` section to `config/config.yaml`:

```yaml
notes:
  max_note_length: 10000       # default: 10000
  default_list_limit: 20       # default: 20
```

Both fields are optional. The skill works with no config as long as PostgreSQL is running.

## Tools

### `note_save`

Save a new note with optional title and tags.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `content` | string | yes | The note content |
| `title` | string | | Title (auto-generated from first ~50 chars if omitted) |
| `tags` | string[] | | Tags for categorization and filtering |

**Special tags:**

- `context:always` — notes with this tag are automatically included in every conversation's system prompt, giving the LLM persistent context about your preferences, instructions, or reference info.

### `note_search`

Search notes using PostgreSQL full-text search, optionally filtered by tags.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | yes | Search query (full-text) |
| `tags` | string[] | | Tags to filter results (AND logic) |
| `limit` | number | | Max results (default: 10) |

Results are ranked by relevance. Content is truncated to 200 characters in search results.

### `note_list`

List recent notes sorted by creation date (newest first).

| Parameter | Type | Default | Description |
|---|---|---|---|
| `tag` | string | | Filter by a single tag |
| `limit` | number | `20` | Max results to return |

Content is truncated to 100 characters in list results.

### `note_delete`

Delete a note by its ID.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | UUID of the note |

## Context Injection

Notes tagged with `context:always` are loaded at the start of every conversation and injected into the system prompt. Use this for:

- Personal preferences ("I prefer concise responses")
- Reference information ("My home network is 10.0.1.0/24")
- Standing instructions ("Always check my calendar before scheduling")
