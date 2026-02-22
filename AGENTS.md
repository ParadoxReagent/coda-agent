# AGENTS.md — Coda Agent Developer Guide

This file is a reference for AI coding agents (and human contributors) working on the coda-agent codebase. It captures architecture, conventions, and checklists so you can make correct changes without reading every file first.

---

## Project Overview

**Coda** is a single-user personal AI assistant platform designed for home-lab use. It runs as a self-hosted Docker Compose stack and exposes interfaces via Discord and Slack.

- **Runtime**: Node.js 22+, TypeScript strict ESM, pnpm
- **Database**: PostgreSQL (via Drizzle ORM + drizzle-kit)
- **Message bus**: Redis Streams (`ioredis`)
- **LLM providers**: Anthropic, OpenAI-compatible, Google (Gemini)
- **Deployment**: `./scripts/deploy.sh` — builds images then runs `docker compose up`

---

## Directory Structure

```
src/
  core/           # Orchestrator, event bus, LLM manager, scheduling, audit
    llm/          # Provider abstractions (anthropic, openai-compat, google)
    doctor/       # Health-check / diagnostics service
    sinks/        # Output sinks (e.g., notification routing)
    prompts/      # Main agent prompt files (soul.md, guidelines.md, security.md, memory.md)
  skills/         # Skill implementations (each is a directory or .ts file)
    base.ts       # Skill interface and SkillContext type
    registry.ts   # SkillRegistry — registers and looks up skills
    loader.ts     # Dynamic skill loader
    agent-skill-discovery.ts  # Discovers skills exposed by agent presets
    agent-skills/ # Skills shipped as separate Docker containers (MCP)
    memory/       # Long-term memory (vector search)
    notes/        # Notes storage
    browser/      # Browser automation (sandboxed Docker)
    tasks/        # Task tracking
    reminders/    # Reminder scheduling
    self-improvement/ # Weekly reflection / prompt evolution
  agents/         # Specialist agent presets
    home/         # Home management agent
    research/     # Research agent
    planner/      # Planning agent
    lab/          # Lab/infrastructure agent
  integrations/   # Third-party integrations
    firecrawl/    # Web scraping
    mcp/          # Model Context Protocol client
    n8n/          # n8n workflow integration
    weather/      # Weather API
  interfaces/     # User-facing interfaces
    discord-bot.ts
    slack-bot.ts
    rest-api.ts
  db/
    schema.ts     # Drizzle schema definitions
    migrations/   # SQL migration files (hand-written)
    connection.ts # DB connection setup
  utils/          # Config loading, logging, helpers
    config.ts     # AppConfig type + loader
    config-watcher.ts # Hot-reload non-structural config
  scripts/        # Build scripts (Docker image builds)
config/
  config.example.yaml  # Full config reference with defaults (commented)
  config.yaml          # Live user config (mirrors example)
```

---

## Architecture

### Message Flow

```
User (Discord/Slack)
  → Interface (discord-bot.ts / slack-bot.ts)
  → Orchestrator.handleMessage()
  → TierClassifier (picks light or heavy LLM tier)
  → LLM + tool loop (up to MAX_TOOL_CALLS_PER_TURN = 10)
  → Response sent back to interface
```

Side effects run **fire-and-forget** (non-blocking): audit logging, memory save, self-assessment scoring.

### Dual LLM Tiers

- **Light tier**: cheaper/faster model for simple queries
- **Heavy tier**: more capable model for complex reasoning
- `TierClassifier` (`src/core/tier-classifier.ts`) routes each message

### Event Bus

Redis Streams via `src/core/redis-event-bus.ts`. Events include message receipt, tool execution, agent routing decisions. Use `eventBus.emit()` / `eventBus.on()`.

### Sub-agents

- **`delegate_to_subagent`**: synchronous, returns result in same turn (use for 1-3 tool calls)
- **`sessions_spawn`**: asynchronous, runs in background (use for longer research/analysis)
- Agent presets defined in `src/agents/{name}/` and loaded by `AgentLoader`

### Dependency Injection

`Orchestrator` uses setter methods to receive optional services (avoids circular imports):
- `setDoctorService()`, `setSelfAssessmentService()`, `setPromptManager()`, `setCritiqueService()`, `setFewShotService()`

---

## Key Patterns

### Skills

Skills implement the `Skill` interface (`src/skills/base.ts`) and receive `SkillContext` at startup. `SkillContext` provides: `logger`, `config`, `messageSender`, and other services.

```typescript
// Register a skill tool definition:
{
  name: "my_tool",
  description: "...",
  input_schema: { ... },
  permissionTier: 1,  // 0–4; tier ≥3 triggers user confirmation
}
```

**Permission tiers**:
- 0 — Read-only, no side effects
- 1 — Local writes (notes, memory)
- 2 — Network reads (API calls)
- 3 — Mutating external state (sending messages, creating events) → confirmation prompt
- 4 — Destructive / high-risk actions → always requires confirmation

