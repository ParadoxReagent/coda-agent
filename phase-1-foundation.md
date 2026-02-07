# Phase 1: Foundation & Core Engine

**Timeline:** Week 1
**Goal:** Stand up the runtime infrastructure, LLM provider abstraction, and core agent loop so that a user can send a message via Discord and get an LLM-powered response from any configured provider.

---

## 1.1 Infrastructure Setup

### Docker Compose Stack
- [ ] Create `docker-compose.yml` with three services:
  - **coda-core** — Node.js 22 LTS container (Fastify + Discord bot)
  - **redis** — Redis 7 Alpine (cache + event bus)
  - **postgres** — Postgres 16 Alpine (persistent state)
- [ ] Define two Docker networks:
  - `coda-internal` (bridge, `internal: true`) — Redis & Postgres only reachable here
  - `lan-bridge` (macvlan or host) — LAN access for future UniFi/Plex skills
- [ ] Configure Docker secrets for Postgres password
- [ ] Create named volumes: `coda-data`, `redis-data`, `pg-data`
- [ ] Write `Dockerfile` (multi-stage: builder with `npm ci` + slim runtime with `node:22-alpine`)

### Database Bootstrap
- [ ] Set up Drizzle ORM with `drizzle-kit` for migrations
- [ ] Create initial migration for core tables:
  - `conversations` — conversation history per user/channel
  - `context_facts` — long-term extracted facts (key-value with metadata)
  - `skills_config` — per-skill configuration and state
  - `llm_usage` — token usage tracking per provider/model/day
- [ ] Seed script for initial config values

### Configuration
- [ ] Create `config/config.yaml` template with sections for each service
- [ ] Implement `src/utils/config.ts` — YAML loader with env-var override support (using `js-yaml`)
- [ ] Document SOPS/age encryption workflow for secrets
- [ ] Create `.env.example` with all required environment variables

---

## 1.2 LLM Provider Abstraction

### Why Two Libraries Cover Everything

The LLM landscape consolidates into two wire protocols:
- **Anthropic format** — Claude models via `@anthropic-ai/sdk`
- **OpenAI-compatible format** — Everything else via the `openai` npm package with a configurable `baseURL`

| Provider | Library | Config |
|----------|---------|--------|
| Anthropic (Claude) | `@anthropic-ai/sdk` | `apiKey` |
| OpenAI (GPT-4, etc.) | `openai` | `apiKey` |
| OpenRouter | `openai` | `baseURL: "https://openrouter.ai/api/v1"`, `apiKey` |
| Google Gemini | `openai` | `baseURL: "https://generativelanguage.googleapis.com/v1beta/openai"`, `apiKey` |
| LiteLLM | `openai` | `baseURL: "http://localhost:4000/v1"` |
| LM Studio | `openai` | `baseURL: "http://localhost:1234/v1"` |
| Ollama | `openai` | `baseURL: "http://localhost:11434/v1"` |

### Provider Interface (`src/core/llm/provider.ts`)

- [ ] Define a provider-agnostic `LLMProvider` interface:
  ```typescript
  interface LLMMessage {
    role: "user" | "assistant" | "system";
    content: string | ContentBlock[];
  }

  interface LLMToolDefinition {
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
  }

  interface LLMToolCall {
    id: string;
    name: string;
    input: Record<string, unknown>;
  }

  interface LLMResponse {
    text: string | null;
    toolCalls: LLMToolCall[];
    stopReason: "end_turn" | "tool_use" | "max_tokens";
    usage: { inputTokens: number; outputTokens: number };
    model: string;
    provider: string;
  }

  interface LLMProvider {
    readonly name: string;  // "anthropic", "openai", "openrouter", etc.
    chat(params: {
      model: string;
      system: string;
      messages: LLMMessage[];
      tools?: LLMToolDefinition[];
      maxTokens?: number;
    }): Promise<LLMResponse>;
  }
  ```

### Anthropic Adapter (`src/core/llm/anthropic.ts`)
- [ ] Implement `AnthropicProvider` using `@anthropic-ai/sdk`:
  - Translates `LLMToolDefinition` → Anthropic tool format
  - Translates Anthropic response → `LLMResponse`
  - Maps Anthropic `stop_reason` values to normalized `stopReason`
  - Extracts `tool_use` blocks into `LLMToolCall[]`

