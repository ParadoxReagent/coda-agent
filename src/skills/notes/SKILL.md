---
name: notes
description: "Save, search, list, and delete personal notes with full-text search and tagging."
---

# Notes Skill

Save, search, list, and delete personal notes with full-text search and tagging.

## Tools

### `note_save`

Save a new note with optional title and tags.

| Parameter | Type       | Required | Description                                                              |
|-----------|------------|----------|--------------------------------------------------------------------------|
| `content` | `string`   | Yes      | The note content                                                         |
| `title`   | `string`   | No       | Title for the note. Auto-generated from first ~50 chars if omitted.      |
| `tags`    | `string[]` | No       | Tags for categorization (e.g., `["work", "project-x"]`)                  |

**Special tag:** Use `context:always` to include the note in every LLM conversation as persistent context. This is useful for preferences, instructions, or facts the assistant should always know.

### `note_search`

Full-text search across all notes using PostgreSQL `tsvector`.

| Parameter | Type       | Required | Description                             |
|-----------|------------|----------|-----------------------------------------|
| `query`   | `string`   | Yes      | Search query for full-text search       |
| `tags`    | `string[]` | No       | Filter results to notes with these tags |
| `limit`   | `number`   | No       | Max results (default: 10)               |

### `note_list`

List recent notes sorted by creation date (newest first).

| Parameter | Type     | Required | Description                  |
|-----------|----------|----------|------------------------------|
| `tag`     | `string` | No       | Filter to notes with this tag|
| `limit`   | `number` | No       | Max results (default: 20)    |

### `note_delete`

Delete a note by its UUID.

| Parameter | Type     | Required | Description              |
|-----------|----------|----------|--------------------------|
| `id`      | `string` | Yes      | The UUID of the note     |

## Configuration

No configuration required. The notes skill is always available.

Optional settings in `config.yaml`:

```yaml
notes:
  max_note_length: 10000    # Max characters per note
  default_list_limit: 20    # Default limit for note_list
```

## Storage

Notes are stored in the `notes` PostgreSQL table with:
- Full-text search via `tsvector` column (automatically maintained)
- Array-based tag filtering
- Indexed by user ID and tags

## Example Conversations

```
User: "Remember that my favorite coffee shop is Blue Bottle on Main Street"
Assistant: [calls note_save with content and tags: ["preference"]]

User: "Save a note that the API deadline is March 15th"
Assistant: [calls note_save with title: "API Deadline" and tags: ["work", "deadline"]]

User: "What did I note about the API?"
Assistant: [calls note_search with query: "API"]

User: "Always address me as Mike"
Assistant: [calls note_save with content: "User prefers to be called Mike" and tags: ["context:always"]]
```
