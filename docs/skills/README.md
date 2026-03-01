# Skills

coda has two types of skills: **built-in skills** (agent capabilities backed by code) and **agent skills** (community/custom instruction-based skills loaded from `SKILL.md` files).

## Built-in Skills

Agent capabilities that don't require external services (beyond PostgreSQL/Redis). Located in `src/skills/`.

### Reminders

Natural language time parsing powered by chrono-node. Supports one-time and recurring reminders.

| Tool | Description |
|------|-------------|
| `reminder_create` | "in 2 hours", "Friday at 3pm", "every Monday at 9am" |
| `reminder_list` | View pending/completed/all reminders |
| `reminder_complete` | Mark done (auto-creates next occurrence if recurring) |
| `reminder_snooze` | Snooze with natural language ("in 15 minutes") |

A background checker runs every 60 seconds and publishes `alert.reminder.due` events for overdue reminders.

### Notes

Full-text search with PostgreSQL tsvector. Tag notes for organization — use `context:always` to inject a note into every conversation.

| Tool | Description |
|------|-------------|
| `note_save` | Save with optional title and tags |
| `note_search` | Full-text search with optional tag filter |
| `note_list` | Recent notes, optional tag filter |
| `note_delete` | Delete by ID |

### Memory

Semantic memory powered by vector embeddings. The LLM decides what to remember and can retrieve information by *meaning*, not just keywords. Relevant memories are automatically injected into every conversation.

| Tool | Description |
|------|-------------|
| `memory_save` | Save a fact, preference, or event to long-term memory with importance and tags |
| `memory_search` | Find memories by meaning (semantic similarity), with optional type/tag filters |
| `memory_context` | Get assembled context for a topic within a token budget |
| `memory_list` | List recent memories, optionally filtered |
| `memory_delete` | Soft-delete a memory by ID |

Requires the memory service (Python, included in Docker Compose) and `MEMORY_API_KEY` in `.env`. See [`src/skills/memory/README.md`](src/skills/memory/README.md) for full setup.

### Doctor

System diagnostics and self-healing. The doctor monitors error patterns, repairs malformed LLM output, and can reset degraded skills.

| Tool | Description |
|------|-------------|
| `doctor_diagnose` | Run a system diagnostic (skills health, provider status, recent errors, detected patterns) |
| `doctor_reset_skill` | Reset a degraded/unavailable skill back to healthy (requires confirmation) |

**Self-healing features:**
- **Error classification** — Unified taxonomy (transient, rate_limited, auth_expired, malformed_output, etc.) replaces ad-hoc retry checks
- **Output repair** — Two-tier repair for malformed JSON: quick fixes (strip fences, fix commas) then LLM re-prompt
- **Pattern detection** — Detects repeated errors from the same source and generates recommendations
- **Truncation handling** — Automatically requests continuation when LLM response hits max_tokens
- **Periodic recovery** — Probes degraded skills after cooldown period

### Scheduler

Manage cron-based scheduled tasks at runtime.

| Tool | Description |
|------|-------------|
| `scheduler_list` | List all scheduled tasks with status, next run time, and last result |
| `scheduler_toggle` | Enable or disable a task (requires confirmation) |

Skills can register their own scheduled tasks at startup. Override schedules in `config.yaml`:

```yaml
scheduler:
  tasks:
    "health.check":
      cron: "*/5 * * * *"
      enabled: true
```

### Audit

Read-only agent self-introspection into the persistent audit log. Allows the agent to query its own tool call history, identify failure patterns, and surface usage statistics without direct DB access.

| Tool | Description |
|------|-------------|
| `audit_query` | Query recent tool calls filtered by tool, skill, status, or time window |
| `audit_stats` | Aggregate statistics: total calls, success rate, top tools, errors by tool |

Both tools are `mainAgentOnly` — not available to subagents.

> **Data foundation**: The audit log records every tool call to `audit_log` in Postgres. This data powers Phase 4's weekly Opus reflection cycle and self-improvement engine.

### Tasks (Long-Horizon Execution)

