# Tool Catalog

Complete reference for all tools available in coda. ~66 static tools + dynamic MCP tools.

**Permission tiers:** 0 = read-only/safe · 1 = writes/side-effects · 2 = external/sensitive access · 3 = destructive/high-risk (requires user confirmation)

**Flags:** `mainAgentOnly` = not available to subagents · `sensitive` = input/output flagged in audit · `requiresCritique` = pre-execution Haiku safety review

---

## Quick Reference

| Tool | Skill | Tier | Flags | Description |
|------|-------|------|-------|-------------|
| `reminder_create` | Reminders | 1 | — | Create a reminder with natural language time ("in 2 hours", "every Monday 9am") |
| `reminder_list` | Reminders | 0 | — | List reminders filtered by status (pending/completed/all) |
| `reminder_complete` | Reminders | 1 | — | Mark a reminder done; auto-creates next if recurring |
| `reminder_snooze` | Reminders | 1 | — | Snooze a reminder with natural language offset |
| `note_save` | Notes | 1 | — | Save a note with optional title and tags (`context:always` injects into every conversation) |
| `note_search` | Notes | 0 | sensitive | Full-text search with optional tag filter |
| `note_list` | Notes | 0 | sensitive | List recent notes, optionally filtered by tag |
| `note_delete` | Notes | 1 | — | Delete a note by ID |
| `memory_save` | Memory | 1 | — | Save a fact, preference, or event to long-term semantic memory |
| `memory_search` | Memory | 0 | sensitive | Search memories by semantic meaning |
| `memory_context` | Memory | 0 | sensitive | Assembled context for a topic within a token budget |
| `memory_list` | Memory | 0 | sensitive | List recent memories, optionally filtered by type or tag |
| `memory_delete` | Memory | 1 | — | Soft-delete a memory by ID |
| `doctor_diagnose` | Doctor | 0 | mainAgentOnly | System diagnostic: skill health, provider status, recent errors, detected patterns |
| `doctor_reset_skill` | Doctor | 3 | mainAgentOnly | Reset a degraded skill to healthy (requires confirmation) |
| `scheduler_list` | Scheduler | 0 | — | List scheduled tasks with status, next run, and last result |
| `scheduler_toggle` | Scheduler | 3 | mainAgentOnly | Enable or disable a scheduled task (requires confirmation) |
| `audit_query` | Audit | 0 | mainAgentOnly | Query tool-call history filtered by tool, skill, status, or time window |
| `audit_stats` | Audit | 0 | mainAgentOnly | Aggregate stats: total calls, success rate, top tools, errors by tool |
| `task_create` | Tasks | 1 | — | Create a persistent multi-day task with ordered steps and optional schedule |
| `task_status` | Tasks | 0 | — | Get status of a task, or list all active tasks for current user |
| `task_advance` | Tasks | 1 | — | Mark current step done and advance to next; optionally schedule next action |
| `task_block` | Tasks | 1 | — | Mark a task as blocked with reason |
| `improvement_proposals_list` | Self-Improvement | 0 | mainAgentOnly | List improvement proposals by status (pending/approved/rejected/applied) |
| `improvement_proposal_decide` | Self-Improvement | 3 | mainAgentOnly | Approve or reject a proposal; approved prompt diffs auto-apply |
| `improvement_trigger_reflection` | Self-Improvement | 3 | mainAgentOnly | Manually trigger weekly Opus reflection cycle |
| `prompt_rollback` | Self-Improvement | 3 | mainAgentOnly | Roll back a prompt section to its previous version |
| `gap_detection_trigger` | Self-Improvement | 3 | mainAgentOnly | Trigger monthly capability gap detection (analyzes 30 days audit data) |
| `few_shot_harvest_trigger` | Self-Improvement | 3 | mainAgentOnly | Trigger few-shot pattern harvest from high-scoring interactions |
| `code_execute` | Docker Executor | 2 | sensitive | Run shell command in ephemeral Docker container with configurable image and limits |
| `browser_open` | Browser | 2 | — | Start isolated browser session in sandboxed container; returns `session_id` |
| `browser_navigate` | Browser | 2 | requiresCritique | Navigate to URL (SSRF-protected; private IPs blocked) |
| `browser_screenshot` | Browser | 1 | — | Screenshot current page; saves to temp file and returns path |
| `browser_get_content` | Browser | 1 | — | Accessibility snapshot with element refs for click/type |
| `browser_click` | Browser | 2 | — | Click element by ref from accessibility snapshot |
| `browser_type` | Browser | 2 | sensitive | Type text into a form field (may contain credentials) |
| `browser_evaluate` | Browser | 3 | — | Execute JavaScript in page context (requires confirmation) |
| `browser_close` | Browser | 0 | — | Destroy browser session and container |
| `delegate_to_subagent` | Subagents | 2 | mainAgentOnly | Delegate task to subagent synchronously; subagent has scoped tool access |
| `sessions_spawn` | Subagents | 2 | mainAgentOnly | Spawn background subagent asynchronously; returns immediately with run ID |
| `sessions_list` | Subagents | 0 | — | List active subagent runs |
| `sessions_stop` | Subagents | 3 | mainAgentOnly | Stop a running subagent (requires confirmation) |
| `sessions_log` | Subagents | 0 | — | Get execution transcript of a subagent run |
| `sessions_info` | Subagents | 0 | — | Detailed info for a subagent run (tokens, duration, status) |
| `sessions_send` | Subagents | 1 | — | Send a message to a running subagent |
| `specialist_spawn` | Subagents | 2 | mainAgentOnly | Delegate task to a named specialist agent (blocks until complete) |
| `specialist_list` | Subagents | 0 | mainAgentOnly | List available specialist agents with descriptions and tool lists |
| `skill_activate` | Agent Skills | 1 | — | Activate an agent skill by name; returns full instructions and resources |
| `skill_rescan` | Agent Skills | 1 | mainAgentOnly | Re-scan skill directories for new/removed skills without restart |
| `skill_read_resource` | Agent Skills | 0 | — | Read supplementary file from an activated skill (scripts/, references/, assets/) |
| `firecrawl_scrape` | Firecrawl | 1 | — | Scrape a URL and return clean markdown |
| `firecrawl_crawl` | Firecrawl | 2 | — | Start async site crawl; returns job ID |
| `firecrawl_crawl_status` | Firecrawl | 0 | — | Poll crawl job status and retrieve results |
| `firecrawl_map` | Firecrawl | 1 | — | Discover all URLs on a site, optionally filtered by search term |
| `firecrawl_search` | Firecrawl | 1 | — | Web search with content extraction from top results |
| `n8n_query_events` | n8n | 0 | — | Query ingested n8n events (types, categories, tags, time range) |
| `n8n_get_summary` | n8n | 0 | — | Statistical summary of n8n events (counts by type, category, priority, workflow) |
| `n8n_list_event_types` | n8n | 0 | — | List unique n8n event types seen in last N hours |
| `n8n_mark_processed` | n8n | 1 | — | Mark specific n8n events as processed/read |
| `n8n_trigger_webhook` | n8n | 3 | — | Trigger a registered n8n webhook (requires confirmation) |
| `n8n_list_webhooks` | n8n | 0 | — | List registered n8n webhooks that can be triggered |
| `weather_forecast` | Weather | 0 | — | Period forecast (Today, Tonight, Tomorrow…) via National Weather Service |
| `weather_current` | Weather | 0 | — | Current conditions from nearest observation station |
| `weather_alerts` | Weather | 0 | — | Active weather watches, warnings, and advisories for a location |
| `mcp_{server}_{tool}` | MCP | varies | — | Dynamically generated from MCP server definitions; see integrations_readme.md |