### OpenAI-Compatible Adapter (`src/core/llm/openai-compat.ts`)
- [ ] Implement `OpenAICompatProvider` using `openai` package:
  - Accepts `baseURL` and `apiKey` in constructor
  - Translates `LLMToolDefinition` → OpenAI function-calling format
  - Translates OpenAI response → `LLMResponse`
  - Maps OpenAI `finish_reason` values to normalized `stopReason`
  - Extracts `tool_calls` from OpenAI choice into `LLMToolCall[]`
  - Works for: OpenAI, OpenRouter, Gemini, LiteLLM, LM Studio, Ollama

### Provider Factory (`src/core/llm/factory.ts`)
- [ ] Implement `createProvider(config)` factory:
  ```typescript
  // Config-driven provider instantiation
  function createProvider(config: ProviderConfig): LLMProvider {
    if (config.type === "anthropic") {
      return new AnthropicProvider(config.apiKey);
    }
    // Everything else is OpenAI-compatible
    return new OpenAICompatProvider({
      baseURL: config.baseURL,
      apiKey: config.apiKey,
      name: config.name,  // "openai", "openrouter", "ollama", etc.
    });
  }
  ```

### Provider Configuration
- [ ] Config structure in `config.yaml`:
  ```yaml
  llm:
    # Which provider to use by default
    default_provider: "anthropic"
    default_model: "claude-sonnet-4-5-20250514"

    providers:
      anthropic:
        type: "anthropic"
        api_key: "sk-ant-..."
        models:
          - "claude-sonnet-4-5-20250514"
          - "claude-haiku-3-5-20241022"

      openai:
        type: "openai_compat"
        base_url: "https://api.openai.com/v1"
        api_key: "sk-..."
        models:
          - "gpt-4o"
          - "gpt-4o-mini"

      openrouter:
        type: "openai_compat"
        base_url: "https://openrouter.ai/api/v1"
        api_key: "sk-or-..."
        models:
          - "anthropic/claude-sonnet-4-5"
          - "google/gemini-2.0-flash"

      ollama:
        type: "openai_compat"
        base_url: "http://localhost:11434/v1"
        api_key: "ollama"  # Ollama ignores this but the SDK requires it
        models:
          - "llama3.1:8b"
          - "mistral:7b"

      lmstudio:
        type: "openai_compat"
        base_url: "http://localhost:1234/v1"
        api_key: "lm-studio"
        models:
          - "loaded-model"
  ```
- [ ] Slash command `/model` to switch provider/model at runtime:
  - `/model list` — show available providers and models
  - `/model set openrouter anthropic/claude-sonnet-4-5` — switch provider and model
  - `/model status` — show current provider, model, and today's token usage
- [ ] Current provider/model stored in Redis (per-user preference, falls back to config default)

### LLM Usage Tracking (`src/core/llm/usage.ts`)
- [ ] Track token usage per request:
  - Provider name, model name, input tokens, output tokens, timestamp
  - Store in Postgres `llm_usage` table
  - Aggregate daily totals in Redis for fast access
- [ ] Estimated cost calculation:
  - Configurable cost-per-token rates per provider/model in config
  - Daily cost estimate available via `/model status`
- [ ] Optional daily spend alert: publish `alert.system.llm_cost` if daily spend exceeds threshold

---

## 1.3 Core Orchestrator

### Agent Loop (`src/core/orchestrator.ts`)
- [ ] Implement `Orchestrator` class:
  ```typescript
  class Orchestrator {
    constructor(
      private providerManager: ProviderManager,
      private skills: SkillRegistry,
      private context: ContextStore
    ) {}

    async handleMessage(userId: string, message: string, channel: string): Promise<string> {
      // 1. Load conversation context
      const history = await this.context.getHistory(userId, channel);

      // 2. Get user's preferred provider + model (or defaults)
      const { provider, model } = await this.providerManager.getForUser(userId);

      // 3. Build system prompt with available skills as tools
      const tools = this.skills.getToolDefinitions();
      const system = this.buildSystemPrompt(userId);

      // 4. Agent loop (tool use cycle) — provider-agnostic
      let response = await provider.chat({
        model,
        system,
        messages: [...history, { role: "user", content: message }],
        tools,
        maxTokens: 4096,
      });

      // 5. Track usage
      await this.providerManager.trackUsage(provider.name, model, response.usage);

      // 6. Execute tool calls, feed results back, iterate
      while (response.stopReason === "tool_use") {
        const toolResults = await this.executeTools(response.toolCalls);
        response = await provider.chat({ /* ... with tool results */ });
        await this.providerManager.trackUsage(provider.name, model, response.usage);
      }

      // 7. Save context, return response
      await this.context.save(userId, channel, message, response);
      return response.text ?? "I didn't have a response for that.";
    }
  }
  ```