Persistent multi-day task tracking with checkpointing and auto-resumption. Tasks survive restarts and can span multiple days with scheduled action points.

| Tool | Description |
|------|-------------|
| `task_create` | Create a persistent task with an ordered list of steps and optional schedule |
| `task_status` | Get status of a specific task, or list all active tasks for the current user |
| `task_advance` | Mark the current step complete and advance to the next step |
| `task_block` | Mark a task as blocked, recording the blocker reason and type |

**Scheduled resumption**: A cron job (default: every 15 minutes) checks for tasks whose `next_action_at` has arrived and notifies the user via the configured messaging channel.

**Configuration** (in `config.yaml`):

```yaml
tasks:
  enabled: true
  resume_cron: "*/15 * * * *"   # How often to check for resumable tasks
  max_active_per_user: 5         # Max concurrent active tasks per user
  max_auto_resume_attempts: 3    # Max times a task auto-resumes without user input
```

### Self-Improvement

Weekly Opus-powered reflection cycle that analyzes performance data and generates structured improvement proposals. Supports version-controlled prompt evolution with A/B testing.

All tools are `mainAgentOnly` and require user confirmation for write operations.

| Tool | Description |
|------|-------------|
| `improvement_proposals_list` | List improvement proposals (filter by status: pending/approved/rejected/applied/all) |
| `improvement_proposal_decide` | Approve or reject a proposal (tier 3, requires confirmation) |
| `improvement_trigger_reflection` | Manually trigger a reflection cycle immediately (tier 3, requires confirmation) |
| `prompt_rollback` | Roll back a prompt section to its previous version (tier 3, requires confirmation) |
| `gap_detection_trigger` | Manually trigger a monthly capability gap detection cycle (tier 3, requires confirmation) |
| `few_shot_harvest_trigger` | Manually trigger a few-shot pattern harvest from high-scoring interactions (tier 3, requires confirmation) |

**How it works:**
1. Every Sunday at 3 AM (configurable), an Opus reflection cycle runs
2. It analyzes: audit stats, low-scoring self-assessments, routing patterns, current system prompt, and tool list
3. Opus generates up to 10 structured proposals with category, title, description, priority, and optional prompt diff
4. Proposals are inserted to `improvement_proposals` with `status: pending`
5. A summary is sent to the configured approval channel
6. The user reviews via `improvement_proposals_list` and decides via `improvement_proposal_decide`
7. Approved `prompt` proposals with a diff are automatically applied to `prompt_versions` when `prompt_evolution_enabled: true`

**Self-assessment** (4.1): After each tool-using turn, Haiku scores the interaction 1-5 and records failure modes to `self_assessments`. This data feeds the weekly reflection cycle.

**Learned routing** (4.4): A separate cron (default Sunday 4 AM) retrains the `LearnedTierClassifier` from routing decisions + self-assessment scores, improving tier classification over time.

**Gap detection** (5.4): Monthly Opus analysis of 30 days of audit data to identify missing capabilities (tools/integrations that would prevent recurring failures). Runs on the 1st of each month at 2 AM. Generates `capability_gap` proposals in `improvement_proposals`.

**Few-shot harvest** (5.7): Monthly Opus job harvesting high-scoring interactions (score ≥ 4, tool calls ≥ 2) into `solution_patterns`. At turn start, 2-3 relevant patterns are retrieved by keyword similarity and injected into the system prompt as `<example>` blocks.

**Critique loop** (5.3): Before executing any tool at tier ≥ 3 (or tools marked `requiresCritique: true`), a Haiku-powered safety reviewer checks the action for alignment, injection risk, and proportionality. Blocked actions are logged to audit with `event_type: "critique"`.

**Configuration** (in `config.yaml`):

