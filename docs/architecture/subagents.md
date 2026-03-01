# Sub-Agent System

The sub-agent system enables coda to delegate tasks to isolated background workers that run in parallel with the main conversation. Sub-agents have scoped tool access, token budgets, and full lifecycle management.

---

## Overview

The system supports two delegation modes:

| Mode | Tool | Use Case | Blocking? |
|------|------|----------|-----------|
| **Synchronous** | `delegate_to_subagent` | Quick tasks (1-3 tool calls) | Yes — result returned in same turn |
| **Asynchronous** | `sessions_spawn` | Longer research or analysis | No — result announced when complete |

Both modes instantiate a `BaseAgent` — the same unified agentic loop abstraction used throughout coda — with an isolated context, scoped tools, and configurable resource limits.

---

## Architecture

```
User message -> Orchestrator (main agent)
  -> LLM decides to use subagent tools:

  Path A (sync): delegate_to_subagent(task, tools_needed)
    -> Instantiate BaseAgent with scoped tools
    -> Run to completion (120s timeout)
    -> Sanitize output, return to LLM in same turn
    -> BaseAgent instance garbage collected

  Path B (async): sessions_spawn(task, options)
    -> SubagentManager.spawn()
    -> Validate limits (rate, concurrency, recursion)
    -> Return { status: "accepted", runId } immediately
    -> Background: instantiate BaseAgent, run to completion
    -> Sanitize output, announce to channel via callback
```

### Key Components

| Component | File | Role |
|-----------|------|------|
| `BaseAgent` | `src/core/base-agent.ts` | Unified agentic loop with scoped tool access |
| `SubagentManager` | `src/core/subagent-manager.ts` | Lifecycle: spawn, track, timeout, cancel, cleanup |
| `SubagentSkill` | `src/skills/subagents/skill.ts` | Skill wrapper exposing tools to the LLM |
| `ContentSanitizer` | `src/core/sanitizer.ts` | Output sanitization for subagent results |

---

## Configuration

Add a `subagents` section to your `config.yaml`. All values have sensible defaults — the section is optional.

```yaml
subagents:
  enabled: true                    # Master toggle (default: true)
  default_timeout_minutes: 5       # Async run default timeout
  max_timeout_minutes: 10          # Async run hard cap
  sync_timeout_seconds: 120        # Sync delegation timeout
  max_concurrent_per_user: 3       # Max active runs per user
  max_concurrent_global: 10        # Max active runs system-wide
  archive_ttl_minutes: 60          # How long completed runs stay in memory
  max_tool_calls_per_run: 25       # Safety limit per agent run
  default_token_budget: 50000      # Default cumulative token limit
  max_token_budget: 200000         # Hard cap for token budget
  spawn_rate_limit:
    max_requests: 10               # Max spawns per user per window
    window_seconds: 3600           # Rate limit window (1 hour)
  cleanup_interval_seconds: 60     # How often expired runs are cleaned up
```

If the `subagents` section is omitted entirely, the system uses the defaults shown above.

### Configuration Reference

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable the entire subagent system |
| `default_timeout_minutes` | number | `5` | Default timeout for async runs |
| `max_timeout_minutes` | number | `10` | Maximum timeout that can be requested |
| `sync_timeout_seconds` | number | `120` | Timeout for synchronous delegations |
| `max_concurrent_per_user` | number | `3` | Per-user concurrency limit |
| `max_concurrent_global` | number | `10` | System-wide concurrency limit |
| `archive_ttl_minutes` | number | `60` | Time before completed runs are cleaned from memory |
| `max_tool_calls_per_run` | number | `25` | Max tool calls a single subagent can make |
| `default_token_budget` | number | `50000` | Default cumulative token limit (input + output) |
| `max_token_budget` | number | `200000` | Hard cap — requested budgets are clamped to this |
| `spawn_rate_limit.max_requests` | number | `10` | Spawns allowed per window per user |
| `spawn_rate_limit.window_seconds` | number | `3600` | Rate limit window duration |
| `cleanup_interval_seconds` | number | `60` | Interval for sweeping expired runs from memory |

---

## Tools