### Injection Defense

- All external content (web scrapes, sub-agent results, API responses) is wrapped in `<external_data>` tags with an untrusted-content warning
- `ContentSanitizer` (`src/core/sanitizer.ts`) is applied to all error messages and external content before inclusion in prompts

### Agent Presets

Each agent lives in `src/agents/{name}/` with:
- `soul.md` — Agent identity/persona
- `tools.md` — Tool usage instructions
- `config.yaml` — Model, tier, and tool configuration

### Main Agent Prompts

The main orchestrator agent (the one users chat with) has its prompts in `src/core/prompts/`:
- `soul.md` — Identity (overridable via PromptManager DB section `identity`)
- `guidelines.md` — Behavioral guidelines (DB section: `guidelines`)
- `security.md` — Security/injection rules (DB section: `security`)
- `memory.md` — Memory tool instructions (DB section: `memory_instructions`)

DB-backed overrides from `PromptManager` take precedence over these file defaults at runtime.

### PromptManager

`src/core/prompt-manager.ts` — stores versioned prompt sections in PostgreSQL. Used by the self-improvement skill to evolve prompts over time. DB versions always override file defaults.

---

## Adding New Things

### New Skill

1. Create `src/skills/{name}/skill.ts` implementing the `Skill` interface
2. Register in `src/skills/registry.ts` or via the dynamic loader
3. Update `skills_readme.md` (root)
4. If it has config options, add them to `config/config.example.yaml` and mirror into `config/config.yaml`
5. Update `agent_roadmap.md` — mark the feature as done

### New Integration

1. Create `src/integrations/{name}/` with implementation
2. Update `integrations_readme.md` (root)
3. Add config section to `config/config.example.yaml` and mirror into `config/config.yaml`
4. Update `agent_roadmap.md`

### New Agent Preset

1. Create `src/agents/{name}/` with `soul.md`, `tools.md`, `config.yaml`
2. `AgentLoader` scans `src/agents/` automatically — no registration needed
3. Update `skills_readme.md` if the agent exposes tools

### New DB Migration

**Do NOT use `drizzle-kit generate`** — it is interactive and will hang in CI. Instead:
1. Write SQL manually to `src/db/migrations/NNNN_name.sql`
2. Add an entry to `src/db/migrations/meta/_journal.json`
3. Update `src/db/schema.ts` with the corresponding Drizzle schema changes

### New Docker Image (MCP / Agent Skill)

1. Create `src/skills/agent-skills/{name}/Dockerfile`
2. Register in `EXTRA_IMAGES` array at the top of `src/scripts/build-mcp-images.ts`
3. Add a build-only service to `docker-compose.yml` with `profiles: [mcp-build]`
4. `scripts/deploy.sh` runs `docker compose --profile mcp-build build` automatically

---

## Documentation Conventions

| What changed | Files to update |
|---|---|
| New or changed integration | `integrations_readme.md`, `config/config.example.yaml` + `config/config.yaml`, `agent_roadmap.md` |
| New or changed skill | `skills_readme.md`, `config/config.example.yaml` + `config/config.yaml` (if config), `agent_roadmap.md` |
| New config option | `config/config.example.yaml` (commented, with default) **and** `config/config.yaml` |
| Feature completed | `agent_roadmap.md` — mark as done |

**Always sync `config.example.yaml` → `config.yaml`** whenever the example is updated.

---

## Build / Test / Deploy

```bash
pnpm dev              # Run with tsx watch (hot reload)
pnpm build            # tsc + copy src/agents and src/core/prompts to dist/
pnpm start            # Run compiled dist/main.js
pnpm test             # All tests (vitest)
pnpm test:unit        # Unit tests only
pnpm test:integration # Integration tests only
pnpm lint             # tsc --noEmit (type check only)
./scripts/deploy.sh   # Build Docker images + docker compose up (remote deploy)
```

---

## TypeScript Configuration

- **Strict mode** enabled
- **ESM** with `verbatimModuleSyntax` — all imports must use `.js` extension (even for `.ts` source files)
- `noUncheckedIndexedAccess` — array/object access may be `undefined`; handle accordingly
- `noUnusedLocals` / `noUnusedParameters` — all declared locals and params must be used

---

## Known Gotchas

- **35 baseline test failures** exist in the repo and are pre-existing (not caused by recent changes). Do not count these as regressions.
- **`drizzle-kit generate` is interactive** — always write migrations by hand (see above).
- **Config sync** — `config.example.yaml` and `config.yaml` must stay in sync. If you update one, update the other.
- **`import.meta.url`** is needed for path resolution in ESM; use `fileURLToPath(import.meta.url)` + `dirname` pattern (see `src/core/orchestrator.ts` or `src/core/agent-loader.ts` for examples).
- **Fire-and-forget services** (audit, memory, assessment) must never block the response path — wrap in `void somePromise.catch(...)` or use `Promise.allSettled`.