```yaml
self_improvement:
  enabled: true
  opus_model: "claude-opus-4-6"          # Optional: override Opus model
  reflection_cron: "0 3 * * 0"          # Sunday 3 AM
  assessment_enabled: true               # Post-turn self-scoring
  prompt_evolution_enabled: false        # Auto-apply approved prompt proposals
  max_reflection_input_tokens: 8000      # Max tokens sent to Opus
  approval_channel: "discord"            # Where to send proposal summaries
  routing_retrain_cron: "0 4 * * 0"     # Sunday 4 AM
  # Phase 5 additions:
  critique_enabled: true                 # Pre-execution Haiku safety review
  critique_min_tier: 3                   # Minimum tier to trigger critique
  gap_detection_enabled: true            # Monthly capability gap analysis
  gap_detection_cron: "0 2 1 * *"        # 1st of month 2 AM
  few_shot_enabled: true                 # Harvest + inject solution patterns
  few_shot_harvest_cron: "0 4 1 * *"    # 1st of month 4 AM
  few_shot_min_score: 4                  # Min score for harvest (0-5)
  few_shot_min_tool_calls: 2             # Min tool calls for harvest
```

### Docker Executor

Provides sandboxed code execution in ephemeral Docker containers. Enables agent skills (like PDF processing) to run code safely with strict resource limits and isolation.

| Tool | Description |
|------|-------------|
| `code_execute` | Run a shell command in an ephemeral Docker container with configurable image, timeout, and network access |

**Security features:**
- Ephemeral containers (`--rm`) auto-destroyed after execution
- Read-only root filesystem with limited `/tmp` tmpfs
- Resource limits: memory, CPU, PIDs
- Network disabled by default (`--network none`)
- Only specified working directory mounted as writable
- Image whitelist prevents arbitrary image execution
- Requires user confirmation for sensitive operations

**Configuration** (in `config.yaml`):

```yaml
execution:
  enabled: false                    # Must be explicitly enabled
  docker_socket: "/var/run/docker.sock"
  default_image: "python:3.12-slim"
  timeout: 60                       # Max execution time in seconds
  max_memory: "512m"                # Container memory limit
  network_enabled: false            # Allow network access (default: false)
  max_output_size: 52428800         # 50 MB max output file size
  allowed_images:                   # Whitelist of allowed images (glob patterns)
    - "python:*"
    - "node:*"
    - "ubuntu:*"
    - "alpine:*"
```

**Environment variable overrides:**
- `EXECUTION_ENABLED=true|false`
- `EXECUTION_DEFAULT_IMAGE=python:3.12-slim`

**Requirements:**
- Docker installed and daemon running
- User must have permission to access Docker socket
- Allowed Docker images must be pulled before use

**Integration with Agent Skills:**

Agent skills can specify a `docker_image` in their SKILL.md frontmatter:

```yaml
---
name: pdf
description: "Process PDF files"
docker_image: python:3.12-slim
---
```

When the LLM activates the skill via `skill_activate`, it receives the `docker_image` field and can then call `code_execute` with the appropriate image.

**Output files:**

The container has access to files in the mounted working directory at `/workspace`. Commands can write output files to `/workspace/output/` — these files are automatically collected and returned to the user as attachments.

### Docker Sandbox

Sandboxed Docker operations for the self-improvement executor pipeline. Unlike `docker-executor` (for user code execution), this skill manages `agent-sandbox-*` containers used to validate code changes in isolation before submitting PRs.

| Tool | Tier | Description |
|------|------|-------------|
| `docker_sandbox_build` | 3 | Build a Docker image (tag must start `agent-sandbox-`) |
| `docker_sandbox_run` | 3 | Run a named container in detached mode |
| `docker_sandbox_logs` | 0 | Get container logs |
| `docker_sandbox_stop` | 2 | Stop a running container |
| `docker_sandbox_remove` | 2 | Remove a container |
| `docker_sandbox_healthcheck` | 0 | HTTP GET localhost health check |

**Security constraints:**
- Image tag and container name must start with `agent-sandbox-` (prevents targeting production containers)
- Build context path must be within the agent's working directory (prevents path traversal)
- Healthcheck limited to `localhost` / `127.0.0.1` (prevents SSRF)
- No shell injection: uses `execFile` (not `exec`) for all Docker commands
- Enabled only when `self_improvement.executor_enabled: true`

### Self-Improvement Executor