The `SubagentSkill` exposes seven tools to the LLM. Three are marked `mainAgentOnly: true` and are automatically hidden from subagents to prevent recursive spawning.

### `delegate_to_subagent` (mainAgentOnly)

Synchronous delegation — runs a subagent and returns the result in the same conversation turn.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `task` | string | Yes | What the subagent should accomplish |
| `tools_needed` | string[] | Yes | Tool names the subagent needs (e.g. `["note_search"]`) |
| `worker_name` | string | No | Descriptive name for logging |
| `worker_instructions` | string | No | Custom system prompt for the subagent |

**Example usage by LLM:**
```json
{
  "task": "Search notes for any information about the Docker migration project",
  "tools_needed": ["note_search"],
  "worker_name": "notes-researcher"
}
```

### `sessions_spawn` (mainAgentOnly)

Async spawn — starts a background subagent and returns immediately with a run ID.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `task` | string | Yes | What the subagent should accomplish |
| `model` | string | No | Model ID override |
| `provider` | string | No | Provider name override |
| `timeout_minutes` | number | No | Timeout (default: 5, max: 10) |
| `allowed_tools` | string[] | No | Whitelist of tools the subagent can use |
| `blocked_tools` | string[] | No | Tools to explicitly exclude |

### `sessions_list`

List active subagent runs for the current user. No parameters.

### `sessions_stop` (mainAgentOnly, requiresConfirmation)

Stop a running subagent. Requires user confirmation.

**Parameters:** `run_id` (string, required)

### `sessions_log`

Get the execution transcript of a subagent run.

**Parameters:** `run_id` (string, required)

### `sessions_info`

Get detailed information about a subagent run (status, tokens used, timing, result preview).

**Parameters:** `run_id` (string, required)

### `sessions_send`

Send a message to a running subagent's message queue.

**Parameters:** `run_id` (string, required), `message` (string, required)

---

## Discord Slash Commands

The `/subagents` slash command provides direct access to subagent management:

| Command | Description |
|---------|-------------|
| `/subagents list` | List your active subagent runs |
| `/subagents stop <run_id>` | Stop a running subagent |
| `/subagents log <run_id>` | View execution transcript |
| `/subagents info <run_id>` | View run details (status, tokens, timing) |
| `/subagents send <run_id> <message>` | Send a message to a running subagent |

---

## BaseAgent

`BaseAgent` (`src/core/base-agent.ts`) is the unified agentic loop abstraction. Both the main orchestrator's tool-use loop and subagent runs are powered by the same class.

### Configuration

```typescript
interface BaseAgentConfig {
  name: string;               // Descriptive name for logging
  systemPrompt: string;       // System prompt for the LLM
  provider: LLMProvider;      // Which LLM provider to use
  model: string;              // Model ID
  allowedSkills?: string[];   // Whitelist of skill names (undefined = all)
  blockedTools?: string[];    // Explicit tool blocklist
  isSubagent: boolean;        // When true, mainAgentOnly tools are excluded
  maxToolCalls: number;       // Safety limit per run
  toolExecutionTimeoutMs: number; // Per-tool execution timeout
  maxTokenBudget?: number;    // Cumulative token limit (input + output)
  abortSignal?: AbortSignal;  // External cancellation
  maxResponseTokens?: number; // Max tokens per LLM response (default: 4096)
}
```

### Tool Scoping

When a `BaseAgent` is constructed, it resolves its tool list from `SkillRegistry.getToolDefinitions()` with three filters applied in order:

1. **`allowedSkills`** — Only include tools from these skill names (e.g. `["notes"]` includes `note_search`, `note_save`, etc.)
2. **`blockedTools`** — Remove specific tools by name
3. **`isSubagent: true`** — Auto-exclude all tools marked with `mainAgentOnly: true`

This means a subagent created with `allowedSkills: ["notes"]` only sees notes tools, and never sees spawn/delegate tools regardless of what's requested.

### Lifecycle

