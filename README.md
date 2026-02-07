# coda - Personal AI Assistant Platform

**Current Status: Phase 2 MVP Skills Complete**

coda is a personal AI assistant that lives in Discord and manages your digital life. It connects to your email, calendar, and notes — and can deliver a morning briefing with a single message.

## What Works Now

- Multi-provider LLM support (Anthropic, Google Gemini, OpenAI, OpenRouter, Ollama)
- Discord bot with natural language + slash commands
- Conversation context tracking
- Provider switching at runtime
- Token usage tracking
- **Email** — IMAP polling, automatic categorization (urgent/needs response/informational/low priority), urgent email alerts
- **Calendar** — CalDAV integration, view today/upcoming events, create events with conflict detection, search
- **Reminders** — Natural language time parsing ("in 2 hours", "every Monday at 9am"), background due-reminder alerts, snooze
- **Notes** — Full-text search, tagging, `context:always` notes injected into every conversation
- **Morning Briefing** — Say "good morning" and get an email summary, today's schedule, and pending reminders in one response

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

# Optional: Email (IMAP)
IMAP_HOST=imap.gmail.com
IMAP_USER=you@gmail.com
IMAP_PASS=your_app_password

# Optional: Calendar (CalDAV)
CALDAV_SERVER_URL=https://caldav.example.com
CALDAV_USERNAME=you@example.com
CALDAV_PASSWORD=your_password
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

📧 Email: 12 new emails (2 urgent from boss@company.com)
📅 Calendar: 3 events today — Team standup at 9am, 1:1 with Jane at 2pm, Sprint review at 4pm
⏰ Reminders: 2 pending — Call dentist (due 2pm), Submit report (due 5pm)

You: Remind me to pick up groceries in 2 hours
Bot: Reminder set: "pick up groceries" — in 2 hours (3:00 PM)

You: Save a note: The WiFi password for the office is sunshine42
Bot: Note saved: "The WiFi password for the office is sun..."

You: Search my notes for WiFi
Bot: Found 1 note: "The WiFi password for the office is sunshine42"
```

## Skills

### Email

Polls your IMAP mailbox and categorizes emails automatically. Urgent emails trigger alerts.

| Tool | Description |
|------|-------------|
| `email_check` | Summary grouped by category (urgent, needs response, informational, low priority) |
| `email_read` | Read a specific email by UID |
| `email_search` | Filter by query, sender, or date |
| `email_flag` | Add/remove IMAP flags (flagged, seen, answered) |

Configure categorization rules in `config.yaml`:

```yaml
email:
  categorization:
    urgent_senders: ["boss@company.com", "cto@company.com"]
    urgent_keywords: ["URGENT", "ACTION REQUIRED"]
    known_contacts: ["friend@example.com"]
```

### Calendar

Connects to any CalDAV server (iCloud, Fastmail, Nextcloud, etc.).

| Tool | Description |
|------|-------------|
| `calendar_today` | Today's events |
| `calendar_upcoming` | Next N days, grouped by date |
| `calendar_create` | Create event (requires confirmation, checks for conflicts) |
| `calendar_search` | Search by keyword + optional date range |

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

### Morning Briefing

Say "morning", "good morning", "briefing", or "/briefing" and coda composes a natural summary from all available skills. Works gracefully when some skills are not configured.

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
└───┬─────────────┬───────────────────┬───┘
    │             │                   │
┌───▼───┐   ┌────▼────┐   ┌─────────▼──────┐
│ Skills │   │   LLM   │   │  Context Store  │
│Registry│   │Provider │   │  (history +     │
│        │   │Manager  │   │   facts)        │
└───┬────┘   └─────────┘   └────────────────┘
    │
┌───▼──────────────────────────────────┐
│  Email │ Calendar │ Reminders │ Notes │
│  IMAP  │  CalDAV  │ chrono-node│  DB  │
└──────────────────────────────────────┘
    │              │
┌───▼───┐    ┌─────▼─────┐
│ Redis │    │ PostgreSQL │
│(cache) │    │ (persist)  │
└────────┘    └────────────┘
```

## LLM Provider Configuration

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
- `/model set <provider> <model>` - Switch to a different provider/model
- `/model status` - Show current provider, model, capabilities, and today's token usage

## Development Commands

```bash
pnpm dev           # Run with hot reload
pnpm build         # Compile TypeScript
pnpm test          # Run full test suite (193 tests)
pnpm test:unit     # Unit tests only
pnpm test:integration  # Integration tests only
pnpm test:phase2   # Phase 2 skill + integration tests
pnpm test:watch    # Run tests in watch mode
pnpm lint          # Type check without building
pnpm db:generate   # Generate Drizzle migrations
pnpm db:migrate    # Run database migrations
```

## Running with Docker (Full Stack)

```bash
# Copy secrets
echo "coda" > secrets/pg_password.txt

# Start services
docker-compose up -d

# Check logs
docker-compose logs -f coda-core
```

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
- Email skill (IMAP polling, rules-based categorization, urgent alerts)
- Calendar skill (CalDAV integration, conflict detection)
- Reminders skill (natural language time parsing, recurring, background checker)
- Notes skill (full-text search, tagging, context:always injection)
- Morning briefing (orchestrated multi-skill summary)
- Database singleton for internal skills
- Real Redis-backed skill context
- 108 new tests (193 total)

### Phase 3-7: See phase plan files for roadmap

## Security Notes

- The bot only responds in the designated Discord channel
- Only users in `DISCORD_ALLOWED_USER_IDS` can interact with it
- All external content (emails, API responses) is sanitized to prevent prompt injection
- Destructive actions (creating calendar events) require confirmation tokens
- PII is automatically redacted from logs
- External skills are sandboxed with integrity verification

## Troubleshooting

### Bot doesn't respond in Discord

1. Check the bot is running: look for "Discord bot connected" in logs
2. Verify `DISCORD_CHANNEL_ID` matches your channel
3. Verify `DISCORD_ALLOWED_USER_IDS` includes your Discord user ID
4. Check Message Content Intent is enabled in Discord Developer Portal

### Skills not loading

1. Email and Calendar require external service config — check env vars or `config.yaml`
2. Notes and Reminders always load (they only need PostgreSQL)
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

- [Architecture Overview](personal-assistant-architecture.md)
- [Phase 1 Plan](phase-1-foundation.md)
- [Phase 2 Plan](phase-2-mvp-skills.md)
- [Phase 3-7 Plans](phase-3-home-integration.md)

## License

Private project. See repository for details.