Closes the detect→fix→test→PR loop for self-improvement proposals. Orchestrates a 9-step pipeline using specialist subagents and the GitHub MCP integration.

| Tool | Tier | Description |
|------|------|-------------|
| `self_improvement_run` | 3 | Manually trigger an execution cycle |
| `self_improvement_status` | 0 | Status of current/last run |
| `self_improvement_history` | 0 | Past run results from DB |

**Pipeline (when `self_improvement_run` is called):**
1. Acquire Redis lock (prevent concurrent runs)
2. Select highest-priority approved proposal
3. Blast radius analysis (code-archaeologist subagent)
4. Generate code fix (code-surgeon subagent)
5. Create branch + push files (GitHub MCP)
6. Build, test, shadow container validation (test-runner subagent)
7. Create PR on PASS (GitHub MCP)
8. Morning narrative + webhook (improvement-reporter subagent)
9. Update DB + release lock

**Specialist agents used:**
- `code-archaeologist` — read-only blast radius analysis
- `code-surgeon` — minimum viable TypeScript fix generator (Sonnet)
- `test-runner` — compile + test + Docker build + smoke tests
- `improvement-reporter` — PR body + morning briefing (Sonnet)

**Safety:**
- `executor_forbidden_paths`: `src/core`, `src/db/migrations`, `src/main.ts` always protected
- `executor_blast_radius_limit`: abort if too many files affected (default 5)
- Auto-merge hardcoded to `false` — humans must review every PR
- `executor_enabled: false` by default — must be opted into after configuring `GITHUB_TOKEN`

**Scheduling:** Monday 2 AM (`executor_cron: "0 2 * * 1"`) — picks up proposals from Sunday 3 AM reflection.

**Configuration** (in `config.yaml` under `self_improvement:`):

```yaml
self_improvement:
  executor_enabled: false         # Enable after setting GITHUB_TOKEN
  executor_require_approval: true # Only "approved" proposals (vs. also "pending")
  executor_cron: "0 2 * * 1"     # Monday 2 AM
  executor_max_files: 3           # Max files per fix
  executor_blast_radius_limit: 5  # Abort if >5 files affected
  executor_shadow_port: 3099      # Shadow container health check port
```

### Browser Automation

Secure browser automation via Playwright's direct Node.js API in ephemeral Docker containers. Unlike Firecrawl (read-only scraping), the browser skill can log into portals, fill forms, click buttons, and interact with single-page apps. The direct API removes the fragile MCP protocol layer while keeping the same security model.

| Tool | Tier | Description |
|------|------|-------------|
| `browser_open` | 2 | Start a new isolated browser session; optionally navigate to a starting URL; returns `session_id` |
| `browser_navigate` | 2 | Navigate to a URL (SSRF-protected; critique enabled) |
| `browser_get_content` | 1 | Accessibility snapshot of the page with Playwright locator strings |
| `browser_interact` | 2 | Click, type, or select — unified interaction (sensitive: may contain credentials) |
| `browser_screenshot` | 1 | Take a screenshot; saves to temp file and returns path |
| `browser_close` | 0 | Destroy the session and container |

**`browser_get_content` output format** — locator strings the LLM can use directly in `browser_interact`:

```
Page: Example.com
URL: https://example.com

[heading] "Welcome"        → h1:has-text("Welcome")
[link] "About Us"          → a:has-text("About Us")
[button] "Sign In"         → button:has-text("Sign In")
[textbox] "Email"          → input[aria-label="Email"], input[placeholder="Email"], ...
```

**`browser_interact` actions:**
- `click` — click a button, link, or any element
- `type` — fill a text input (clears existing value)
- `select` — choose an option from a `<select>` dropdown

**Typical workflow:**

```
browser_open(url?) → browser_get_content
  → browser_interact(action=click, selector=...)
  → browser_interact(action=type, selector=..., value=...)
  → browser_screenshot → browser_close
```

**Two connection modes:**

| Mode | Use case | How it works |
|------|----------|--------------|
| `docker` (default) | Production | Spawns isolated container; host connects via WebSocket to container IP |
| `host` | Development | Launches Chromium directly via `chromium.launch()` — no Docker required |

