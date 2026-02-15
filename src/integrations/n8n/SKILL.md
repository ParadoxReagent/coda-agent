---
name: n8n
description: "Access data ingested from n8n workflows. Accepts any event type from automation pipelines."
---

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

### Inbound Tools (Query n8n Events)

#### `n8n_query_events`

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

### Outbound Tools (Trigger n8n Webhooks)

#### `n8n_trigger_webhook`

Trigger a registered n8n webhook and return the response. Use to invoke n8n workflows that return data (e.g., "run my backup workflow", "check inventory status").

**Requires user confirmation before execution.**

| Parameter      | Type     | Required | Description                                      |
|----------------|----------|----------|--------------------------------------------------|
| `webhook_name` | `string` | Yes      | Name of the registered webhook to call (from config) |
| `payload`      | `object` | No       | Optional JSON payload to send with the request   |

**Response:**
```json
{
  "success": true,
  "webhook": "run_backup",
  "status": 200,
  "data": { /* sanitized response from n8n */ }
}
```

#### `n8n_list_webhooks`

List all registered n8n webhooks that can be triggered. Useful for discovering what workflows are available.

**No parameters required.**

**Response:**
```json
{
  "webhooks": [
    { "name": "run_backup", "description": "Triggers the nightly backup workflow" },
    { "name": "check_inventory", "description": "Returns current inventory levels" }
  ],
  "count": 2
}
```

## Configuration

### Inbound Events (n8n → coda)

No configuration required for inbound events. The n8n skill is always available.

The webhook service requires environment variables for authentication:

```bash
# Required: shared secret for webhook authentication
N8N_WEBHOOK_SECRET=your-secret-here  # Generate with: openssl rand -base64 32

# Optional: custom header name (defaults to x-webhook-secret)
N8N_WEBHOOK_HEADER_NAME=x-webhook-secret
```

### Outbound Webhooks (coda → n8n)

To enable the LLM to trigger n8n webhooks, add webhook definitions to `config.yaml`:

```yaml
n8n:
  default_timeout_ms: 30000  # Optional: default timeout for all webhooks
  webhooks:
    run_backup:
      url: "http://n8n:5678/webhook/run-backup"
      description: "Triggers the nightly backup workflow"
      auth:
        type: header
        name: "X-N8N-Auth"
        value: "my-shared-secret"
      timeout_ms: 60000  # Optional: override default timeout

    check_inventory:
      url: "http://n8n:5678/webhook/check-inventory"
      description: "Returns current inventory levels"
      auth:
        type: basic
        username: "coda"
        password: "secret123"

    deploy_staging:
      url: "https://n8n.example.com/webhook/deploy-staging"
      description: "Deploys latest code to staging environment"
      # No auth required for this webhook
```

**Webhook Configuration Fields:**

| Field         | Type     | Required | Description                                          |
|---------------|----------|----------|------------------------------------------------------|
| `url`         | `string` | Yes      | Full URL to the n8n webhook trigger                  |
| `description` | `string` | No       | Human-readable description shown to LLM              |
| `auth`        | `object` | No       | Authentication config (see below)                    |
| `timeout_ms`  | `number` | No       | Request timeout in milliseconds (default: 30000)     |

**Authentication Options (`auth` field):**

**Header Authentication** (recommended):
```yaml
auth:
  type: header
  name: "X-N8N-Auth"      # Custom header name
  value: "your-secret"     # Header value
```

**Basic Authentication**:
```yaml
auth:
  type: basic
  username: "user"
  password: "pass"
```

**Security Note:** The LLM references webhooks by name only. URLs, header names, and secrets are never exposed to the LLM and are only stored in the config file.

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

POST to `http://<host>:3001/n8n-ingest` with authentication header (default: `x-webhook-secret: <secret>`):

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

## n8n Workflow Templates

### Inbound Events (n8n sends data to coda)

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
- **Authentication:** Header Auth
  - **Name:** `x-webhook-secret` (or custom header name from `N8N_WEBHOOK_HEADER_NAME`)
  - **Value:** `{{ $env.N8N_WEBHOOK_SECRET }}`
- **Body:** `{{ $json }}`

### Outbound Webhooks (coda triggers n8n workflows)

To create an n8n workflow that can be triggered by the LLM:

1. **Add a Webhook Trigger node:**
   - **Webhook URL Path:** `run-backup` (or any unique identifier)
   - **HTTP Method:** POST
   - **Authentication:** Header Auth or Basic Auth (configure in coda `config.yaml`)

2. **Add your workflow logic:**
   - Process the incoming payload from `$json.payload`
   - Perform the desired automation (backup, deployment, query, etc.)

3. **Add a Respond to Webhook node:**
   - **Response Code:** 200
   - **Response Body:** Return any data you want the LLM to see
   ```json
   {
     "status": "success",
     "backup_id": "{{ $json.id }}",
     "timestamp": "{{ $now }}"
   }
   ```

4. **Register the webhook in `config.yaml`:**
   ```yaml
   n8n:
     webhooks:
       run_backup:
         url: "http://n8n:5678/webhook/run-backup"
         description: "Triggers the nightly backup workflow"
         auth:
           type: header
           name: "X-N8N-Auth"
           value: "your-shared-secret"
   ```

5. **Test it:**
   - Ask the LLM: "Run the backup workflow"
   - The LLM will call `n8n_trigger_webhook` with `webhook_name: "run_backup"`
   - n8n executes the workflow and returns the response

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

- **Inbound**: Webhook secret authentication via configurable header (default `x-webhook-secret`) with timing-safe comparison
- **Outbound**: Flexible authentication via header auth or HTTP basic auth
- Input sanitization (HTML entity escaping, prototype pollution prevention)
- Zod schema validation on all payloads
- Rate limiting (100 requests/minute per IP)
- Helmet security headers
- Content sanitization before LLM consumption via `ContentSanitizer`

## Example Conversations

### Inbound (Querying Events)

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

### Outbound (Triggering Webhooks)

```
User: "What workflows can you run?"
Assistant: [calls n8n_list_webhooks]
  → "I can trigger: run_backup (Triggers the nightly backup workflow),
     check_inventory (Returns current inventory levels),
     deploy_staging (Deploys latest code to staging)"

User: "Run the backup workflow"
Assistant: [prompts for confirmation]
User: [approves]
Assistant: [calls n8n_trigger_webhook with webhook_name: "run_backup"]
  → "Backup completed successfully. Backup ID: backup_20250215_143022"

User: "Check the inventory status"
Assistant: [prompts for confirmation]
User: [approves]
Assistant: [calls n8n_trigger_webhook with webhook_name: "check_inventory"]
  → "Current inventory: 1,234 items in stock, 45 items low, 3 items out of stock"

User: "Deploy to staging with build number 456"
Assistant: [prompts for confirmation]
User: [approves]
Assistant: [calls n8n_trigger_webhook with webhook_name: "deploy_staging",
           payload: { build_number: 456 }]
  → "Deployment started. Check status at: https://staging.example.com/deploys/456"
```
