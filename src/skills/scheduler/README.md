# Scheduler Skill

List and manage scheduled background tasks via conversational commands.

## Prerequisites

- **Redis** — the core `TaskScheduler` uses Redis for state

The scheduler skill itself is a thin wrapper that exposes the core scheduler to the LLM. Other skills (email, reminders) register their own cron tasks with the scheduler automatically during startup.

## Configuration

Add a `scheduler:` section to `config/config.yaml` to pre-configure task states:

```yaml
scheduler:
  tasks:
    email.poll:
      cron: "*/5 * * * *"
      enabled: true
    reminders.check:
      cron: "* * * * *"
      enabled: true
```

This section is optional. Tasks registered by skills at startup will use their own defaults if no scheduler config is present.

## Tools

### `scheduler_list`

List all registered scheduled tasks with their status, next run time, and last result. Takes no parameters.

Returns for each task:

| Field | Description |
|---|---|
| `name` | Full task name (e.g. `email.poll`, `reminders.check`) |
| `cron` | Cron expression |
| `description` | Human-readable description |
| `enabled` | Whether the task is currently active |
| `lastRun` | ISO 8601 timestamp of last execution |
| `lastResult` | `"success"` or `"error"` with message |
| `lastDurationMs` | Execution time in milliseconds |
| `nextRun` | ISO 8601 timestamp of next scheduled run |

### `scheduler_toggle`

Enable or disable a scheduled task.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `task_name` | string | yes | Full task name (e.g. `email.poll`, `reminders.check`) |
| `enabled` | boolean | yes | `true` to enable, `false` to disable |

This tool **requires user confirmation** before executing.

State changes are published as audit events (`scheduler.task_toggled`) on the event bus.

## How Tasks Get Registered

Skills don't need to know about the scheduler config. During startup, if a scheduler is available, skills register their background work as cron tasks:

- **Email skill** registers `email.poll` — polls for new emails
- **Reminders skill** registers `reminders.check` — checks for due reminders

Task names are auto-prefixed with the skill name (e.g. a skill named `email` registering a task named `poll` becomes `email.poll`).

If the scheduler is not available, skills fall back to their own `setInterval` loops.