---

## Detailed Sections

### Reminders

Natural language time parsing via chrono-node. Background checker fires `alert.reminder.due` every 60 seconds.

| Tool | Tier | Description |
|------|------|-------------|
| `reminder_create` | 1 | Parse and schedule a reminder. Supports relative ("in 2h"), absolute ("Friday 3pm"), and recurring ("every Monday 9am") expressions. |
| `reminder_list` | 0 | Retrieve reminders. Status filter: `pending` (default), `completed`, or `all`. |
| `reminder_complete` | 1 | Mark done. If the reminder is recurring, the next occurrence is automatically created. |
| `reminder_snooze` | 1 | Push a pending reminder forward using a natural language offset (e.g., "in 15 minutes"). |

---

### Notes

Full-text search via PostgreSQL `tsvector`. Tag `context:always` to inject a note into every conversation as persistent context.

| Tool | Tier | Flags | Description |
|------|------|-------|-------------|
| `note_save` | 1 | — | Save note with optional `title` and `tags` array. Returns the new note ID. |
| `note_search` | 0 | sensitive | Full-text search across note content and title. Accepts optional `tag` filter. |
| `note_list` | 0 | sensitive | List up to N recent notes, newest first. Optional `tag` filter. |
| `note_delete` | 1 | — | Permanently delete a note by its UUID. |

