# n8n Skill

Access data ingested from n8n workflows. Accepts any event type — emails, calendar events, GitHub PRs, server alerts, customer signups, Slack messages, or anything else you can automate in n8n. No code changes required to add new event types.

## Architecture

```
n8n workflows → Webhook Service (port 3001) → Redis Streams → n8n Skill → PostgreSQL
                                                                  ↓
                                                        LLM queries via tools
```

1. You define an event type in n8n (any string: `"email"`, `"github_pr"`, `"server_alert"`)
2. n8n sends it to the webhook at `POST /n8n-ingest`
3. The webhook validates, sanitizes, and publishes to the Redis event stream
4. The n8n skill subscribes to `n8n.*` events and stores them in PostgreSQL
5. The LLM queries stored events using the tools below

## Tools

### `n8n_query_events`

Query events with flexible filtering. Primary tool for morning briefings and on-demand queries.

| Parameter          | Type       | Required | Description                                                       |
|--------------------|------------|----------|-------------------------------------------------------------------|
| `types`            | `string[]` | No       | Filter by event types (e.g., `["email", "github_pr"]`)            |
| `categories`       | `string[]` | No       | Filter by categories (see below)                                  |
| `tags`             | `string[]` | No       | Filter by tags (events must have ALL specified tags)               |
| `hours_back`       | `number`   | No       | Hours to look back (default: 12)                                  |
| `only_unprocessed` | `boolean`  | No       | Only unprocessed events (default: true)                           |
| `min_priority`     | `string`   | No       | Minimum priority: `"high"`, `"normal"`, or `"low"`                |
| `source_workflow`  | `string`   | No       | Filter by n8n workflow name                                       |

### `n8n_get_summary`

Statistical overview of events by type, category, priority, and workflow.

| Parameter          | Type      | Required | Description                             |
|--------------------|-----------|----------|-----------------------------------------|
| `hours_back`       | `number`  | No       | Hours to look back (default: 24)        |
| `only_unprocessed` | `boolean` | No       | Only count unprocessed events (default: true) |

### `n8n_list_event_types`

Discover what event types exist in the system.

| Parameter    | Type     | Required | Description                                |
|--------------|----------|----------|--------------------------------------------|
| `hours_back` | `number` | No       | Hours to look back (default: 168 = 1 week) |

### `n8n_mark_processed`

Mark events as processed/read after the user has seen them.

| Parameter   | Type       | Required | Description                         |
|-------------|------------|----------|-------------------------------------|
| `event_ids` | `number[]` | Yes      | Array of event IDs to mark as processed |

## Configuration

No configuration required. The n8n skill is always available.

The webhook service requires one environment variable:

```bash
# In .env (generate with: openssl rand -base64 32)
N8N_WEBHOOK_SECRET=your-secret-here
```

## Event Categories

Standard categories for organizing events:

| Category        | Use For                                  |
|-----------------|------------------------------------------|
| `communication` | Emails, messages, calls, notifications   |
| `calendar`      | Meetings, events, reminders              |
| `system`        | Alerts, metrics, logs, monitoring        |
| `business`      | Sales, signups, revenue, customers       |
| `development`   | PRs, deployments, builds, releases       |
| `monitoring`    | Uptime, performance, health checks       |
| `custom`        | Anything else (default if omitted)       |

## Webhook Payload Schema

POST to `http://<host>:3001/n8n-ingest` with header `x-webhook-secret: <secret>`:

```json
{
  "type": "your_event_type",
  "category": "system",
  "priority": "high",
  "tags": ["tag1", "tag2"],
  "source_workflow": "My n8n Workflow",
  "metadata": {
    "workflow_id": "123"
  },
  "data": {
    "title": "Something happened",
    "details": "More information here"
  }
}
```

| Field             | Type     | Required | Description                              |
|-------------------|----------|----------|------------------------------------------|
| `type`            | `string` | Yes      | Event type (any string, max 100 chars)   |
| `priority`        | `string` | Yes      | `"high"`, `"normal"`, or `"low"`         |
| `data`            | `object` | Yes      | Event payload (any structure)            |
| `category`        | `string` | No       | Category for grouping (see table above)  |
| `tags`            | `string[]` | No     | Searchable tags                          |
| `source_workflow` | `string` | No       | n8n workflow name/ID                     |
| `metadata`        | `object` | No       | Workflow metadata (not shown to user)    |
| `timestamp`       | `string` | No       | ISO 8601 timestamp (defaults to now)     |

## n8n Workflow Template

Use this Function node in any n8n workflow to format events:

```javascript
const EVENT_TYPE = 'your_event_type';
const CATEGORY = 'custom';

const sourceData = $input.item.json;

let priority = 'normal';
// Add your priority logic here

return {
  type: EVENT_TYPE,
  category: CATEGORY,
  priority: priority,
  tags: ['tag1'],
  source_workflow: $workflow.name,
  metadata: {
    workflow_id: $workflow.id,
    execution_id: $execution.id,
  },
  data: {
    // Your event data here
  }
};
```

Then add an HTTP Request node:
- **Method:** POST
- **URL:** `http://<coda-host>:3001/n8n-ingest`
- **Headers:** `x-webhook-secret: {{ $env.N8N_WEBHOOK_SECRET }}`
- **Body:** `{{ $json }}`

## Events Published

| Event Type                        | Severity   | When                                |
|-----------------------------------|------------|-------------------------------------|
| `n8n.<type>.received`             | varies     | Webhook receives an event           |
| `alert.n8n.<category>`           | `high`     | A high-priority event is received   |
| `n8n.events.processed`            | `low`      | Events are marked as processed      |

## Alert Routing

High-priority events are automatically published as alerts through the event bus. Configure alert rules in `config.yaml` to route them to Discord:

```yaml
alerts:
  rules:
    "alert.n8n.*":
      severity: "high"
      channels: ["discord"]
      quietHours: true
      cooldown: 300
```

## Security

- Webhook secret authentication via `x-webhook-secret` header
- Input sanitization (HTML entity escaping, prototype pollution prevention)
- Zod schema validation on all payloads
- Rate limiting (100 requests/minute per IP)
- Helmet security headers
- Content sanitization before LLM consumption via `ContentSanitizer`

## Example Conversations

```
User: "Good morning"
Assistant: [calls n8n_query_events with hours_back: 12, only_unprocessed: true]
  → "Overnight you received 3 emails, 2 GitHub PRs, and 1 server alert..."

User: "What GitHub PRs came in?"
Assistant: [calls n8n_query_events with types: ["github_pr"]]

User: "Any high priority events?"
Assistant: [calls n8n_query_events with min_priority: "high"]

User: "What kinds of events do I have?"
Assistant: [calls n8n_list_event_types]

User: "Show me everything from the Backup Monitor workflow"
Assistant: [calls n8n_query_events with source_workflow: "Backup Monitor"]

User: "Show me a summary of the last 24 hours"
Assistant: [calls n8n_get_summary with hours_back: 24]
```
