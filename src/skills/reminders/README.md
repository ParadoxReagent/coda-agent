# Reminders Skill

Create, list, complete, and snooze reminders with natural language time parsing.

## Prerequisites

- **PostgreSQL** — stores reminders persistently
- **Redis** — tracks which reminders have already been notified (deduplication)

Database tables are managed by Drizzle migrations. Run `pnpm db:migrate` before first use.

## Configuration

Add a `reminders:` section to `config/config.yaml`:

```yaml
reminders:
  timezone: "America/New_York"       # default: America/New_York
  check_interval_seconds: 60         # how often to check for due reminders (default: 60)
  default_snooze_minutes: 15         # default: 15
```

All fields are optional — the defaults work out of the box as long as PostgreSQL and Redis are running.

## Tools

### `reminder_create`

Create a new reminder with natural language time parsing (powered by `chrono-node`).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `title` | string | yes | What to be reminded about |
| `time` | string | yes | When to be reminded (natural language) |
| `description` | string | | Additional details |

**Supported time expressions:**

- Relative: `in 2 hours`, `in 30 minutes`, `in 3 days`
- Absolute: `tomorrow at 9am`, `Friday at 3pm`, `March 15 at noon`
- Recurring: `every Monday at 9am`, `every day at 8pm`

Recurring reminders automatically create the next occurrence when completed.

### `reminder_list`

List reminders, optionally filtered by status.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `status` | string | `"pending"` | One of: `pending`, `completed`, `all` |
| `limit` | number | `20` | Max results to return |

### `reminder_complete`

Mark a reminder as completed.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | UUID of the reminder |

If the reminder is recurring, a new pending reminder is automatically created for the next occurrence.

### `reminder_snooze`

Snooze a reminder to a later time.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | UUID of the reminder |
| `until` | string | yes | When to be reminded again (natural language, e.g. `in 15 minutes`, `tomorrow morning`) |

## Background Checking

The skill checks for due reminders on a configurable interval. When a reminder is due:

1. An alert event (`alert.reminder.due`) is published to the event bus
2. The alert is routed through the alert pipeline to Discord/Slack
3. The reminder is marked as notified in Redis (1-hour TTL) to prevent duplicate alerts

If the scheduler skill is active, the check loop is registered as a cron task (`reminders.check`) and can be managed via `/scheduler`. Otherwise, it falls back to `setInterval`.
