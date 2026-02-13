# Phase 1: Foundation & Core Engine -----DONE

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

### Three Adapters Cover Everything

The LLM landscape consolidates into three wire protocols, each with its own SDK:
- **Anthropic format** — Claude models via `@anthropic-ai/sdk`
- **Google format** — Gemini models via `@google/genai` (native tool calling, structured output, usage metrics that differ from OpenAI)
- **OpenAI-compatible format** — Everything else via the `openai` npm package with a configurable `baseURL`

Google Gemini's OpenAI compatibility endpoint has known gaps in tool calling (`tool_choice` semantics, no `parallel_tool_calls`, different structured output handling). Using Google's native SDK avoids these issues.

| Provider | Library | Config |
|----------|---------|--------|
| Anthropic (Claude) | `@anthropic-ai/sdk` | `apiKey` |
| Google Gemini | `@google/genai` | `apiKey` |
| OpenAI (GPT-4, etc.) | `openai` | `apiKey` |
| OpenRouter | `openai` | `baseURL: "https://openrouter.ai/api/v1"`, `apiKey`, extra headers |
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
    usage: { inputTokens: number | null; outputTokens: number | null };
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

### Provider Capabilities (`src/core/llm/capabilities.ts`)
- [ ] Define `ProviderCapabilities` interface:
  ```typescript
  interface ProviderCapabilities {
    tools: boolean | "model_dependent";     // supports tool/function calling
    parallelToolCalls: boolean;             // supports parallel_tool_calls param
    usageMetrics: boolean;                  // reliably reports token usage
    jsonMode: boolean;                      // supports structured JSON output
    streaming: boolean;                     // supports streaming responses
  }
  ```
- [ ] Each adapter declares default capabilities; config can override per provider
- [ ] Orchestrator checks capabilities before sending tools:
  - If `tools === false`, omit tools from the request (prompt-only mode)
  - If `tools === "model_dependent"`, attempt tool call and handle gracefully if unsupported
  - If `usageMetrics === false`, accept `null` usage values without logging warnings
  - If `parallelToolCalls === false`, omit that parameter from the request

### Anthropic Adapter (`src/core/llm/anthropic.ts`)
- [ ] Implement `AnthropicProvider` using `@anthropic-ai/sdk`:
  - Translates `LLMToolDefinition` → Anthropic tool format
  - Translates Anthropic response → `LLMResponse`
  - Maps Anthropic `stop_reason` values to normalized `stopReason`
  - Extracts `tool_use` blocks into `LLMToolCall[]`
  - Default capabilities: `{ tools: true, parallelToolCalls: true, usageMetrics: true, jsonMode: true, streaming: true }`

### Google Adapter (`src/core/llm/google.ts`)
- [ ] Implement `GoogleProvider` using `@google/genai`:
  - Translates `LLMToolDefinition` → Gemini `FunctionDeclaration` format
  - Translates Gemini `GenerateContentResponse` → `LLMResponse`
  - Maps Gemini `finishReason` values to normalized `stopReason`
  - Extracts `functionCall` parts into `LLMToolCall[]`
  - Handles Gemini-specific usage metadata (`usageMetadata.promptTokenCount`, `candidatesTokenCount`)
  - Default capabilities: `{ tools: true, parallelToolCalls: false, usageMetrics: true, jsonMode: true, streaming: true }`

### OpenAI-Compatible Adapter (`src/core/llm/openai-compat.ts`)
- [ ] Implement `OpenAICompatProvider` using `openai` package:
  - Accepts `baseURL`, `apiKey`, and optional `defaultHeaders` in constructor
  - Translates `LLMToolDefinition` → OpenAI function-calling format
  - Translates OpenAI response → `LLMResponse`
  - Maps OpenAI `finish_reason` values to normalized `stopReason`
  - Extracts `tool_calls` from OpenAI choice into `LLMToolCall[]`
  - Handles missing `usage` fields gracefully (returns `null` tokens)
  - Works for: OpenAI, OpenRouter, LiteLLM, LM Studio, Ollama
  - Default capabilities: `{ tools: true, parallelToolCalls: true, usageMetrics: true, jsonMode: true, streaming: true }`
  - Per-provider capability overrides applied from config

