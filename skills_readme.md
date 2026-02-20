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