- [ ] Implement the tool-use loop with safeguards:
  - Max tool calls per turn (default: 10)
  - Total token budget per conversation turn
  - Timeout per tool execution (default: 30s)

### Context Management (`src/core/context.ts`)
- [ ] Implement `ContextStore` class backed by Redis + Postgres:
  - `getHistory(userId, channel)` — retrieve last N messages (Redis, 24h TTL)
  - `save(userId, channel, userMsg, assistantMsg)` — append to history
  - `getFacts(userId)` — retrieve long-term facts from Postgres
  - `saveFact(userId, key, value)` — persist a long-term fact
- [ ] Short-term: last 50 messages per user/channel in Redis (24h TTL)
- [ ] Medium-term: daily conversation summaries (30-day TTL) — stub for now
- [ ] Long-term: key facts in Postgres `context_facts` table

### Content Sanitizer (`src/core/sanitizer.ts`)
- [ ] Implement `ContentSanitizer` with methods per content type:
  - `sanitizeEmail(content)` — HTML entity escaping + untrusted data wrapper
  - `sanitizeApiResponse(content)` — generic external data wrapper
- [ ] All external content wrapped in explicit `<external_content>` delimiters with injection warnings

---

## 1.4 Skill Framework

### Base Skill (`src/skills/base.ts`)
- [ ] Define abstract `Skill` interface:
  ```typescript
  interface Skill {
    readonly name: string;
    readonly description: string;
    getTools(): LLMToolDefinition[];  // Provider-agnostic tool format
    execute(toolName: string, toolInput: Record<string, unknown>): Promise<string>;
    getRequiredConfig(): string[];
    startup(): Promise<void>;
    shutdown(): Promise<void>;
  }
  ```
- [ ] Note: skills use `LLMToolDefinition` (the coda-internal format), not any provider-specific format. The provider adapter handles translation.

### Skill Registry (`src/skills/registry.ts`)
- [ ] Implement `SkillRegistry`:
  - `register(skill)` — validate config requirements, add to registry
  - `getToolDefinitions()` — aggregate all tools from all registered skills
  - `routeToolCall(toolName)` — find which skill owns a tool
  - `startupAll()` / `shutdownAll()` — lifecycle management
- [ ] Auto-discovery: scan `src/skills/*/` for `Skill` implementations on startup

### Skill Executor
- [ ] Implement tool call dispatch with:
  - Per-skill rate limiting
  - Execution timeout (via `AbortController` + `setTimeout`)
  - Error wrapping (skill errors become user-friendly messages, not stack traces)
  - Structured logging of every tool call + result

---

## 1.5 Discord Bot Interface

### Bot Setup (`src/interfaces/discord-bot.ts`)
- [ ] Implement Discord bot using `discord.js`:
  - Connect using bot token from config
  - Listen in a single designated channel (`ALLOWED_CHANNEL_ID`)
  - Restrict to a single user (`ALLOWED_USER_IDS` set)
  - Ignore bot messages
- [ ] Message handling:
  - On message in allowed channel from allowed user → send to `orchestrator.handleMessage()`
  - Chunk responses at 1900 chars (Discord limit is 2000)
  - Show typing indicator while processing
- [ ] Embed support for structured responses (email summaries, network status)
- [ ] Error handling: if orchestrator fails, send a clean error message (not a stack trace)

### Slash Commands (basic)
- [ ] `/ping` — health check
- [ ] `/status` — show which skills are loaded and their status
- [ ] `/help` — list available skills and what they can do
- [ ] `/model list` — show available providers and models
- [ ] `/model set <provider> <model>` — switch LLM provider/model
- [ ] `/model status` — show current provider, model, and today's usage