1. `new BaseAgent(config, skills, logger)` — resolves tools, ready to run
2. `agent.run(input)` — executes the agentic loop:
   - Sends input + system prompt to LLM
   - If LLM returns tool calls, executes them via `SkillRegistry`
   - Feeds results back to LLM
   - Repeats until LLM returns a final text response or limits are hit
   - Checks `abortSignal` between iterations
   - Tracks cumulative tokens against `maxTokenBudget`
   - Records all turns in transcript
3. Returns `AgentRunResult` with text, token totals, tool call count, and transcript

---

## Security

### Recursive Spawn Prevention

Subagents cannot spawn other subagents. This is enforced at two layers:

1. **Declarative (`mainAgentOnly: true`)**: The `sessions_spawn` and `delegate_to_subagent` tools are marked `mainAgentOnly`, so they are automatically filtered out of any subagent's tool list. The subagent LLM literally cannot see or call these tools.

2. **Runtime guard (`subagentRunId`)**: Even if a tool somehow reached execution, `SubagentManager.validateSpawn()` checks `getCurrentContext()?.subagentRunId`. If a subagent run ID is present in the correlation context, the spawn is rejected. This is defense-in-depth.

### User Isolation

All subagent operations validate ownership:
- `stopRun()` — only the user who spawned a run can stop it
- `getRunInfo()` / `getRunLog()` — only the owner can view run details
- `listRuns()` — only returns runs belonging to the requesting user
- `sendToRun()` — only the owner can send messages to a run

### Output Sanitization

All subagent output is processed through `ContentSanitizer.sanitizeSubagentOutput()`:
- HTML tags are escaped (`<script>` becomes `&lt;script&gt;`)
- Output is wrapped in `<subagent_result>` tags with an untrusted-data warning
- The orchestrator's system prompt instructs the LLM to treat `<subagent_result>` content as untrusted

### Resource Limits

| Limit | Default | Configurable |
|-------|---------|--------------|
| Spawn rate limit | 10 per hour per user | Yes |
| Per-user concurrency | 3 active runs | Yes |
| Global concurrency | 10 active runs | Yes |
| Async timeout | 5 minutes (max 10) | Yes |
| Sync timeout | 120 seconds | Yes |
| Tool calls per run | 25 | Yes |
| Token budget | 50,000 (max 200,000) | Yes |

### Tool Access Control

Tools marked `mainAgentOnly: true` are automatically hidden from subagents. The following tools have this flag:

- `sessions_spawn` — prevents recursive spawning
- `delegate_to_subagent` — prevents recursive delegation
- `sessions_stop` — subagents cannot manage other runs
- `calendar_create` — destructive action, main agent only
- `scheduler_toggle` — system control, main agent only
- Any tool with `requiresConfirmation: true` should also be `mainAgentOnly: true` to prevent subagents from triggering confirmation flows

---

## Events

The subagent system publishes events to the EventBus throughout the lifecycle:

| Event Type | Severity | When |
|------------|----------|------|
| `subagent.spawned` | low | Run accepted and queued |
| `subagent.running` | low | Execution started |
| `subagent.completed` | low | Run finished successfully |
| `subagent.failed` | medium | Run encountered an error |
| `subagent.timeout` | medium | Run exceeded its timeout |
| `subagent.cancelled` | low | Run was manually cancelled |

Event payloads include `runId`, `userId`, and context-specific data (token usage, duration, error message, etc.).

---

## Database Schema

The `subagent_runs` table in Postgres stores persistent records for audit and history:

```
subagent_runs (
  id            uuid PRIMARY KEY,
  user_id       varchar(255) NOT NULL,
  channel       varchar(50) NOT NULL,
  parent_run_id uuid,
  task          text NOT NULL,
  status        varchar(20) NOT NULL DEFAULT 'accepted',
  mode          varchar(10) NOT NULL DEFAULT 'async',
  model         varchar(255),
  provider      varchar(100),
  result        text,
  error         text,
  input_tokens  integer DEFAULT 0,
  output_tokens integer DEFAULT 0,
  tool_call_count integer DEFAULT 0,
  timeout_ms    integer NOT NULL,
  transcript    jsonb DEFAULT '[]',
  metadata      jsonb DEFAULT '{}',
  allowed_tools text[],
  blocked_tools text[],
  created_at    timestamptz DEFAULT now(),
  started_at    timestamptz,
  completed_at  timestamptz,
  archived_at   timestamptz
)

Indexes:
  - (user_id, status)
  - (created_at)
  - (status)
  - (parent_run_id)
```

