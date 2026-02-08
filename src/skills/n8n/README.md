# n8n Skill

Access data ingested from n8n workflows — emails, calendar events, alerts, and any custom event type.

This skill acts as the bridge between your [n8n](https://n8n.io) automation workflows and coda. n8n workflows push events into coda via the event bus, and this skill lets the LLM query, summarize, and manage those events.

## Prerequisites

- **PostgreSQL** — stores ingested events
- **n8n instance** — configured to POST events to coda's event bus

Database tables are managed by Drizzle migrations. Run `pnpm db:migrate` before first use.

## Configuration

The n8n skill requires no dedicated config section. It activates automatically and subscribes to `n8n.*` events on the event bus.

Events are ingested when your n8n workflows publish to the event bus (typically via an HTTP Request node pointing at coda's internal event API or through a shared Redis pub/sub channel).

### n8n Workflow Event Format

Events sent from n8n should include:

```json
{
  "type": "email",
  "category": "communication",
  "priority": "normal",
  "timestamp": "2025-03-15T10:30:00Z",
  "data": {
    "subject": "Weekly report",
    "from": "team@company.com",
    "body": "..."
  },
  "metadata": {},
  "tags": ["work", "reports"],
  "source_workflow": "email-digest"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | string | yes | Event type identifier (e.g. `email`, `github_pr`, `slack_message`) |
| `category` | string | | One of: `communication`, `calendar`, `system`, `business`, `development`, `monitoring`, `custom` |
| `priority` | string | yes | `high`, `normal`, or `low` |
| `timestamp` | string | yes | ISO 8601 timestamp |
| `data` | object | yes | Arbitrary event payload |
| `metadata` | object | | Extra metadata |
| `tags` | string[] | | Tags for filtering |
| `source_workflow` | string | | Name or ID of the originating n8n workflow |

Events with `priority: "high"` are automatically routed as alerts to Discord/Slack.

## Tools

### `n8n_query_events`

Query events with flexible filtering. The primary tool for morning briefings and checking specific event types.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `types` | string[] | all | Filter by event types (e.g. `["email", "github_pr"]`) |
| `categories` | string[] | all | Filter by categories |
| `tags` | string[] | | Events must have ALL specified tags |
| `hours_back` | number | `12` | How far back to look (1-168) |
| `only_unprocessed` | boolean | `true` | Only show unprocessed/unread events |
| `min_priority` | string | | Minimum priority: `high`, `normal`, or `low` |
| `source_workflow` | string | | Filter by n8n workflow name/ID |

### `n8n_get_summary`

Get a statistical overview of events — counts by type, category, priority, and workflow.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `hours_back` | number | `24` | How far back to look |
| `only_unprocessed` | boolean | `true` | Only count unprocessed events |

Useful for quick overviews (e.g. "how many new events do I have?") or discovering what types of data are flowing in.

### `n8n_list_event_types`

List all unique event types seen in a time window. Useful for discovering what kinds of events your n8n workflows are producing.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `hours_back` | number | `168` (1 week) | How far back to look |

### `n8n_mark_processed`

Mark events as processed/read after the user acknowledges them.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `event_ids` | number[] | yes | Array of event IDs to mark as processed |

## Security

All event data is passed through `ContentSanitizer` before being returned to the LLM, protecting against prompt injection via n8n workflow payloads.