---

## 1.6 Application Entry Point

### Main (`src/main.ts`)
- [ ] Load configuration
- [ ] Initialize Redis (`ioredis`) + Postgres (`drizzle-orm` + `postgres.js`) connections
- [ ] Initialize LLM providers from config (create all configured providers via factory)
- [ ] Create `ProviderManager` with providers + default selection
- [ ] Create orchestrator with provider manager and context store
- [ ] Register all discovered skills
- [ ] Start Discord bot
- [ ] Start HTTP server (Fastify for health checks + future REST API)
- [ ] Graceful shutdown handler (`SIGTERM`/`SIGINT` — close connections, stop skill background tasks)

### Health & Observability
- [ ] `/health` endpoint — checks Redis, Postgres, default LLM provider reachability
- [ ] Structured logging with `pino` — JSON output for all core operations
- [ ] Log every message received, tool call made, and response sent (no PII in default log level)

---

## 1.7 Project Structure

```
coda/
├── docker-compose.yml
├── Dockerfile
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── drizzle.config.ts
├── config/
│   ├── config.yaml              # Main config (encrypted)
│   ├── alerts.yaml              # Alert routing rules
│   └── known_clients.yaml       # Known UniFi clients (MAC allowlist)
├── src/
│   ├── main.ts                  # Entry point
│   ├── core/
│   │   ├── orchestrator.ts      # Agent loop — provider-agnostic
│   │   ├── context.ts           # Conversation context management
│   │   ├── events.ts            # Event bus (Redis Streams)
│   │   ├── alerts.ts            # Alert router
│   │   ├── sanitizer.ts         # Content sanitization
│   │   └── llm/
│   │       ├── provider.ts      # LLMProvider interface + types
│   │       ├── anthropic.ts     # Anthropic adapter
│   │       ├── openai-compat.ts # OpenAI-compatible adapter
│   │       ├── factory.ts       # Provider factory
│   │       ├── manager.ts       # Provider selection + per-user prefs
│   │       └── usage.ts         # Token/cost tracking
│   ├── skills/
│   │   ├── base.ts              # Skill interface + abstract base
│   │   ├── registry.ts          # Skill registration + discovery
│   │   ├── email/
│   │   ├── calendar/
│   │   ├── plex/
│   │   ├── unifi/
│   │   ├── reminders/
│   │   └── ...
│   ├── interfaces/
│   │   ├── discord-bot.ts
│   │   ├── slack-bot.ts
│   │   └── rest-api.ts
│   ├── db/
│   │   ├── schema.ts            # Drizzle schema definitions
│   │   ├── index.ts             # DB connection + client export
│   │   └── migrations/
│   └── utils/
│       ├── config.ts
│       ├── logger.ts
│       └── crypto.ts
├── tests/
│   ├── unit/
│   │   ├── core/
│   │   │   ├── orchestrator.test.ts
│   │   │   ├── context.test.ts
│   │   │   ├── sanitizer.test.ts
│   │   │   └── llm/
│   │   │       ├── anthropic.test.ts
│   │   │       ├── openai-compat.test.ts
│   │   │       ├── factory.test.ts
│   │   │       ├── manager.test.ts
│   │   │       └── usage.test.ts
│   │   └── skills/
│   │       └── registry.test.ts
│   ├── integration/
│   │   ├── orchestrator-llm.test.ts
│   │   └── discord-bot.test.ts
│   └── helpers/
│       ├── mocks.ts
│       └── fixtures.ts
└── scripts/
    ├── setup-unifi-account.sh
    └── rotate-keys.sh
```

---

## 1.8 Test Suite — Phase 1 Gate

All tests must pass before proceeding to Phase 2. Tests are structured for compatibility with automated test loops (e.g., Ralph Wiggum loop — an LLM agent that iterates on code until all tests go green).

### Test Framework & Config
- [ ] **Vitest** as the test runner (`vitest.config.ts`)
- [ ] **Test scripts** in `package.json`:
  - `test` — run all tests
  - `test:unit` — unit tests only
  - `test:integration` — integration tests only
  - `test:phase1` — run only Phase 1 tests (via Vitest workspace or tag filter)