---

### Memory

Semantic memory via pgvector + sentence-transformers. Relevant memories are automatically injected into every conversation via the memory service.

| Tool | Tier | Flags | Description |
|------|------|-------|-------------|
| `memory_save` | 1 | — | Save a fact, preference, event, conversation, or summary. Accepts `importance` (1–5) and `tags`. |
| `memory_search` | 0 | sensitive | Retrieve memories by semantic similarity to a query string. Optional `type` and `tag` filters. |
| `memory_context` | 0 | sensitive | Build assembled context for a topic within a `token_budget`. Useful for priming before long tasks. |
| `memory_list` | 0 | sensitive | List N recent memories. Optional `content_type` and `tag` filters. |
| `memory_delete` | 1 | — | Soft-delete (archive) a memory by its UUID. |

Requires `memory-service` container and `MEMORY_API_KEY` in `.env`.

---

### Doctor

System diagnostics and self-healing. Detects error patterns, repairs malformed LLM output, and resets degraded skills.

| Tool | Tier | Flags | Description |
|------|------|-------|-------------|
| `doctor_diagnose` | 0 | mainAgentOnly | Snapshot of system health: skill statuses, LLM provider availability, recent error patterns, recommendations. |
| `doctor_reset_skill` | 3 | mainAgentOnly | Clear the degraded/unavailable state for a named skill so it re-enters normal operation. Requires confirmation. |

---

### Scheduler

Cron-based task management. Skills register their own tasks at startup; overrides live in `config.yaml`.

| Tool | Tier | Flags | Description |
|------|------|-------|-------------|
| `scheduler_list` | 0 | — | All scheduled tasks: name, enabled state, cron expression, next run, last run result. |
| `scheduler_toggle` | 3 | mainAgentOnly | Enable or disable a task by name. Requires user confirmation. |

---

### Audit

Read-only introspection into the persistent `audit_log` table. Powers the weekly Opus reflection cycle.

| Tool | Tier | Flags | Description |
|------|------|-------|-------------|
| `audit_query` | 0 | mainAgentOnly | Filtered query: tool name, skill, `success`/`failure`, time window (last N hours). |
| `audit_stats` | 0 | mainAgentOnly | Aggregated view: total calls, success rate, top 10 tools by call count, error breakdown by tool. |

---

### Tasks (Long-Horizon Execution)

Persistent multi-day tasks with checkpointing and auto-resumption. Tasks survive restarts; a cron (default: every 15 min) sends resumption notifications.

| Tool | Tier | Description |
|------|------|-------------|
| `task_create` | 1 | Create a task with an ordered `steps` list and an optional `schedule` for the first action point. |
| `task_status` | 0 | Get detailed status of a task by ID, or list all active tasks for the current user. |
| `task_advance` | 1 | Complete the current step and move to the next. Optional `next_action_at` to schedule resumption. |
| `task_block` | 1 | Mark a task blocked with a `reason` and `blocker_type`. Task won't auto-resume until unblocked. |

---

### Self-Improvement

Weekly Opus reflection + prompt evolution. All tools are `mainAgentOnly`; write operations require confirmation (tier 3).

| Tool | Tier | Description |
|------|------|-------------|
| `improvement_proposals_list` | 0 | List proposals generated by reflection cycles. Filter by `status`: pending/approved/rejected/applied/all. |
| `improvement_proposal_decide` | 3 | Approve or reject a proposal by ID. Approved `prompt` proposals with a diff auto-apply when `prompt_evolution_enabled: true`. |
| `improvement_trigger_reflection` | 3 | Immediately run a full Opus reflection cycle (audit stats, self-assessments, routing patterns, current prompt). |
| `prompt_rollback` | 3 | Revert a prompt section to its previous version in `prompt_versions`. |
| `gap_detection_trigger` | 3 | Run the monthly capability gap detection analysis immediately (normally runs 1st of month at 2 AM). |
| `few_shot_harvest_trigger` | 3 | Run the few-shot harvest immediately — collects high-scoring (≥4) interactions into `solution_patterns`. |

