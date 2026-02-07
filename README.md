# coda - Personal AI Assistant Platform

**Current Status: Phase 1 Foundation Complete**

⚠️ **Important**: Only the core infrastructure is implemented. **No functional skills exist yet** (no email, calendar, Plex, etc.). The bot can chat using any LLM provider but cannot perform actions.

## What Works Now

- ✅ Multi-provider LLM support (Anthropic, Google Gemini, OpenAI, OpenRouter, Ollama)
- ✅ Discord bot with natural language + slash commands
- ✅ Conversation context tracking
- ✅ Provider switching at runtime
- ✅ Token usage tracking
- ❌ **No skills implemented** - bot cannot do anything useful yet

## Quick Start (Development Mode)

### Prerequisites

- Node.js 22+
- pnpm (`npm install -g pnpm`)
- At least one LLM API key (Anthropic, OpenAI, Google, or OpenRouter)
- Discord bot token and server setup

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

# Optional: Database (not needed for basic chat)
# DATABASE_URL=postgresql://coda:coda@localhost:5432/coda
# REDIS_URL=redis://localhost:6379
```

### 4. Run in Development Mode

**Without Docker (simplest for testing):**

```bash
pnpm dev
```

The bot will start and connect to Discord. You'll see:
```
coda agent is running
Discord bot connected
```

### 5. Test It

Go to your Discord channel and:

```
You: Hello!
Bot: Hi! I'm coda, your personal AI assistant. Right now I'm in Phase 1 - I can chat but I don't have any skills loaded yet.

You: /status
Bot: Skills loaded: 0
     No skills loaded.

You: /model list
Bot: **Available Providers**
     anthropic: claude-sonnet-4-5-20250514 (tools: true)
```

## Current Limitations

Since this is Phase 1 (foundation only), the bot:

- ✅ Can have conversations using any configured LLM
- ✅ Remembers conversation history (in-memory, resets on restart)
- ✅ Can switch between different LLM providers
- ✅ Tracks token usage and estimated costs
- ❌ **Cannot check email** (skill not implemented)
- ❌ **Cannot control Plex** (skill not implemented)
- ❌ **Cannot read calendar** (skill not implemented)
- ❌ **Cannot monitor UniFi network** (skill not implemented)
- ❌ **Cannot set reminders** (skill not implemented)

**Phase 2** (coming next) will implement the first functional skills.

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
└─────────────────┬───────────────────────┘
                  │
┌─────────────────▼───────────────────────┐
│       LLM Provider Manager               │
│  (Anthropic, Google, OpenAI-compat)      │
└──────────────────────────────────────────┘
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
pnpm dev          # Run with hot reload
pnpm build        # Compile TypeScript
pnpm test         # Run test suite (85 tests)
pnpm test:watch   # Run tests in watch mode
pnpm lint         # Type check without building
```

## Running with Docker (Full Stack)

**Note**: This requires PostgreSQL and Redis, which aren't needed for basic chat functionality.

```bash
# Copy secrets
echo "coda" > secrets/pg_password.txt

# Start services
docker-compose up -d

# Check logs
docker-compose logs -f coda-core
```

## Project Status

### ✅ Phase 1: Foundation (Complete)
- LLM provider abstraction
- Discord bot interface
- Core orchestrator with tool calling
- Conversation context
- Confirmation flow for destructive actions
- External skill SDK
- 85 tests, all passing

### 🚧 Phase 2: MVP Skills (Not Started)
- Email skill (IMAP polling, categorization)
- Calendar skill (CalDAV/Google Calendar)
- Reminder skill
- Notes/knowledge base skill
- Morning briefing command

### 📋 Phase 3-7: See phase-*.md files for roadmap

## Security Notes

- The bot only responds in the designated Discord channel
- Only users in `DISCORD_ALLOWED_USER_IDS` can interact with it
- All external content (emails, API responses) is sanitized to prevent prompt injection
- Destructive actions require confirmation tokens (Phase 2+)
- PII is automatically redacted from logs

## Troubleshooting

### Bot doesn't respond in Discord

1. Check the bot is running: look for "Discord bot connected" in logs
2. Verify `DISCORD_CHANNEL_ID` matches your channel
3. Verify `DISCORD_ALLOWED_USER_IDS` includes your Discord user ID
4. Check Message Content Intent is enabled in Discord Developer Portal

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

## Next Steps

To make this bot actually useful, you need to implement Phase 2 skills. See `phase-2-mvp-skills.md` for the implementation plan.

The skill framework is ready - you just need to create skill classes that implement the `Skill` interface in `src/skills/base.ts`.

## Documentation

- [Architecture Overview](personal-assistant-architecture.md)
- [Phase 1 Plan](phase-1-foundation.md) ← You are here
- [Phase 2 Plan](phase-2-mvp-skills.md) ← Next to implement
- [Phase 3-7 Plans](phase-3-home-integration.md)

## License

Private project. See repository for details.