- [ ] **Coverage** target: 80%+ on `src/core/**` for Phase 1

### Unit Tests

**LLM Provider Interface (`tests/unit/core/llm/provider.test.ts`)**
- [ ] `LLMResponse` type includes all required fields (text, toolCalls, stopReason, usage, model, provider)
- [ ] `LLMToolCall` contains id, name, and input

**Anthropic Adapter (`tests/unit/core/llm/anthropic.test.ts`)**
- [ ] Translates coda tool definitions to Anthropic format correctly
- [ ] Maps Anthropic text response to `LLMResponse` with `stopReason: "end_turn"`
- [ ] Maps Anthropic tool_use response to `LLMResponse` with populated `toolCalls`
- [ ] Extracts input/output token counts from Anthropic usage
- [ ] Handles Anthropic API errors (rate limit, server error) gracefully

**OpenAI-Compatible Adapter (`tests/unit/core/llm/openai-compat.test.ts`)**
- [ ] Translates coda tool definitions to OpenAI function-calling format
- [ ] Maps OpenAI text response to `LLMResponse` with `stopReason: "end_turn"`
- [ ] Maps OpenAI tool_calls response to `LLMResponse` with populated `toolCalls`
- [ ] Extracts input/output token counts from OpenAI usage
- [ ] Passes correct `baseURL` to OpenAI client constructor
- [ ] Works with different `baseURL` values (OpenRouter, Ollama, LM Studio)
- [ ] Handles OpenAI API errors (rate limit, server error) gracefully

**Provider Factory (`tests/unit/core/llm/factory.test.ts`)**
- [ ] Creates `AnthropicProvider` for `type: "anthropic"` config
- [ ] Creates `OpenAICompatProvider` for `type: "openai_compat"` config
- [ ] Passes correct `baseURL` and `apiKey` to OpenAI-compat provider
- [ ] Throws for unknown provider type

**Provider Manager (`tests/unit/core/llm/manager.test.ts`)**
- [ ] Returns default provider/model when user has no preference
- [ ] Returns user's preferred provider/model when set
- [ ] `setUserPreference()` persists and `getForUser()` retrieves
- [ ] Falls back to default if user's preferred provider is unavailable
- [ ] Lists all available providers and their models

**Usage Tracking (`tests/unit/core/llm/usage.test.ts`)**
- [ ] `trackUsage()` stores token counts per provider/model
- [ ] `getDailyUsage()` aggregates today's tokens by provider
- [ ] `getEstimatedCost()` calculates cost from token counts and configured rates
- [ ] Daily spend alert publishes event when threshold exceeded
- [ ] Handles missing cost configuration gracefully (logs warning, no crash)

**Orchestrator (`tests/unit/core/orchestrator.test.ts`)**
- [ ] Constructs with injected dependencies (provider manager, registry, context store)
- [ ] Calls provider with correct system prompt, history, and tools
- [ ] Executes tool calls when `stopReason === "tool_use"` and loops correctly
- [ ] Stops looping when `stopReason === "end_turn"`
- [ ] Respects max tool calls per turn — returns graceful message at limit
- [ ] Handles LLM API errors (throws/retries appropriately)
- [ ] Saves conversation to context store after successful response
- [ ] Does not save to context store on error
- [ ] Tracks token usage after each LLM call

**Context Store (`tests/unit/core/context.test.ts`)**
- [ ] `getHistory()` returns empty array for new user
- [ ] `save()` stores message and `getHistory()` retrieves it
- [ ] History is scoped per user and per channel
- [ ] History respects max message limit (50)
- [ ] `saveFact()` persists and `getFacts()` retrieves
- [ ] Facts are scoped per user

**Content Sanitizer (`tests/unit/core/sanitizer.test.ts`)**
- [ ] `sanitizeEmail()` escapes HTML angle brackets
- [ ] `sanitizeEmail()` wraps content in `<external_content>` tags with warning
- [ ] `sanitizeApiResponse()` wraps content with untrusted data delimiter
- [ ] Handles empty strings, null-ish values, and very long content