**Background cycles:**
- Sunday 3 AM: Opus reflection → proposals
- Sunday 4 AM: LearnedTierClassifier retrain
- 1st of month 2 AM: Gap detection
- 1st of month 4 AM: Few-shot harvest
- Every turn: Haiku self-assessment (score 1–5)
- Tier ≥ 3 or `requiresCritique: true`: Haiku pre-execution critique

---

### Docker Executor

Sandboxed code execution in ephemeral containers. Used directly and by agent skills with `docker_image` frontmatter.

| Tool | Tier | Flags | Description |
|------|------|-------|-------------|
| `code_execute` | 2 | sensitive | Run a shell command in a whitelisted Docker image. Returns stdout, stderr, exit code, and any files written to `/workspace/output/`. |

**Security:** ephemeral (`--rm`), read-only root fs, no network by default, memory/CPU/PID limits, image whitelist. Must be explicitly enabled: `execution.enabled: true`.

---

### Browser Automation

Playwright in ephemeral Docker containers. Unlike Firecrawl, can interact with JS-rendered pages, click buttons, and fill forms. Network-isolated from coda internals.

| Tool | Tier | Flags | Description |
|------|------|-------|-------------|
| `browser_open` | 2 | — | Start a new isolated browser session. Returns `session_id`. Rate limited: 20 calls/hour. |
| `browser_navigate` | 2 | requiresCritique | Navigate to a URL. Blocks private IPs (SSRF protection). Critique checks alignment before execution. |
| `browser_screenshot` | 1 | — | Screenshot the current page. Optional `full_page: true` for full scroll height. |
| `browser_get_content` | 1 | — | Accessibility tree snapshot. Element `ref` values can be passed to `browser_click` / `browser_type`. |
| `browser_click` | 2 | — | Click an element by its `ref` from a prior `browser_get_content` call. |
| `browser_type` | 2 | sensitive | Type text into a field. Flagged sensitive — input logged as redacted in audit. |
| `browser_evaluate` | 3 | — | Arbitrary JavaScript execution in page context. Requires user confirmation. |
| `browser_close` | 0 | — | Destroy session and container. Always call this, even after errors. |

**Typical workflow:** `browser_open` → `browser_navigate` → `browser_get_content` → *(optional)* `browser_click` / `browser_type` → `browser_close`

**Setup:** `docker compose --profile browser-build build` then `browser.enabled: true` in config.

---

### Subagents

Run parallel or specialized sub-processes. All spawn/stop tools are `mainAgentOnly`.

| Tool | Tier | Flags | Description |
|------|------|-------|-------------|
| `delegate_to_subagent` | 2 | mainAgentOnly | Synchronous delegation — blocks until the subagent returns a result. Scoped tool allowlist. |
| `sessions_spawn` | 2 | mainAgentOnly | Asynchronous spawn — returns immediately with a `run_id` for polling. |
| `sessions_list` | 0 | — | List active subagent runs for the current user. |
| `sessions_stop` | 3 | mainAgentOnly | Terminate a running subagent by `run_id`. Requires confirmation. |
| `sessions_log` | 0 | — | Full execution transcript (tool calls + results) for a run. |
| `sessions_info` | 0 | — | Summary: status, tokens consumed, duration, tool call count. |
| `sessions_send` | 1 | — | Inject a message into a running subagent's context. |
| `specialist_spawn` | 2 | mainAgentOnly | Delegate to a pre-configured specialist agent (domain focus + tool allowlist from `src/agents/{name}/`). Synchronous. |
| `specialist_list` | 0 | mainAgentOnly | List loaded specialist agents with descriptions and allowed tools. |

**Built-in specialists:** `home` (30k tokens) · `research` (80k, includes browser tools) · `lab` (100k) · `planner` (40k)

---

### Agent Skills

Dynamic instruction-based skills loaded from `SKILL.md` files. No code required.

| Tool | Tier | Flags | Description |
|------|------|-------|-------------|
| `skill_activate` | 1 | — | Load a skill's full instructions into context by name. The LLM gains the skill's guidance for the rest of the turn. |
| `skill_rescan` | 1 | mainAgentOnly | Re-scan configured `agent_skill_dirs` for new or removed skills. Reports changes. |
| `skill_read_resource` | 0 | — | Read a file from an activated skill's `scripts/`, `references/`, or `assets/` directory. |

Send `/rescan-skills` to trigger `skill_rescan` from Discord.

---

### Firecrawl (Web Scraping)