**Security model (defense in depth):**

| Layer | Mechanism |
|-------|-----------|
| Network | `coda-browser-sandbox` Docker network — internet only, no `coda-internal` access |
| SSRF | Hardcoded private IP blocklist (127.x, 10.x, 172.16-31.x, 192.168.x, 169.254.x, localhost) + configurable blocklist |
| Container | `--cap-drop=ALL`, `--security-opt=no-new-privileges`, `--read-only`, tmpfs for writable dirs |
| Resources | Memory 1g, CPU 1, PID 512, SHM 256m |
| Lifecycle | `--rm` flag + auto-destroy on idle timeout + `browser.close()` on session end |
| Audit | All tool calls logged via AuditService |

**Setup (docker mode):**

1. Build the image: `docker compose --profile mcp-build build`
2. Enable in config:

```yaml
browser:
  enabled: true
  mode: "docker"
  image: "coda-browser-sandbox"
  sandbox_network: "coda-browser-sandbox"
  max_sessions: 3
  session_timeout_seconds: 300
  connect_timeout_ms: 15000
  connect_retries: 3
```

**Setup (host mode — development only):**

```bash
npx playwright install chromium
```
```yaml
browser:
  enabled: true
  mode: "host"
  headless: true  # set false to see the browser window
```

**Environment variable overrides:**
- `BROWSER_ENABLED=true|false`
- `BROWSER_IMAGE=coda-browser-sandbox`

**Requirements (docker mode):**
- Docker socket mounted (`/var/run/docker.sock`)
- `coda-browser-sandbox` image built (see above)
- `coda-browser-sandbox` Docker network created (auto-created by `docker compose up`)

### Specialist Agents

Specialist agents are domain-focused sub-agents defined entirely by files in `src/agents/{name}/`. The main agent delegates tasks to them via `specialist_spawn`, running with a tailored system prompt and a scoped tool allowlist. No TypeScript is needed — adding a new directory is enough.

**Tools:**

| Tool | Description |
|------|-------------|
| `specialist_list` | Show all loaded agents with descriptions and tool lists |
| `specialist_spawn` | Delegate a task to a named specialist; blocks until the result is returned |

**Built-in agents:**

| Agent | Token budget | Focus |
|-------|-------------|-------|
| `home` | 30 000 | Reminders, notes, weather, personal organisation |
| `research` | 80 000 | Web scraping, search, synthesis, source citation; browser tools available for JS-heavy pages |
| `lab` | 100 000 | Code execution, debugging, technical research |
| `planner` | 40 000 | Task decomposition, scheduling, dependency analysis |

The `research` agent has access to both Firecrawl (fast, read-only scraping) and browser tools (`browser_open`, `browser_navigate`, `browser_screenshot`, `browser_get_content`, `browser_interact`) for pages that require JavaScript rendering, click interactions, or pagination.

---

#### Using agents

Ask the main agent in natural language — it will choose the right specialist automatically:

```
"Research the latest TypeScript 5.5 release notes and save a summary to notes"
"Write a Python script that parses a CSV and plots a chart"
"Create a plan for migrating our database to PostgreSQL 16"
"Set a reminder for the team meeting every Monday at 9am"
```

Or use `specialist_list` to discover agents and `specialist_spawn` explicitly:

```
specialist_spawn: { specialist: "research", task: "Find the top 5 open-source vector databases and compare their indexing strategies" }
```

---

#### Agent directory format

Each agent lives at `src/agents/{name}/` where `name` matches `/^[a-z][a-z0-9-]*$/`.

```
src/agents/my-agent/
  soul.md        # Required — system prompt (plain markdown, no frontmatter)
  tools.md       # Required — allowed tool names, one per line
  config.yaml    # Required — description and resource settings
  references/    # Optional — supplementary docs appended to soul.md
    guide.md
    api-reference.json
```

**`soul.md`** — Plain markdown. The full file body becomes the agent's system prompt. A mandatory security preamble is prepended automatically (injection defense, no exfiltration). Be specific about priorities, output format, and rules.