### Provider Factory (`src/core/llm/factory.ts`)
- [ ] Implement `createProvider(config)` factory:
  ```typescript
  function createProvider(config: ProviderConfig): LLMProvider {
    switch (config.type) {
      case "anthropic":
        return new AnthropicProvider(config.apiKey, config.capabilities);
      case "google":
        return new GoogleProvider(config.apiKey, config.capabilities);
      case "openai_compat":
        return new OpenAICompatProvider({
          baseURL: config.baseURL,
          apiKey: config.apiKey,
          name: config.name,
          defaultHeaders: config.defaultHeaders,
          capabilities: config.capabilities,
        });
      default:
        throw new Error(`Unknown provider type: ${config.type}`);
    }
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

      google:
        type: "google"
        api_key: "AIza..."
        models:
          - "gemini-2.0-flash"
          - "gemini-2.0-pro"
        capabilities:
          parallel_tool_calls: false  # Gemini does not support this

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
        default_headers:
          HTTP-Referer: "https://coda-agent.local"
          X-Title: "coda"
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
        capabilities:
          tools: "model_dependent"  # depends on loaded model
          usage_metrics: false      # Ollama may not report usage
          json_mode: false

      lmstudio:
        type: "openai_compat"
        base_url: "http://localhost:1234/v1"
        api_key: "lm-studio"
        models:
          - "loaded-model"
        capabilities:
          tools: "model_dependent"
          usage_metrics: false
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
  - Gracefully handle `null` usage values from providers that don't report metrics (Ollama, LM Studio) — log the request without token counts, skip cost calculation
- [ ] Estimated cost calculation:
  - Configurable cost-per-token rates per provider/model in config
  - Daily cost estimate available via `/model status`
  - Providers with `usageMetrics: false` show "usage not tracked" instead of $0.00
- [ ] Optional daily spend alert: publish `alert.system.llm_cost` if daily spend exceeds threshold

---

## 1.3 Event Abstraction & Security Baseline

### Thin Event Bus (`src/core/events.ts`)
- [ ] Implement a lightweight `EventBus` interface that Phase 2+ producers use to publish events:
  ```typescript
  interface CodaEvent {
    eventType: string;         // "alert.email.urgent", "alert.reminder.due"
    timestamp: string;         // ISO 8601
    sourceSkill: string;       // "email", "reminders", etc.
    payload: Record<string, unknown>;
    severity: "high" | "medium" | "low";
  }

  interface EventBus {
    publish(event: CodaEvent): Promise<void>;
    subscribe(pattern: string, handler: (event: CodaEvent) => Promise<void>): void;
  }
  ```
- [ ] Phase 1 implementation: simple in-process `EventEmitter`-based adapter (~30 lines)
  - Events dispatched synchronously to registered handlers
  - No persistence, no consumer groups (that comes in Phase 3 with Redis Streams)
- [ ] Phase 3 replaces the in-process implementation with Redis Streams — same interface, new backend
- [ ] All alert producers (Phase 2+) call `eventBus.publish()` instead of directly calling Discord/Slack

### Log Redaction Policy
- [ ] Configure `pino` with redaction paths from day one:
  ```typescript
  const logger = pino({
    redact: {
      paths: [
        "msg.emailBody", "msg.messageContent", "msg.credentials",
        "msg.apiKey", "msg.password", "msg.token",
        "msg.*.emailBody", "msg.*.messageContent"
      ],
      censor: "[REDACTED]",
    },
  });
  ```
- [ ] Default log level `INFO` never logs message content, email bodies, or credentials
- [ ] `DEBUG` level may include redacted tool call inputs/outputs for troubleshooting
- [ ] Document the redaction policy in a comment block at the top of `src/utils/logger.ts`

### Retention Policy Constants (`src/utils/retention.ts`)
- [ ] Define retention TTLs as named constants used by all schema definitions and Redis operations:
  ```typescript
  export const RETENTION = {
    CONVERSATION_HISTORY: 24 * 60 * 60,       // 24h in Redis
    CONVERSATION_SUMMARY: 30 * 24 * 60 * 60,  // 30 days
    EMAIL_CACHE: 24 * 60 * 60,                // 24h in Redis
    CONTEXT_FACTS: 365 * 24 * 60 * 60,        // default 1 year (configurable)
    LLM_USAGE: 90 * 24 * 60 * 60,            // 90 days in Postgres
    ALERT_COOLDOWN: 5 * 60,                   // 5 min in Redis
    CONFIRMATION_TOKEN: 5 * 60,               // 5 min in Redis
  } as const;
  ```
- [ ] All Redis `SET`/`EXPIRE` calls and Postgres cleanup jobs reference these constants
- [ ] User privacy controls:
  - Export and delete endpoints/commands for `context_facts`
  - Retention override per fact category (short-lived vs persistent) with explicit opt-in for permanent storage
- [ ] Prevents magic numbers scattered across skills and makes retention auditable

---

## 1.4 Core Orchestrator

### Agent Loop (`src/core/orchestrator.ts`)
- [ ] Implement `Orchestrator` class:
  ```typescript
  class Orchestrator {
    constructor(
      private providerManager: ProviderManager,
      private skills: SkillRegistry,
      private context: ContextStore,
      private eventBus: EventBus,
    ) {}

    async handleMessage(userId: string, message: string, channel: string): Promise<string> {
      // 1. Load conversation context
      const history = await this.context.getHistory(userId, channel);

      // 2. Get user's preferred provider + model (or defaults)
      const { provider, model } = await this.providerManager.getForUser(userId);

      // 3. Build system prompt with available skills as tools
      //    Only include tools if provider supports tool calling
      const capabilities = provider.capabilities;
      const tools = capabilities.tools ? this.skills.getToolDefinitions() : undefined;
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
  - `getHistory(userId, channel?)` — retrieve last N messages (Redis, 24h TTL), optionally filtered to one channel
  - `save(userId, channel, userMsg, assistantMsg)` — append to shared user history with channel metadata
  - `getFacts(userId)` — retrieve long-term facts from Postgres
  - `saveFact(userId, key, value)` — persist a long-term fact
- [ ] Short-term: last 50 messages per user (cross-channel) in Redis (24h TTL), each record tagged with source channel
- [ ] Medium-term: daily conversation summaries (30-day TTL) — stub for now
- [ ] Long-term: key facts in Postgres `context_facts` table

### Content Sanitizer (`src/core/sanitizer.ts`)
- [ ] Implement `ContentSanitizer` with methods per content type:
  - `sanitizeEmail(content)` — HTML entity escaping + untrusted data wrapper
  - `sanitizeApiResponse(content)` — generic external data wrapper
- [ ] All external content wrapped in explicit `<external_content>` delimiters with injection warnings

---

## 1.5 Skill Framework & External Skill SDK

### Skill Contract (`src/skills/base.ts`)

This interface is the **public SDK contract** for both internal and external (user-created) skills. It must remain stable — changes require a major version bump.

- [ ] Define the `Skill` interface:
  ```typescript
  interface Skill {
    readonly name: string;
    readonly description: string;
    getTools(): SkillToolDefinition[];
    execute(toolName: string, toolInput: Record<string, unknown>): Promise<string>;
    getRequiredConfig(): string[];
    startup(ctx: SkillContext): Promise<void>;
    shutdown(): Promise<void>;
  }

  interface SkillToolDefinition extends LLMToolDefinition {
    requiresConfirmation?: boolean;  // destructive actions (send, create, delete, block)
  }
  ```
- [ ] Skills use `SkillToolDefinition` (the coda-internal format with metadata), not any provider-specific format. The provider adapter handles translation to Anthropic/Google/OpenAI formats.
- [ ] Tools with `requiresConfirmation: true` trigger the confirmation flow in the skill executor (see below).

### Skill Context (`src/skills/context.ts`)

Every skill receives a `SkillContext` at startup — this is the stable API through which skills access coda services. External skills never import coda internals directly.

- [ ] Define `SkillContext` interface:
  ```typescript
  interface SkillContext {
    config: Record<string, unknown>;   // skill-specific config section from config.yaml
    logger: Logger;                    // namespaced pino child logger (e.g., "coda:email")
    redis: RedisClient;               // for skill-specific caching (keys auto-prefixed)
    db: DrizzleClient;                // for skill-specific tables
    eventBus: EventBus;               // publish events, subscribe to events
    scheduler: TaskScheduler;          // register scheduled tasks (available after Phase 3)
  }
  ```
- [ ] `SkillContext.redis` auto-prefixes all keys with the skill name (e.g., `skill:email:cache:123`)
- [ ] `SkillContext.logger` is a pino child logger with the skill name as a field
- [ ] `SkillContext.config` is the skill's section from `config.yaml`, validated against the skill's `getRequiredConfig()`

### Skill Manifest (`coda-skill.json`)

External skills must include a manifest file in their package root.

- [ ] Define manifest schema (validated with Zod at load time):
  ```json
  {
    "name": "my-custom-skill",
    "version": "1.0.0",
    "description": "Description of what this skill does",
    "entry": "./dist/index.js",
    "requires": {
      "config": ["my_skill.api_key"],
      "services": ["redis"]
    },
    "integrity": {
      "sha256": "base64-encoded-hash-of-entry"
    },
    "publisher": {
      "id": "local-user-or-team",
      "signingKeyId": "local-user-key-2026-01",
      "signature": "base64-ed25519-signature-over-entry-hash"
    },
    "runsInWorker": false,
    "coda_sdk_version": "^1.0.0"
  }
  ```
- [ ] `entry` — path to the JS module that default-exports a `Skill` class
- [ ] `requires.config` — config keys the skill needs (validated before startup)
- [ ] `requires.services` — which core services the skill needs (`redis`, `postgres`, `eventBus`, `scheduler`)
- [ ] `integrity.sha256` — required for external skills; loader verifies `entry` hash before import
- [ ] `publisher` — signing metadata (required for external skills in production; optional only for local dev unsigned mode)
- [ ] `runsInWorker` — optional boolean; if `true`, skill is eligible for worker-process execution (Phase 5)
- [ ] `coda_sdk_version` — semver range for SDK compatibility checking

### Skill Registry (`src/skills/registry.ts`)
- [ ] Implement `SkillRegistry`:
  - `register(skill)` — validate config requirements, add to registry
  - `getToolDefinitions()` — aggregate all tools from all registered skills
  - `routeToolCall(toolName)` — find which skill owns a tool
  - `startupAll()` / `shutdownAll()` — lifecycle management
- [ ] **Internal discovery:** scan `src/skills/*/` for `Skill` implementations on startup
- [ ] **External discovery:** scan directories listed in `config.skills.external_dirs`:
  ```yaml
  skills:
    external_dirs: []             # default: disabled (explicit opt-in)
    external_policy:
      mode: "strict"              # strict (prod) | dev
      trusted_signing_keys: []    # allowed signing key IDs in strict mode
      allow_unsigned_local: false # true only in dev for local iteration
      allowed_local_unsigned_dirs:
        - "./custom-skills"       # only used when allow_unsigned_local=true
  ```
  - Each subdirectory must contain a `coda-skill.json` manifest
  - Directory and file-permission checks on manifests/entries (not world-writable)
  - Load via dynamic `import()` of the manifest's `entry` path
  - Resolve `entry` to a canonical path and reject path traversal/symlink escape outside the skill directory
  - Verify `integrity.sha256` before import; reject on mismatch
  - Enforce trusted-source verification:
    - `strict` mode (default for prod): signature + trusted signing key required
    - `dev` mode: unsigned skills allowed only from explicitly allowlisted local directories
  - Validate manifest schema and SDK version compatibility before loading
- [ ] Skill load failures are logged at ERROR but do not prevent other skills from loading

### Skill Executor
- [ ] Implement tool call dispatch with:
  - Per-skill rate limiting
  - Execution timeout (via `AbortController` + `setTimeout`)
  - Error wrapping (skill errors become user-friendly messages, not stack traces)
  - Structured logging of every tool call + result
  - **Error isolation:** a skill crash never takes down the orchestrator

### Confirmation Flow (`src/core/confirmation.ts`)
- [ ] For tools with `requiresConfirmation: true`:
  1. Skill executor intercepts the tool call before execution
  2. Returns a preview response to the orchestrator: action description + unique confirmation token
  3. Token is a cryptographically random token (minimum 80 bits entropy; e.g., 16+ base32 chars) stored in Redis with a 5-minute TTL (`RETENTION.CONFIRMATION_TOKEN`)
  4. User sees: *"I'll create this calendar event: 'Team standup, Mon 10am'. Reply `confirm <token>` to proceed."*
  5. User replies with `confirm <token>` → orchestrator validates token, executes the tool
  6. Token is single-use: deleted from Redis immediately after use or expiry
  7. Invalid/expired tokens return a clear error message
- [ ] Confirmation tokens are scoped per-user (prevents cross-user confirmation)

---

## 1.6 Discord Bot Interface

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

## 1.7 Application Entry Point

### Main (`src/main.ts`)
- [ ] Load configuration
- [ ] Initialize Redis (`ioredis`) + Postgres (`drizzle-orm` + `postgres.js`) connections
- [ ] Initialize LLM providers from config (create all configured providers via factory)
- [ ] Create `ProviderManager` with providers + default selection
- [ ] Create `EventBus` (in-process implementation for Phase 1)
- [ ] Create orchestrator with provider manager, context store, and event bus
- [ ] Discover and register all skills (internal `src/skills/*/` + external `config.skills.external_dirs`)
- [ ] Inject `SkillContext` into each skill during startup
- [ ] Start Discord bot
- [ ] Start HTTP server (Fastify for health checks + future REST API)
- [ ] Graceful shutdown handler (`SIGTERM`/`SIGINT` — close connections, stop skill background tasks, shutdown skills)

### Health & Observability
- [ ] `/health` endpoint — checks Redis, Postgres, default LLM provider reachability
- [ ] Structured logging with `pino` — JSON output, redaction paths configured (see §1.3)
- [ ] Log every message received, tool call made, and response sent (no PII in default log level)
- [ ] All Redis keys use TTLs from `RETENTION` constants (see §1.3)

---

## 1.8 Project Structure

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
│   │   ├── confirmation.ts      # Confirmation token flow for destructive actions
│   │   ├── context.ts           # Conversation context management
│   │   ├── events.ts            # Event bus interface + in-process impl (Phase 1)
│   │   ├── alerts.ts            # Alert router
│   │   ├── sanitizer.ts         # Content sanitization
│   │   └── llm/
│   │       ├── provider.ts      # LLMProvider interface + types
│   │       ├── capabilities.ts  # ProviderCapabilities interface
│   │       ├── anthropic.ts     # Anthropic adapter (@anthropic-ai/sdk)
│   │       ├── google.ts        # Google adapter (@google/genai)
│   │       ├── openai-compat.ts # OpenAI-compatible adapter (openai)
│   │       ├── factory.ts       # Provider factory
│   │       ├── manager.ts       # Provider selection + per-user prefs
│   │       └── usage.ts         # Token/cost tracking
│   ├── skills/
│   │   ├── base.ts              # Skill interface + SkillToolDefinition (public SDK contract)
│   │   ├── context.ts           # SkillContext interface (public SDK contract)
│   │   ├── registry.ts          # Skill registration + discovery (internal + external)
│   │   ├── loader.ts            # External skill loader + manifest validation
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
│       ├── retention.ts         # Retention TTL constants
│       └── crypto.ts
├── tests/
│   ├── unit/
│   │   ├── core/
│   │   │   ├── orchestrator.test.ts
│   │   │   ├── confirmation.test.ts
│   │   │   ├── context.test.ts
│   │   │   ├── events.test.ts
│   │   │   ├── sanitizer.test.ts
│   │   │   └── llm/
│   │   │       ├── anthropic.test.ts
│   │   │       ├── google.test.ts
│   │   │       ├── openai-compat.test.ts
│   │   │       ├── capabilities.test.ts
│   │   │       ├── factory.test.ts
│   │   │       ├── manager.test.ts
│   │   │       └── usage.test.ts
│   │   └── skills/
│   │       ├── registry.test.ts
│   │       └── loader.test.ts
│   ├── integration/
│   │   ├── orchestrator-llm.test.ts
│   │   ├── external-skill.test.ts
│   │   └── discord-bot.test.ts
│   └── helpers/
│       ├── mocks.ts
│       ├── fixtures.ts
│       └── mock-skill/           # Fixture: a minimal external skill for testing
│           ├── coda-skill.json
│           └── index.ts
├── custom-skills/                # User's external skills directory (gitignored)
│   └── .gitkeep
└── scripts/
    ├── setup-unifi-account.sh
    └── rotate-keys.sh
```

---

## 1.9 Test Suite — Phase 1 Gate

Phase 1 tests must pass before proceeding to Phase 2. Tests are structured for compatibility with automated test loops (e.g., Ralph Wiggum loop — an LLM agent that iterates on code until all tests go green).

### Test Tiers
Tests are classified into tiers to prevent external flakiness from blocking development:
- **Gate (must pass for phase advancement):** Unit tests + integration tests with mocks/fixtures. Deterministic, no network calls.
- **Advisory (reported but non-blocking):** Live-provider contract tests (e.g., actual API calls to Anthropic/OpenAI). Run in CI, failures logged as warnings.
- **Nightly (optional):** Full end-to-end against real services (IMAP, CalDAV, UniFi, Plex). Run on schedule, not on every commit.

### Test Framework & Config
- [ ] **Vitest** as the test runner (`vitest.config.ts`)
- [ ] **Test scripts** in `package.json`:
  - `test` — run all gate-tier tests
  - `test:unit` — unit tests only
  - `test:integration` — integration tests only (mocked)
  - `test:contract` — advisory live-provider contract tests
  - `test:phase1` — run only Phase 1 gate tests (via Vitest workspace or tag filter)
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

**Google Adapter (`tests/unit/core/llm/google.test.ts`)**
- [ ] Translates coda tool definitions to Gemini `FunctionDeclaration` format
- [ ] Maps Gemini text response to `LLMResponse` with `stopReason: "end_turn"`
- [ ] Maps Gemini `functionCall` response to `LLMResponse` with populated `toolCalls`
- [ ] Extracts token counts from Gemini `usageMetadata` fields
- [ ] Handles Gemini API errors (rate limit, server error) gracefully
- [ ] Does not send `parallel_tool_calls` parameter (unsupported)

**OpenAI-Compatible Adapter (`tests/unit/core/llm/openai-compat.test.ts`)**
- [ ] Translates coda tool definitions to OpenAI function-calling format
- [ ] Maps OpenAI text response to `LLMResponse` with `stopReason: "end_turn"`
- [ ] Maps OpenAI tool_calls response to `LLMResponse` with populated `toolCalls`
- [ ] Extracts input/output token counts from OpenAI usage
- [ ] Returns `null` usage values when provider doesn't report metrics
- [ ] Passes correct `baseURL` to OpenAI client constructor
- [ ] Passes `defaultHeaders` when configured (OpenRouter `HTTP-Referer`, `X-Title`)
- [ ] Works with different `baseURL` values (OpenRouter, Ollama, LM Studio)
- [ ] Handles OpenAI API errors (rate limit, server error) gracefully

**Provider Capabilities (`tests/unit/core/llm/capabilities.test.ts`)**
- [ ] Each adapter exposes correct default capabilities
- [ ] Config overrides merge with default capabilities
- [ ] `tools: false` causes orchestrator to omit tools from request
- [ ] `tools: "model_dependent"` allows tool calls but handles failures gracefully
- [ ] `usageMetrics: false` accepts `null` usage without warnings
- [ ] `parallelToolCalls: false` omits that parameter from the request

**Provider Factory (`tests/unit/core/llm/factory.test.ts`)**
- [ ] Creates `AnthropicProvider` for `type: "anthropic"` config
- [ ] Creates `GoogleProvider` for `type: "google"` config
- [ ] Creates `OpenAICompatProvider` for `type: "openai_compat"` config
- [ ] Passes correct `baseURL`, `apiKey`, and `defaultHeaders` to OpenAI-compat provider
- [ ] Passes capabilities overrides from config to all provider types
- [ ] Throws for unknown provider type

**Provider Manager (`tests/unit/core/llm/manager.test.ts`)**
- [ ] Returns default provider/model when user has no preference
- [ ] Returns user's preferred provider/model when set
- [ ] `setUserPreference()` persists and `getForUser()` retrieves
- [ ] Falls back to default if user's preferred provider is unavailable
- [ ] Lists all available providers and their models

**Usage Tracking (`tests/unit/core/llm/usage.test.ts`)**
- [ ] `trackUsage()` stores token counts per provider/model
- [ ] `trackUsage()` handles `null` token values from providers without usage metrics
- [ ] `getDailyUsage()` aggregates today's tokens by provider
- [ ] `getDailyUsage()` shows "usage not tracked" for providers with `usageMetrics: false`
- [ ] `getEstimatedCost()` calculates cost from token counts and configured rates
- [ ] `getEstimatedCost()` skips providers with null usage data
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

**Event Bus (`tests/unit/core/events.test.ts`)**
- [ ] `publish()` dispatches event to matching subscriber
- [ ] `subscribe()` with pattern matches correct event types (e.g., `alert.*`)
- [ ] Events with no matching subscriber are silently dropped (no crash)
- [ ] Multiple subscribers for the same pattern all receive the event
- [ ] Handler errors are caught and logged (do not propagate to publisher)

**Confirmation Flow (`tests/unit/core/confirmation.test.ts`)**
- [ ] Generates unique confirmation token for a pending action
- [ ] Token format enforces high entropy (minimum 80-bit random token; no short/static codes)
- [ ] Token is stored in Redis with correct TTL (5 minutes)
- [ ] Valid token executes the pending action and deletes the token
- [ ] Expired token returns a clear error message
- [ ] Invalid token returns a clear error message
- [ ] Token is single-use — second use returns error
- [ ] Tokens are scoped per-user (user A cannot confirm user B's action)
- [ ] Orchestrator recognizes `confirm <token>` messages and routes to confirmation flow

**Skill Registry (`tests/unit/skills/registry.test.ts`)**
- [ ] Registers a skill and includes its tools in `getToolDefinitions()`
- [ ] `routeToolCall()` returns the correct skill for a given tool name
- [ ] `routeToolCall()` throws for unknown tool names
- [ ] Rejects skills with missing required config
- [ ] Calls `startup()` with `SkillContext` on all skills during `startupAll()`
- [ ] Calls `shutdown()` on all skills during `shutdownAll()`
- [ ] Skill crash during `startup()` logs error but does not prevent other skills from loading
- [ ] Tools with `requiresConfirmation: true` are flagged in the executor

**External Skill Loader (`tests/unit/skills/loader.test.ts`)**
- [ ] Scans configured external directories for `coda-skill.json` manifests
- [ ] Validates manifest schema (rejects invalid manifests with clear error)
- [ ] Checks `coda_sdk_version` compatibility (rejects incompatible versions)
- [ ] Verifies `integrity.sha256` of manifest `entry` before import
- [ ] Strict mode rejects missing/invalid publisher signatures
- [ ] Strict mode rejects signatures from untrusted signing keys
- [ ] Dev mode allows unsigned skills only from `allowed_local_unsigned_dirs`
- [ ] Rejects entry path traversal/symlink escape outside the skill directory
- [ ] Rejects skills from insecure file permissions (world-writable manifests/entries)
- [ ] Loads skill module via dynamic `import()` from manifest `entry` path
- [ ] Validates loaded module default-exports a class implementing `Skill`
- [ ] Handles missing `coda-skill.json` gracefully (skip directory, log warning)
- [ ] Handles load failure gracefully (skip skill, log error, continue loading others)
- [ ] Missing `requires.config` keys cause skill to be skipped with clear error

### Integration Tests

**Orchestrator + LLM (`tests/integration/orchestrator-llm.test.ts`)**
- [ ] End-to-end: send a simple message → get a text response (mocked Anthropic provider)
- [ ] End-to-end: send a simple message → get a text response (mocked OpenAI-compat provider)
- [ ] End-to-end: send a message that triggers tool use → tool executes → final response returned
- [ ] Conversation history accumulates across multiple `handleMessage` calls
- [ ] Switching provider mid-conversation works correctly
- [ ] Token usage is tracked across multiple turns

**External Skill Integration (`tests/integration/external-skill.test.ts`)**
- [ ] External skill in `tests/helpers/mock-skill/` loads successfully via registry
- [ ] External skill's tools appear in `getToolDefinitions()`
- [ ] External skill receives `SkillContext` with working logger, redis, and config
- [ ] External skill's tool calls execute through the orchestrator
- [ ] External skill with `requiresConfirmation` tool triggers confirmation flow end-to-end

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
- [ ] `createMockGoogleProvider()` — mock Google adapter with configurable responses
- [ ] `createMockOpenAIProvider()` — mock OpenAI-compat adapter with configurable responses (supports missing usage fields)
- [ ] `createMockProviderManager()` — mock manager that returns specified provider with capabilities
- [ ] `createMockSkill()` — returns a mock skill with configurable tools and execute behavior (supports `requiresConfirmation`)
- [ ] `createMockEventBus()` — in-memory event bus for testing publish/subscribe
- [ ] `createMockSkillContext()` — mock `SkillContext` with in-memory redis, logger, and config
- [ ] `createMockRedis()` — in-memory Redis mock (or use `ioredis-mock`)
- [ ] `createTestFixtures()` — standard test data (users, messages, tool calls)
- [ ] `tests/helpers/mock-skill/` — minimal external skill fixture with manifest and one tool

---

## Acceptance Criteria

1. `docker-compose up` brings up coda-core, Redis, and Postgres
2. Sending a message in the designated Discord channel gets an LLM-powered response
3. `/model set openai gpt-4o` switches the LLM provider and subsequent messages use OpenAI
4. `/model set google gemini-2.0-flash` switches to Gemini via native Google SDK
5. `/model set ollama llama3.1:8b` switches to a local Ollama model (tools disabled if model doesn't support them)
6. Conversation history persists across messages within a session
7. `/status` slash command shows the orchestrator is running with loaded skills (internal + external)
8. `/model status` shows current provider, model, capabilities, and today's token usage
9. `/health` returns 200 with service connectivity status
10. All config is loaded from `config.yaml` with env-var overrides
11. Logs are structured JSON with request correlation IDs and PII redaction
12. A skill placed in `custom-skills/` with a valid `coda-skill.json` is discovered and loaded automatically
13. **`npm run test:phase1` passes with 0 failures (gate-tier tests only)**

---

## Key Decisions for This Phase

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Runtime | Node.js 22 LTS | Long-term support, native TypeScript via `--experimental-strip-types` or tsx |
| ORM | Drizzle ORM + postgres.js | Type-safe, lightweight, great migration tooling |
| Redis client | ioredis | Battle-tested, full Redis Streams support, async |
| Logging | pino with redaction | Fastest structured JSON logger in Node, built-in redaction paths for PII |
| HTTP framework | Fastify | Faster than Express, schema validation built in, plugin ecosystem |
| LLM abstraction | 3 adapters + capability matrix | `@anthropic-ai/sdk` + `@google/genai` + `openai` — native SDKs where protocols differ, compat layer for the rest |
| Provider capabilities | Config-driven capability flags | Runtime gating prevents silent failures on providers that don't support tools/usage/streaming |
| Default LLM | Configurable (user choice) | No vendor lock-in, provider-agnostic from day one |
| Skill extensibility | External skill loading via manifest + SDK contract | Users can create skills without modifying coda core; stable `SkillContext` API |
| Confirmation flow | Token-based with Redis TTL | Secure, single-use, expiring — prevents accidental or spoofed confirmations |
| Test framework | Vitest with tiered test gates | Fast, native TypeScript, ESM support; tiered gates prevent external flakiness from blocking development |
| Package manager | pnpm | Fast, strict, disk-efficient |

---

## Key Dependencies

```json
{
  "dependencies": {
    "@anthropic-ai/sdk": "^0.52.0",
    "@google/genai": "^1.0.0",
    "openai": "^4.80.0",
    "discord.js": "^14.16.0",
    "drizzle-orm": "^0.36.0",
    "fastify": "^5.2.0",
    "ioredis": "^5.4.0",
    "js-yaml": "^4.1.0",
    "pino": "^9.6.0",
    "postgres": "^3.4.0",
    "semver": "^7.6.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@types/js-yaml": "^4.0.9",
    "@types/node": "^22.0.0",
    "@types/semver": "^7.5.0",
    "drizzle-kit": "^0.30.0",
    "ioredis-mock": "^8.9.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

Note: `@google/genai` is Google's official GenAI SDK for JavaScript/TypeScript, providing native Gemini API access with proper tool calling support. `semver` is used for validating external skill SDK version compatibility.