**Skill Registry (`tests/unit/skills/registry.test.ts`)**
- [ ] Registers a skill and includes its tools in `getToolDefinitions()`
- [ ] `routeToolCall()` returns the correct skill for a given tool name
- [ ] `routeToolCall()` throws for unknown tool names
- [ ] Rejects skills with missing required config
- [ ] Calls `startup()` on all skills during `startupAll()`
- [ ] Calls `shutdown()` on all skills during `shutdownAll()`

### Integration Tests

**Orchestrator + LLM (`tests/integration/orchestrator-llm.test.ts`)**
- [ ] End-to-end: send a simple message → get a text response (mocked Anthropic provider)
- [ ] End-to-end: send a simple message → get a text response (mocked OpenAI-compat provider)
- [ ] End-to-end: send a message that triggers tool use → tool executes → final response returned
- [ ] Conversation history accumulates across multiple `handleMessage` calls
- [ ] Switching provider mid-conversation works correctly
- [ ] Token usage is tracked across multiple turns

**Discord Bot (`tests/integration/discord-bot.test.ts`)**
- [ ] Bot ignores messages from non-allowed users
- [ ] Bot ignores messages in non-allowed channels
- [ ] Bot ignores messages from other bots
- [ ] Bot forwards allowed messages to orchestrator
- [ ] Bot chunks long responses (>1900 chars) into multiple messages
- [ ] Bot shows typing indicator while processing
- [ ] `/model list` returns available providers and models
- [ ] `/model set` updates user preference

### Test Helpers
- [ ] `createMockAnthropicProvider()` — mock Anthropic adapter with configurable responses
- [ ] `createMockOpenAIProvider()` — mock OpenAI-compat adapter with configurable responses
- [ ] `createMockProviderManager()` — mock manager that returns specified provider
- [ ] `createMockSkill()` — returns a mock skill with configurable tools and execute behavior
- [ ] `createMockRedis()` — in-memory Redis mock (or use `ioredis-mock`)
- [ ] `createTestFixtures()` — standard test data (users, messages, tool calls)

---

## Acceptance Criteria

1. `docker-compose up` brings up coda-core, Redis, and Postgres
2. Sending a message in the designated Discord channel gets an LLM-powered response
3. `/model set openai gpt-4o` switches the LLM provider and subsequent messages use OpenAI
4. `/model set ollama llama3.1:8b` switches to a local Ollama model
5. Conversation history persists across messages within a session
6. `/status` slash command shows the orchestrator is running with 0 skills loaded
7. `/model status` shows current provider, model, and today's token usage
8. `/health` returns 200 with service connectivity status
9. All config is loaded from `config.yaml` with env-var overrides
10. Logs are structured JSON with request correlation IDs
11. **`npm run test:phase1` passes with 0 failures**

---

## Key Decisions for This Phase

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Runtime | Node.js 22 LTS | Long-term support, native TypeScript via `--experimental-strip-types` or tsx |
| ORM | Drizzle ORM + postgres.js | Type-safe, lightweight, great migration tooling |
| Redis client | ioredis | Battle-tested, full Redis Streams support, async |
| Logging | pino | Fastest structured JSON logger in Node, low overhead |
| HTTP framework | Fastify | Faster than Express, schema validation built in, plugin ecosystem |
| LLM abstraction | 2 libraries + adapter pattern | `@anthropic-ai/sdk` + `openai` covers every provider with minimal code |
| Default LLM | Configurable (user choice) | No vendor lock-in, provider-agnostic from day one |
| Test framework | Vitest | Fast, native TypeScript, ESM support, watch mode |
| Package manager | pnpm | Fast, strict, disk-efficient |

---

## Key Dependencies

```json
{
  "dependencies": {
    "@anthropic-ai/sdk": "^0.52.0",
    "openai": "^4.80.0",
    "discord.js": "^14.16.0",
    "drizzle-orm": "^0.36.0",
    "fastify": "^5.2.0",
    "ioredis": "^5.4.0",
    "js-yaml": "^4.1.0",
    "pino": "^9.6.0",
    "postgres": "^3.4.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@types/js-yaml": "^4.0.9",
    "@types/node": "^22.0.0",
    "drizzle-kit": "^0.30.0",
    "ioredis-mock": "^8.9.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```