**`tools.md`** — One tool name per line. Blank lines and lines starting with `#` are ignored. The agent can only call tools listed here — all others are blocked.

```
# Core research tools
firecrawl_scrape
firecrawl_search
firecrawl_map

# Persistence
note_save
note_search
memory_save
```

**`config.yaml`** — All fields except `description` are optional:

```yaml
description: "Web research and synthesis"  # required — shown in specialist_list
enabled: true                              # set false to skip loading this agent
default_model: null                        # null = heavy tier model
default_provider: null                     # null = system default provider
token_budget: 80000                        # max tokens per run; null = global default
max_tool_calls: null                       # max tool calls per run; null = global default
```

**`references/`** — Optional directory of `.md`, `.txt`, or `.json` files. Files are sorted alphabetically and appended to the system prompt as labeled sections:

```
---
## Reference: api-reference
<file contents>
```

Use references for things that should always be available to the agent (API docs, decision trees, style guides) without cluttering `soul.md`.

---

#### Creating a new agent

1. Create the directory and three required files:

```bash
mkdir -p src/agents/finance

cat > src/agents/finance/config.yaml << 'EOF'
description: "Personal finance tracking: expenses, budgets, and summaries"
enabled: true
token_budget: 40000
max_tool_calls: null
default_model: null
default_provider: null
EOF

cat > src/agents/finance/tools.md << 'EOF'
# Notes for storing expenses and reports
note_save
note_search
note_list
note_get

# Memory for recurring preferences
memory_save
memory_search
EOF

cat > src/agents/finance/soul.md << 'EOF'
You are a personal finance specialist. Your focus is tracking expenses, managing budgets, and producing clear financial summaries.

Priorities:
- Log expenses with amount, category, and date to notes
- Search notes to retrieve expense history
- Summarise spending by category when asked
- Flag unusual or recurring charges
- Keep responses concrete — include numbers and dates

Always confirm the action taken and the note title used when saving data.
EOF
```

2. Restart coda — no other changes needed. The agent loads automatically.

3. Verify: ask the main agent to list specialists, or send `specialist_list`.

**Naming rules:**
- Must match `/^[a-z][a-z0-9-]*$/` (e.g. `finance`, `dev-ops`, `travel2`)
- Directories that fail this pattern are skipped with a warning in the logs

**Errors:** if a required file is missing or `config.yaml` is invalid, the agent is skipped and a warning is logged — other agents continue to load normally.

---

#### Overriding an agent via config

All agent settings can be overridden in `config/config.yaml` under `specialists:` without editing the agent directory. Useful for deployment-specific tuning or temporary changes.

```yaml
specialists:
  research:
    # Replace system prompt entirely
    system_prompt: "You are a focused academic research assistant. Cite all sources in APA format..."

    # Narrow the tool allowlist
    allowed_tools:
      - firecrawl_search
      - note_save

    # Cap resource usage
    token_budget: 50000
    max_tool_calls: 20

  lab:
    # Run lab agent on a more capable model
    default_model: "claude-opus-4-6"
    default_provider: "anthropic"

  home:
    # Disable entirely (won't appear in specialist_list)
    enabled: false
```

Override fields (all optional):

| Field | Type | Effect |
|-------|------|--------|
| `system_prompt` | string | Replaces `soul.md` entirely |
| `allowed_tools` | string[] | Replaces `tools.md` list |
| `blocked_tools` | string[] | Removes specific tools from the allowlist |
| `default_model` | string | Model ID to use for this agent |
| `default_provider` | string | Provider name to use for this agent |
| `token_budget` | number | Max tokens per run |
| `max_tool_calls` | number | Max tool calls per run |
| `enabled` | boolean | Set `false` to hide and disable the agent |

## Agent Skills

