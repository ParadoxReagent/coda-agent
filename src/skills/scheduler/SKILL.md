# Scheduler Skill

List and manage scheduled background tasks at runtime. Provides visibility and control over all cron-based tasks registered by other skills.

## Tools

### `scheduler_list`

List all scheduled tasks with their status, next run time, and last result. No parameters required.

Returns for each task:
- `name` — Full task name (e.g., `email.poll`, `reminders.check`)
- `cron` — Cron expression
- `description` — Human-readable description
- `enabled` — Whether the task is currently active
- `lastRun` — Timestamp of last execution
- `lastResult` — `"success"` or `"error"`
- `lastDurationMs` — How long the last run took
- `nextRun` — Timestamp of next scheduled execution

### `scheduler_toggle`

Enable or disable a scheduled task.

| Parameter   | Type      | Required | Description                                                   |
|-------------|-----------|----------|---------------------------------------------------------------|
| `task_name` | `string`  | Yes      | Full task name (e.g., `"email.poll"`, `"reminders.check"`)    |
| `enabled`   | `boolean` | Yes      | `true` to enable, `false` to disable                          |

**Requires confirmation:** This tool requires user confirmation before executing (the user must respond with `/confirm`).

## Configuration

No configuration required. The scheduler skill is always available.

Task schedules can be overridden in `config.yaml`:

```yaml
scheduler:
  tasks:
    "health.check":
      cron: "*/5 * * * *"    # Every 5 minutes
      enabled: true
```

## Built-in Tasks

These tasks are registered by coda-agent and other skills:

| Task Name         | Default Schedule | Source Skill | Description                    |
|-------------------|-----------------|--------------|--------------------------------|
| `health.check`    | `*/5 * * * *`   | system       | Periodic health check          |
| `email.poll`      | varies          | email        | Poll for new emails            |
| `reminders.check` | `*/1 * * * *`   | reminders    | Check for due reminders        |

## Events Published

| Event Type               | Severity | When                        |
|--------------------------|----------|-----------------------------|
| `scheduler.task_toggled` | `low`    | A task is enabled/disabled  |

## Example Conversations

```
User: "What background tasks are running?"
Assistant: [calls scheduler_list]
  → "3 tasks: health.check (every 5 min, enabled), email.poll (every 5 min, enabled), reminders.check (every 1 min, enabled)"

User: "Disable email polling"
Assistant: [calls scheduler_toggle with task_name: "email.poll", enabled: false]
  → "I'll disable email.poll. Please /confirm to proceed."

User: "Re-enable it"
Assistant: [calls scheduler_toggle with task_name: "email.poll", enabled: true]
```
