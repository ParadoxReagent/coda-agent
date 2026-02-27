# Self-Improvement Manual Testing

How to manually trigger the self-improvement feature without waiting for scheduled crons.

## Prerequisites

Ensure `config/config.yaml` has:

```yaml
self_improvement:
  enabled: true
  executor_enabled: true  # required for Phase 2 (code execution)
```

For PR creation, also enable:

```yaml
mcp:
  servers:
    github:
      enabled: true
```

And set `GITHUB_TOKEN` in `.env`.

## Two-Phase Flow

### Phase 1 — Generate Proposals (Reflection)

Send a chat message to the bot to invoke any of these tools:

| Tool | Chat prompt example | What it does |
|---|---|---|
| `improvement_trigger_reflection` | "trigger a self-improvement reflection" | Analyzes recent audit data with Opus LLM, generates improvement proposals |
| `gap_detection_trigger` | "trigger gap detection" | Analyzes 30 days of audit data for capability gaps |
| `few_shot_harvest_trigger` | "trigger few-shot harvest" | Harvests patterns from high-scoring recent interactions |

Then review and approve proposals:

```
"list improvement proposals"
"list improvement proposals with status approved"
"approve proposal <id>"
"reject proposal <id>"
```

> All tier-3 tools prompt for user confirmation before executing.

### Phase 2 — Execute Approved Proposals (Code Fixes)

| Tool | Chat prompt example | What it does |
|---|---|---|
| `self_improvement_run` | "run self-improvement" | Picks the highest-priority approved proposal, generates a code fix, runs tests in Docker sandbox, opens a PR if tests pass |
| `self_improvement_run` (targeted) | "run self-improvement on proposal <id>" | Targets a specific proposal instead of auto-selecting |
| `self_improvement_status` | "self-improvement status" | Check progress of the current run |
| `self_improvement_history` | "show self-improvement history" | View past runs from the DB |

> `self_improvement_run` fires asynchronously — use `self_improvement_status` to poll progress.

## Typical Manual Test Flow

1. Ask bot: *"trigger a self-improvement reflection"* → confirm when prompted
2. Ask bot: *"list improvement proposals"*
3. Ask bot: *"approve proposal \<id\>"* → confirm when prompted
4. Ask bot: *"run self-improvement on proposal \<id\>"* → confirm when prompted
5. Ask bot: *"self-improvement status"* (repeat until done)
6. Check GitHub for the opened PR

## Scheduled Triggers (for reference)

The crons that normally fire these automatically:

| Cron name | Default schedule | What it runs |
|---|---|---|
| `self-improvement.weekly_reflection` | Sunday 3 AM | `improvement_trigger_reflection` |
| `self-improvement.monthly_gap_detection` | 1st of month 2 AM | `gap_detection_trigger` |
| `self-improvement-executor.self_improvement_execution` | Monday 2 AM | `self_improvement_run` |

Use the `scheduler_list` and `scheduler_toggle` tools to inspect or disable these.

## Source Files

- Detection/reflection skill: `src/skills/self-improvement/skill.ts`
- Execution skill: `src/skills/self-improvement-executor/skill.ts`
- Wiring in: `src/main.ts` (lines ~325–549)