coda supports the [Agent Skills standard](https://agentskills.io/specification) for loading community or custom instruction-based skills. Agent skills are directories containing a `SKILL.md` file with YAML frontmatter — no code required.

### Creating an Agent Skill

Create a directory with a `SKILL.md` file:

```
my-skills/
  pdf-tools/
    SKILL.md
    scripts/
      extract.sh
    references/
      api.md
```

The `SKILL.md` must start with YAML frontmatter:

```markdown
---
name: pdf-tools
description: "Extract text from PDFs, fill forms, merge documents."
---

# PDF Tools

Instructions for the LLM on how to use this skill...

## When to Use

Use this skill when the user asks about PDF files...
```

**Frontmatter requirements:**
- `name` — lowercase, alphanumeric + hyphens, max 64 chars (pattern: `/^[a-z][a-z0-9-]*$/`)
- `description` — max 1024 chars, shown to the LLM in the system prompt

**Optional frontmatter fields:**
- `docker_image` — Docker image to use for code execution (e.g., `python:3.12-slim`)
- `dependencies` — Python and system packages required by this skill (see below)

**Dependencies:**

Skills that need Python packages or system libraries can declare them in two formats:

```yaml
# Flat array (treated as pip dependencies)
dependencies:
  - pypdf
  - pandas

# Structured format (recommended)
dependencies:
  pip:
    - pypdf
    - pandas
  system:
    - poppler-utils
    - tesseract-ocr
```

To build pre-built Docker images with dependencies baked in:

```bash
# Build images for all skills with dependencies
npm run build:skill-images

# Build a specific skill
npm run build:skill-images -- pdf

# Rebuild even if image exists
npm run build:skill-images -- --force

# Show what would be built without building
npm run build:skill-images -- --dry-run
```

Pre-built images are named `coda-skill-<name>:latest` and are automatically used when activating a skill if they exist. This allows skills to run in sandboxed containers with `network_enabled: false` since dependencies are already installed.

📖 **For detailed documentation on pre-built skill images, see [docs/skill-docker-images.md](docs/skill-docker-images.md)**

**Supplementary resources** (optional):
- `scripts/` — Shell scripts, Python scripts, etc.
- `references/` — API docs, specs, guides
- `assets/` — Templates, config files, data

Allowed file extensions: `.md`, `.txt`, `.json`, `.yaml`, `.yml`, `.sh`, `.py`, `.js`, `.ts`, `.csv`, `.toml`, `.xml`

### Configuring Agent Skill Directories

Add directories to scan in `config.yaml`:

```yaml
skills:
  agent_skill_dirs:
    - "./agent-skills"
    - "~/.agent-skills"
```

Each directory is scanned for subdirectories containing `SKILL.md` files. The LLM sees all discovered skills in its system prompt and can activate them on demand using the `skill_activate` tool.

### How It Works

1. On startup, coda scans configured directories for `SKILL.md` files
2. Valid skills appear in the system prompt as `<available_skills>` entries
3. When a user request matches a skill, the LLM calls `skill_activate` to load the full instructions
4. The LLM can then call `skill_read_resource` to access supplementary files from `scripts/`, `references/`, or `assets/`

### Live Rescan

You can add or remove agent skills without restarting by sending `/rescan-skills` (or asking the assistant to reload skills). This re-scans all configured directories and reports any added or removed skills. Already-activated skills remain usable if they still exist on disk.

### Security

- Path traversal is prevented — resources must be within the skill directory
- Only allowed file extensions can be read
- World-writable directories are rejected
- Skills must be activated before their resources can be accessed

## Built-in Agent Skills

These agent skills ship with coda in `src/skills/agent-skills/`.

### Web Research

Provides guided research strategies using the [Firecrawl integration](integrations_readme.md#firecrawl) tools. Activate with `skill_activate` using the name `web-research`.

**Strategies included:**
- **Quick fact-finding** — search, review snippets, synthesize with citations
- **Reading specific pages** — scrape a URL for clean markdown
- **Exploring documentation sites** — map a site's URLs, then targeted scrapes or crawls with `include_paths`
- **Deep research** — search, scrape promising results, cross-reference across sources

**Best practices enforced:**
- Start narrow (search/scrape) before resorting to crawls
- Always set `include_paths`/`exclude_paths` and keep crawl `limit` low
- Cite source URLs when presenting information
- Check `truncated` flag on long content
