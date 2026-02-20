# coda - Personal AI Assistant Platform

**Current Status: Phase 3 Event Infrastructure Complete**

coda is a personal AI assistant that lives in Discord and manages your digital life. It connects to your notes, reminders, and external services via n8n — and can deliver a morning briefing with a single message. Phase 3 adds a durable event-driven backbone with proactive alerts and scheduled tasks.

## What Works Now

- Multi-provider LLM support (Anthropic, Google Gemini, OpenAI, OpenRouter, Ollama)
- **Dual LLM Tier Routing** — Automatic cost optimization with light/heavy model routing (simple requests use cheap models, complex tasks auto-escalate)
- Discord bot with natural language + slash commands
- Conversation context tracking
- Provider switching at runtime
- Token usage tracking with per-tier cost breakdowns
- **Reminders** — Natural language time parsing ("in 2 hours", "every Monday at 9am"), background due-reminder alerts, snooze
- **Notes** — Full-text search, tagging, `context:always` notes injected into every conversation
- **Memory** — Semantic vector search (pgvector + sentence-transformers), auto-injected context, LLM-driven save/search
- **MCP Integration** — Connect to Model Context Protocol servers (stdio + HTTP transports), use external tools from filesystem, GitHub, databases, etc.
- **Morning Briefing** — Say "good morning" and get a summary of pending reminders, notes, and n8n events in one response
- **Redis Streams Event Bus** — Durable at-least-once event delivery with consumer groups, idempotency, and dead letter queue
- **Alert Router** — Configurable routing rules, quiet hours, per-event cooldowns, severity levels, and alert history audit trail
- **Task Scheduler** — Cron-based scheduled tasks with retry, config overrides, and runtime enable/disable via Discord
- **Alert Formatting** — Rich Discord embeds and Slack Block Kit formatting, color-coded by severity

## Quick Deploy (Docker)

Deploy the entire stack with a single command using Docker:

```bash
DISCORD_BOT_TOKEN=your_token \
DISCORD_CHANNEL_ID=your_channel_id \
OPENROUTER_API_KEY=your_key \
./scripts/deploy.sh
```

### Prerequisites