Requires `FIRECRAWL_API_KEY`. See [integrations_readme.md](integrations_readme.md#firecrawl).

| Tool | Tier | Description |
|------|------|-------------|
| `firecrawl_scrape` | 1 | Scrape a single URL to clean markdown. Handles basic JS rendering, but not SPAs requiring user interaction. |
| `firecrawl_crawl` | 2 | Async crawl of a site. Returns `job_id` — poll with `firecrawl_crawl_status`. Set `limit` and `include_paths` to avoid runaway crawls. |
| `firecrawl_crawl_status` | 0 | Poll a crawl job. Returns completed pages or `status: "scraping"` while in progress. |
| `firecrawl_map` | 1 | Discover all reachable URLs on a site. Optional `search` filter narrows to relevant paths. |
| `firecrawl_search` | 1 | Web search with automatic content extraction from top N results. Best starting point for research tasks. |

**Prefer Firecrawl for read-only scraping; use browser tools when JS interaction is required.**

---

### n8n

Requires `N8N_WEBHOOK_URL` and an n8n instance with the coda webhook workflow active. See [integrations_readme.md](integrations_readme.md#n8n).

| Tool | Tier | Description |
|------|------|-------------|
| `n8n_query_events` | 0 | Query stored events with flexible filters: `event_types`, `categories`, `tags`, `since`, `until`, `limit`. |
| `n8n_get_summary` | 0 | Aggregated event counts grouped by type, category, priority, and workflow name. |
| `n8n_list_event_types` | 0 | Distinct event type strings seen in the last N hours (useful for building filters). |
| `n8n_mark_processed` | 1 | Mark a list of event IDs as processed so they're excluded from future queries. |
| `n8n_trigger_webhook` | 3 | POST to a registered webhook by name and optional payload. Requires user confirmation. |
| `n8n_list_webhooks` | 0 | All registered webhooks that can be triggered via `n8n_trigger_webhook`. |

---

### Weather

US National Weather Service API. No API key required. Location configured in `config.yaml`.

| Tool | Tier | Description |
|------|------|-------------|
| `weather_forecast` | 0 | Named period forecasts: Today, Tonight, Tomorrow, etc. Up to 7 days. |
| `weather_current` | 0 | Current conditions from the nearest NWS observation station (temperature, wind, humidity, sky). |
| `weather_alerts` | 0 | Active watches, warnings, and advisories (tornado, winter storm, flood, etc.) for the configured location. |

---

### MCP (Model Context Protocol)

Tools are generated dynamically at startup from server definitions in `config.yaml`. Naming pattern: `mcp_{server_name}_{tool_name}`.

```yaml
mcp:
  servers:
    - name: "filesystem"
      transport: "stdio"
      command: "npx"
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    - name: "github"
      transport: "http"
      url: "https://..."
```

Each server's tools appear in the agent's tool list as `mcp_filesystem_read_file`, `mcp_github_create_issue`, etc. Tiers and flags are inferred from the tool schema; sensitive tools are flagged automatically. See [integrations_readme.md](integrations_readme.md#mcp) for full setup.

---

## Tool Counts by Skill

| Skill | Tools |
|-------|-------|
| Reminders | 4 |
| Notes | 4 |
| Memory | 5 |
| Doctor | 2 |
| Scheduler | 2 |
| Audit | 2 |
| Tasks | 4 |
| Self-Improvement | 6 |
| Docker Executor | 1 |
| Browser | 8 |
| Subagents | 9 |
| Agent Skills | 3 |
| Firecrawl | 5 |
| n8n | 6 |
| Weather | 3 |
| MCP | dynamic |
| **Total (static)** | **64** |

---

## Agent Tool Access

Which tools each specialist agent can call (defined in `src/agents/{name}/tools.md`):

| Agent | Tool Categories |
|-------|----------------|
| `research` | Firecrawl (scrape/search/map), Browser (open/navigate/screenshot/get_content/click/close), Notes (save/search/list), Memory (save/search) |
| `home` | Reminders (all), Notes (save/search/list), Memory (save/search), Weather (all) |
| `lab` | Docker Executor (code_execute), Notes (save/search/list), Memory (save/search), Firecrawl (scrape/search) |
| `planner` | Tasks (all), Notes (save/search/list), Memory (save/search) |

Main agent has access to all tools. Subagents spawned via `delegate_to_subagent` receive an explicit allowlist.