Run `pnpm db:generate && pnpm db:migrate` after upgrading to apply the schema.

---

## How It Works End-to-End

### Synchronous Delegation Example

User says: "Check if I have any notes about the Docker migration"

1. Orchestrator sends message to LLM with all available tools
2. LLM calls `delegate_to_subagent` with `task: "Search notes about Docker migration"` and `tools_needed: ["note_search"]`
3. `SubagentSkill.execute()` routes to `SubagentManager.delegateSync()`
4. Manager validates: rate limit, concurrency, no recursion
5. Manager resolves `["note_search"]` to skills `["notes"]`
6. Manager creates a `BaseAgent` with `isSubagent: true`, `allowedSkills: ["notes"]`
7. `BaseAgent.run()` executes — LLM uses `note_search`, gets results, formulates response
8. Result is sanitized via `ContentSanitizer.sanitizeSubagentOutput()` and wrapped in `<subagent_result>` tags
9. Sanitized result returned to the main LLM, which incorporates it into the user-facing response

Total time: typically 2-10 seconds.

### Asynchronous Spawn Example

User says: "Research the latest Node.js release notes and summarize the key changes"

1. Orchestrator sends message to LLM
2. LLM calls `sessions_spawn` with `task: "Research latest Node.js release notes..."`
3. `SubagentSkill.execute()` routes to `SubagentManager.spawn()`
4. Manager validates limits, creates run record, returns `{ status: "accepted", runId: "abc123..." }`
5. LLM tells user: "I've started a background research task (run abc123). I'll announce the results when it's done."
6. Background: `setImmediate()` triggers `executeAsyncRun()`
7. A `BaseAgent` is created and runs to completion (or timeout)
8. On completion, `announceCallback` sends the sanitized result to the user's channel (Discord/Slack)
9. User sees: "**Sub-agent completed** (abc123)\n[results]"

---

## Adding `mainAgentOnly` to Your Skills

If you're writing a skill with tools that should not be available to subagents (destructive actions, system control, etc.), add `mainAgentOnly: true` to the tool definition:

```typescript
getTools(): SkillToolDefinition[] {
  return [
    {
      name: "my_safe_tool",
      description: "Read-only search",
      input_schema: { type: "object", properties: {} },
      // No flag — available to both main agent and subagents
    },
    {
      name: "my_dangerous_tool",
      description: "Deletes all records",
      input_schema: { type: "object", properties: {} },
      mainAgentOnly: true,  // Hidden from subagents
    },
  ];
}
```

As a general rule: any tool with `requiresConfirmation: true` should also have `mainAgentOnly: true`, since subagents cannot participate in the confirmation flow.

---

## File Reference

| File | Description |
|------|-------------|
| `src/core/base-agent.ts` | BaseAgent class — unified agentic loop |
| `src/core/subagent-manager.ts` | SubagentManager — lifecycle, validation, execution |
| `src/skills/subagents/skill.ts` | SubagentSkill — LLM tool definitions and routing |
| `src/core/sanitizer.ts` | ContentSanitizer.sanitizeSubagentOutput() |
| `src/core/correlation.ts` | RequestContext with subagentRunId |
| `src/skills/base.ts` | SkillToolDefinition with mainAgentOnly flag |
| `src/skills/registry.ts` | getToolDefinitions() with filtering support |
| `src/db/schema.ts` | subagentRuns table definition |
| `src/utils/config.ts` | SubagentConfigSchema (Zod) |
| `src/utils/retention.ts` | Subagent retention constants |
| `tests/unit/core/base-agent.test.ts` | BaseAgent unit tests |
| `tests/unit/core/subagent-manager.test.ts` | SubagentManager unit tests |
| `tests/unit/skills/subagents/skill.test.ts` | SubagentSkill unit tests |
| `tests/integration/subagent-lifecycle.test.ts` | Lifecycle integration tests |
| `tests/integration/subagent-security.test.ts` | Security integration tests |