- Docker Desktop installed and running
- Discord bot token (from [Discord Developer Portal](https://discord.com/developers/applications))
- OpenRouter API key (or another LLM provider key)

### What This Does

The `deploy.sh` script automatically:
- ✅ Checks Docker is running
- ✅ Generates PostgreSQL password
- ✅ Creates `.env` file with your credentials
- ✅ Creates `config/config.yaml` with OpenRouter as default LLM provider
- ✅ Builds and starts all containers (coda-core, postgres, redis, memory-service, n8n-webhook)
- ✅ Runs database migrations
- ✅ Waits for health check
- ✅ Shows you helpful commands

### Optional: Add Memory Service

Include semantic memory (vector embeddings) by adding `MEMORY_API_KEY`:

```bash
DISCORD_BOT_TOKEN=your_token \
DISCORD_CHANNEL_ID=your_channel_id \
OPENROUTER_API_KEY=your_key \
MEMORY_API_KEY=your_memory_key \
./scripts/deploy.sh
```

### Alternative: Interactive Setup

Prefer a guided setup? Use the interactive quickstart script:

```bash
./scripts/quickstart.sh  # Creates .env template
vim .env                 # Edit with your credentials
./scripts/quickstart.sh  # Builds and deploys
```

### After Deployment

```bash
# View logs
docker compose logs -f coda-core

# Check health
curl localhost:3000/health

# Container status
docker compose ps

# Stop all services
docker compose down
```

Your bot is now running and will respond to messages in your Discord channel!

## Quick Start (Development Mode)

### Prerequisites

- Node.js 22+
- pnpm (`npm install -g pnpm`)
- At least one LLM API key (Anthropic, OpenAI, Google, or OpenRouter)
- Discord bot token and server setup
- PostgreSQL and Redis (required for skills; see Docker section below)

### 1. Install Dependencies

```bash
pnpm install
```

### 2. Set Up Discord Bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application
3. Go to "Bot" tab, create a bot, copy the token
4. Enable "Message Content Intent" under "Privileged Gateway Intents"
5. Go to "OAuth2" > "URL Generator":
   - Scopes: `bot`, `applications.commands`
   - Bot Permissions: `Send Messages`, `Read Message History`, `Use Slash Commands`
6. Use the generated URL to invite the bot to your server
7. Create a dedicated channel (e.g., `#coda-assistant`)
8. Get your Discord User ID (enable Developer Mode in Discord settings, right-click your name, "Copy User ID")
9. Get the Channel ID (right-click the channel, "Copy Channel ID")

### 3. Configure Environment

```bash
cp .env.example .env
```

Edit `.env`:

```bash
# Required: Discord
DISCORD_BOT_TOKEN=your_discord_bot_token_here
DISCORD_CHANNEL_ID=your_channel_id_here
DISCORD_ALLOWED_USER_IDS=your_user_id_here

# Required: At least one LLM provider
ANTHROPIC_API_KEY=sk-ant-...
# OR
OPENAI_API_KEY=sk-...
# OR
GOOGLE_API_KEY=AIza...
# OR
OPENROUTER_API_KEY=sk-or-...

# Required for skills: Database + Redis
DATABASE_URL=postgresql://coda:coda@localhost:5432/coda
REDIS_URL=redis://localhost:6379

```

### 4. Start Infrastructure

```bash
docker-compose up -d postgres redis
```

### 5. Run Migrations

```bash
pnpm db:migrate
```

### 6. Run in Development Mode

```bash
pnpm dev
```

The bot will start and connect to Discord. You'll see:
```
Database initialized
Redis connected
coda agent is running
Discord bot connected
```

### 7. Test It

Go to your Discord channel and:

```
You: Good morning!
Bot: Good morning! Here's your briefing:

⏰ Reminders: 2 pending — Call dentist (due 2pm), Submit report (due 5pm)

You: Remind me to pick up groceries in 2 hours
Bot: Reminder set: "pick up groceries" — in 2 hours (3:00 PM)

You: Save a note: The WiFi password for the office is sunshine42
Bot: Note saved: "The WiFi password for the office is sun..."

You: Search my notes for WiFi
Bot: Found 1 note: "The WiFi password for the office is sunshine42"
```

## Capabilities

coda has three types of capabilities: **integrations** (external service connectors), **built-in skills** (agent abilities), and **agent skills** (community/custom instruction-based skills).

- **[Integrations](integrations_readme.md)** — MCP (Model Context Protocol), n8n, Firecrawl (web scraping/search)
- **[Skills](skills_readme.md)** — Reminders, Notes, Memory, Scheduler, Agent Skills (community/custom)

### Morning Briefing

Say "morning", "good morning", "briefing", or "/briefing" and coda composes a natural summary from all available skills and integrations. Works gracefully when some are not configured.

### Alert Routing

Alerts are routed through configurable rules in `config.yaml`. Each event type can have its own severity, notification channels, cooldown period, and quiet hours behavior.

```yaml
alerts:
  rules:
    "alert.reminder.due":
      severity: "medium"
      channels: ["discord"]
      quietHours: true
      cooldown: 60
  quiet_hours:
    enabled: true
    start: "22:00"
    end: "07:00"
    timezone: "America/New_York"
    override_severities: ["high"]
```

High-severity alerts override quiet hours by default. All alerts (delivered and suppressed) are recorded in PostgreSQL for audit.

## Architecture Overview

```
┌─────────────────────────────────────────┐
│         Discord Bot Interface            │
│   (messages + slash commands)            │
└─────────────────┬───────────────────────┘
                  │
┌─────────────────▼───────────────────────┐
│          Orchestrator                    │
│   (agent loop + tool calling)            │
│   + briefing instructions                │
│   + context:always notes injection       │
│   + semantic memory context injection    │
└───┬─────────────┬───────────────────┬───┘
    │             │                   │
┌───▼───┐   ┌────▼────┐   ┌─────────▼──────┐
│ Skills │   │   LLM   │   │  Context Store  │
│Registry│   │Provider │   │  (history +     │
│        │   │Manager  │   │   facts)        │
└───┬────┘   └─────────┘   └────────────────┘
    │
┌───▼─────────────────────────────────────────────────┐
│  Reminders │ Notes │ Memory │ Sched │ n8n │ Firecrawl │
│  chrono    │  DB   │vectors │ cron  │     │           │
└──────────────────────────────────┬──────────────────┘
    │              │               │
    │              │    ┌──────────▼──────────┐
    │              │    │   memory-service     │
    │              │    │   (Python/FastAPI)   │
    │              │    │   sentence-          │
    │              │    │   transformers       │
    │              │    └──────────┬───────────┘
    │              │               │
┌───▼──────────────▼───────────────▼─────┐
│           Redis Streams Event Bus       │
│  (consumer groups, idempotency, DLQ)    │
├──────────────────┬─────────────────────┤
│   Alert Router   │   Task Scheduler    │
│  (rules, quiet   │  (cron, retry,      │
│   hours, cooldown│   config overrides)  │
│   audit trail)   │                     │
└────────┬─────────┴─────────────────────┘
         │
┌────────▼──────┐    ┌──────────────┐
│ Discord Sink  │    │  PostgreSQL   │
│ (embeds/text) │    │  + pgvector   │
└───────────────┘    │  (persist +   │
                     │  embeddings)  │
                     └──────────────┘
```

## LLM Provider Configuration

### Dual LLM Tier Routing (Cost Optimization)

Significantly reduce LLM costs by using a cheap "light" model (e.g., Haiku) for simple requests and automatically escalating to a capable "heavy" model (e.g., Sonnet) only when needed.

**How it works:**
- Every request starts with the light tier
- Simple tasks (notes, reminders, lookups) complete on the light model
- Complex patterns ("research", "analyze") or heavy tools (subagents, web crawling) trigger automatic escalation to heavy tier
- Only a few hundred cheap tokens are "wasted" on the initial light model call

**Configuration** (`config.yaml`):

```yaml
llm:
  tiers:
    enabled: true
    light:
      provider: "anthropic"
      model: "claude-haiku-3-5-20241022"
    heavy:
      provider: "anthropic"
      model: "claude-sonnet-4-5-20250514"
    heavy_tools:
      - "delegate_to_subagent"
      - "firecrawl_search"
      - "skill_activate"
    heavy_patterns:
      - "research"
      - "analyze"
      - "compare"
    heavy_message_length: 800
```

**Environment variable overrides:**
```bash
TIER_ENABLED=true
TIER_LIGHT_MODEL=claude-haiku-3-5-20241022
TIER_HEAVY_MODEL=claude-sonnet-4-5-20250514
```

**User commands:**
- `/model tier light <provider> <model>` - Override light tier model
- `/model tier heavy <provider> <model>` - Override heavy tier model
- `/model status` - View tier configuration and per-tier usage/costs

Tiers are **opt-in** (disabled by default). All existing behavior is preserved when tiers are disabled.

### Anthropic Claude (Recommended)

Best for tool calling and complex reasoning.

```bash
ANTHROPIC_API_KEY=sk-ant-...
```

### OpenAI

```bash
OPENAI_API_KEY=sk-...
```

### Google Gemini

Fast and cheap for simple tasks.

```bash
GOOGLE_API_KEY=AIza...
```

### OpenRouter (Access Multiple Models)

```bash
OPENROUTER_API_KEY=sk-or-...
```

Then use `/model set openrouter anthropic/claude-sonnet-4-5` to switch.

### Ollama (Local Models)

1. Install Ollama: https://ollama.ai
2. Pull a model: `ollama pull llama3.1:8b`
3. Start Ollama service
4. No API key needed - the bot will auto-detect Ollama on localhost:11434

```bash
# In Discord
/model set ollama llama3.1:8b
```

## Slash Commands

- `/ping` - Health check
- `/status` - Show loaded skills and their status
- `/help` - List available skills and what they can do
- `/model list` - Show all configured LLM providers and models
- `/model set <provider> <model>` - Switch to a different provider/model (sets both tiers when tier routing is enabled)
- `/model tier <light|heavy> <provider> <model>` - Set tier-specific model (requires tier routing enabled)
- `/model status` - Show current provider, model, capabilities, and today's token usage (includes per-tier breakdown when tiers enabled)

## Development Commands

```bash
pnpm dev           # Run with hot reload
pnpm build         # Compile TypeScript
pnpm test          # Run full test suite (279 tests)
pnpm test:unit     # Unit tests only
pnpm test:integration  # Integration tests only
pnpm test:phase2   # Phase 2 skill + integration tests
pnpm test:phase3   # Phase 3 infrastructure + integration tests
pnpm test:watch    # Run tests in watch mode
pnpm lint          # Type check without building
pnpm db:generate   # Generate Drizzle migrations
pnpm db:migrate    # Run database migrations
```

## Running with Docker

The fastest way to get coda running. Requires Docker and a Discord bot token + at least one LLM API key.

### Option 1: One-Liner Deploy (Recommended)

```bash
DISCORD_BOT_TOKEN=your_token \
DISCORD_CHANNEL_ID=your_channel_id \
OPENROUTER_API_KEY=your_key \
./scripts/deploy.sh
```

See the **Quick Deploy (Docker)** section above for full details.

### Option 2: Interactive Quickstart

```bash
# First run — creates .env and tells you which credentials to fill in
./scripts/quickstart.sh

# Edit .env with your Discord token + API key
vim .env

# Second run — builds, starts, migrates, and runs everything
./scripts/quickstart.sh
```

Both scripts handle all setup automatically:
- Generate a random postgres password in `secrets/pg_password.txt`
- Create `.env` with credentials
- Create `config/config.yaml` from the example
- Validate required credentials before starting
- Run `docker compose up --build -d`
- Wait for the health check to pass

Once running:

```bash
docker compose logs -f coda-core    # follow logs
docker compose ps                   # container status
curl localhost:3000/health           # health check
docker compose down                 # stop all containers
```

Database migrations run automatically on every startup — no manual `pnpm db:migrate` step needed when using Docker.

## Project Status

### Phase 1: Foundation (Complete)
- LLM provider abstraction (Anthropic, Google, OpenAI-compat)
- Discord bot interface with slash commands
- Core orchestrator with tool-calling loop
- Conversation context (in-memory)
- Confirmation flow for destructive actions
- Event bus + alert routing
- External skill SDK with security hardening
- 85 tests

### Phase 2: MVP Skills (Complete)
- Reminders skill (natural language time parsing, recurring, background checker)
- Notes skill (full-text search, tagging, context:always injection)
- Morning briefing (orchestrated multi-skill summary)
- Database singleton for internal skills
- Real Redis-backed skill context
- 108 new tests (193 total)

### Phase 3: Event Infrastructure (Complete)
- Redis Streams event bus (consumer groups, at-least-once delivery, idempotency keys, dead letter queue)
- Alert router (configurable rules per event type, severity levels, quiet hours with overrides, per-event cooldowns)
- Alert formatters (Discord embeds color-coded by severity, Slack Block Kit, plain text fallback)
- Task scheduler (cron-based via croner, automatic retry, config overrides, runtime toggle)
- Scheduler skill (list tasks, enable/disable via Discord with confirmation)
- Discord alert sink (embeds + plain text delivery)
- Alert history audit trail in PostgreSQL
- 86 new tests (279 total)

### Phase 4-7: See phase plan files for roadmap

## Security Notes

- The bot only responds in the designated Discord channel
- Only users in `DISCORD_ALLOWED_USER_IDS` can interact with it
- All external content (emails, API responses) is sanitized to prevent prompt injection
- Destructive actions (creating calendar events) require confirmation tokens
- PII is automatically redacted from logs
- External skills are sandboxed with integrity verification
- Alert cooldowns prevent notification spam; all alerts audited in PostgreSQL

## Troubleshooting

### Bot doesn't respond in Discord

1. Check the bot is running: look for "Discord bot connected" in logs
2. Verify `DISCORD_CHANNEL_ID` matches your channel
3. Verify `DISCORD_ALLOWED_USER_IDS` includes your Discord user ID
4. Check Message Content Intent is enabled in Discord Developer Portal

### Skills not loading

1. Notes and Reminders always load (they only need PostgreSQL)
3. Check logs for "Skill registered" or "missing required config" messages

### "No LLM providers available"

Make sure at least one of these is set in `.env`:
- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- `GOOGLE_API_KEY`
- `OPENROUTER_API_KEY`

Or Ollama is running locally.

### TypeScript errors

```bash
pnpm install
pnpm run lint
```

## Documentation

- [Integrations](integrations_readme.md) — n8n, Firecrawl
- [Skills](skills_readme.md) — Reminders, Notes, Memory, Scheduler, Agent Skills
- [Tool Catalog](tools_catalog.md) — Complete reference for all 64+ tools (tiers, flags, descriptions)
- [Skill Docker Images](docs/skill-docker-images.md) — Pre-built images for skills with dependencies
- [Architecture Overview](personal-assistant-architecture.md)
- [Phase 1 Plan](phase-1-foundation.md)
- [Phase 2 Plan](phase-2-mvp-skills.md)
- [Phase 3 Plan](phase-3-home-integration.md)
- [Phase 4-7 Plans](phase-3-home-integration.md)

## License

Private project. See repository for details.
