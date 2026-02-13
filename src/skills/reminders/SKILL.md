---
name: reminders
description: "Create, list, complete, and snooze reminders with natural language time parsing and recurring support."
---

# Reminders Skill

Create, list, complete, and snooze reminders with natural language time parsing and recurring support.

## Tools

### `reminder_create`

Create a new reminder with natural language time.

| Parameter     | Type     | Required | Description                                                                 |
|---------------|----------|----------|-----------------------------------------------------------------------------|
| `title`       | `string` | Yes      | What to be reminded about                                                   |
| `time`        | `string` | Yes      | When to remind (natural language: "in 2 hours", "tomorrow at 3pm", "every Monday at 9am") |
| `description` | `string` | No       | Additional details                                                          |

Supports:
- **Relative times:** "in 2 hours", "in 30 minutes", "in 3 days"
- **Absolute times:** "tomorrow at 9am", "Friday at 3pm", "March 15 at noon"
- **Recurring:** "every Monday at 9am", "every day at 8pm", "every weekday at 10am"

### `reminder_list`

List reminders filtered by status.

| Parameter | Type     | Required | Description                                    |
|-----------|----------|----------|------------------------------------------------|
| `status`  | `string` | No       | `"pending"`, `"completed"`, or `"all"` (default: `"pending"`) |
| `limit`   | `number` | No       | Max results (default: 20)                      |

### `reminder_complete`

Mark a reminder as completed. If the reminder is recurring, automatically creates the next occurrence.

| Parameter | Type     | Required | Description                  |
|-----------|----------|----------|------------------------------|
| `id`      | `string` | Yes      | The UUID of the reminder     |

### `reminder_snooze`

Snooze a reminder to a later time.

| Parameter | Type     | Required | Description                                          |
|-----------|----------|----------|------------------------------------------------------|
| `id`      | `string` | Yes      | The UUID of the reminder                             |
| `until`   | `string` | Yes      | When to re-remind (natural language, e.g., "in 15 minutes") |

## Configuration

No configuration required. Optional settings in `config.yaml`:

```yaml
reminders:
  timezone: "America/New_York"       # Timezone for time parsing (default: America/New_York)
  check_interval_seconds: 60         # How often to check for due reminders (default: 60)
  default_snooze_minutes: 15         # Default snooze duration (default: 15)
```

## Background Behavior

The reminders skill runs a background checker (via the task scheduler or `setInterval` fallback) that:

1. Scans for reminders past their due time
2. Publishes `alert.reminder.due` events for each due reminder
3. These events are routed through the alert system to Discord
4. Tracks notified reminders in Redis to avoid duplicate alerts (1-hour TTL)
5. Respects snooze times

## Events Published

| Event Type            | Severity | When                         |
|-----------------------|----------|------------------------------|
| `alert.reminder.due`  | `medium` | A reminder reaches its due time |

## Storage

Reminders are stored in the `reminders` PostgreSQL table with fields for due time, recurring pattern, status, and snooze state.

## Example Conversations

```
User: "Remind me to call the dentist tomorrow at 2pm"
Assistant: [calls reminder_create with title: "Call the dentist", time: "tomorrow at 2pm"]

User: "Remind me every Monday at 9am to submit my timesheet"
Assistant: [calls reminder_create with title: "Submit timesheet", time: "every Monday at 9am"]

User: "What reminders do I have?"
Assistant: [calls reminder_list with status: "pending"]

User: "Snooze that dentist reminder for 30 minutes"
Assistant: [calls reminder_snooze with id and until: "in 30 minutes"]
```
