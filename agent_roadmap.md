# Unified Coda-Agent Roadmap
### Reactive Assistant → Autonomous Agent + OpenClaw-Inspired Improvements

*~100–130 hours remaining across Phases 1–5 · Personal Home Lab · Containerized · API-First*

---

## Deployed Stack (What's Already Running)

| | |
|---|---|
| **Models** | Multi-provider · Haiku (light) → Sonnet (complex) · Opus reserved for reasoning |
| **Storage** | Postgres + pgvector (384-dim) · tsvector FTS · Redis Streams event bus |
| **Runtime** | Fully containerized (Docker Compose) · Home lab (Proxmox) |
| **Built-in Skills** | Reminders, Notes, Memory, Doctor, Scheduler, Docker Executor, Subagents, Audit, **Tasks, Self-Improvement** (10 total) |
| **Agent Skills** | web-research, pdf, skill-creator, algorithmic-art, mcp-builder, slack-gif-creator, frontend-design (7 total) |
| **Integrations** | MCP (stdio + HTTP), n8n, Firecrawl, Weather, Discord, Slack (6 total) |
| **New (Phase 1)** | Audit log, solution_patterns table, routing_decisions table, permission tiers, config hot-reload, MessageSender |
| **New (Phase 4)** | Self-assessments, improvement_proposals, prompt_versions, task_state tables; SelfImprovementSkill, TaskExecutionSkill, PromptManager, LearnedTierClassifier, SelfAssessmentService |

---

## Core Design Philosophy

Since fine-tuning is off the table, "learning" happens at four levels:
- **Memory accumulation** — the system remembers what worked for you specifically
- **Context enrichment** — better retrieval means the model gets smarter inputs
- **Prompt/tool evolution** — system prompts and routing logic improve over time
- **Infrastructure learning** — the scaffolding around the model gets smarter even when the model itself doesn't

Opus is reserved for infrequent but high-value reasoning tasks: self-improvement cycles, gap analysis, prompt rewrites, and complex orchestration. It never handles routine interactions — this keeps costs manageable while ensuring the parts that shape the system's long-term behavior get the best available reasoning.

---

## Phase 1 — Observability & Memory Foundation ✅

*Theme: Build the data foundation that all intelligence features depend on. Every hour of audit data collected now pays dividends in later phases.*

### ✅ 1.1 Audit System
Persistent, queryable audit trail for every tool call and significant system event.

**Implemented:**
- `audit_log` Drizzle table: `id, correlation_id, user_id, channel, event_type, skill_name, tool_name, input_summary, duration_ms, status, tier, model, provider, permission_tier, metadata, created_at`
- Hooked into `SkillRegistry.executeToolCall()` — fire-and-forget writes
- Sensitive tool inputs: key names stored only, never values
- `AuditSkill` with `audit_query` and `audit_stats` tools for agent self-introspection (mainAgentOnly)
- `src/core/audit.ts`, `src/skills/audit/skill.ts`

### ✅ 1.2 Solution Pattern Store
Table ready for multi-step successful resolutions to be stored as few-shot retrieval examples.

**Implemented:**
- `solution_patterns` table: `id, title, task_type, problem_description, resolution_steps (jsonb), tools_used[], outcome, source_memory_id, embedding (vector), tags[], retrieval_count, created_at`
- Population by Phase 4 weekly Opus reflection cycle

### ✅ 1.3 Routing Decision Logger
Logs every LLM routing decision to Postgres for observability and Phase 4 self-improvement.

**Implemented:**
- `routing_decisions` table: `id, session_id, correlation_id, user_id, channel, task_type, model_chosen, provider, tier, rationale, input_complexity_score, latency_ms, created_at`
- `RoutingDecisionLogger` hooked into `Orchestrator.handleMessageInner()` after tier selection
- Both tier-enabled and tier-disabled paths logged
- `src/core/routing-logger.ts`

### ✅ 1.4 Permission Tier System (accelerated from Phase 5)
Formalized ad-hoc confirmation/sensitive flags into explicit permission tiers.

**Implemented:**
- `permissionTier?: 0|1|2|3|4` added to `SkillToolDefinition` in `base.ts`
- `getToolPermissionTier()` method on `SkillRegistry` — tier ≥3 requires confirmation
- `toolRequiresConfirmation()` now returns `true` for tier ≥3 (backwards compatible)
- Default for unannotated tools = 2; `requiresConfirmation: true` → tier 3; `sensitive: true` → tier 2

| Tier | Scope | Behaviour |
|------|-------|-----------|
| 0 | Read-only | Always allowed, no confirmation |
| 1 | Write personal data | Auto-approved, audit logged |
| 2 | External read (default) | Logged, allowed |
| 3 | External action / destructive | Requires user confirmation |
| 4 | Irreversible | Requires confirmation |

### ✅ 1.5 Config Hot-Reload
Watches `config/config.yaml` for changes and hot-applies non-structural settings.

**Implemented:**
- `ConfigWatcher` class using `fs.watch`, 500ms debounce
- Re-parses through Zod on change, publishes `config.reloaded` event on event bus
- **Hot-reloadable**: alert rules, quiet hours, tier thresholds/patterns, subagent limits, scheduler overrides
- **NOT reloadable**: API keys, DB/Redis URLs, tokens, skill registrations
- Invalid config = warning + keep running config unchanged
- `src/utils/config-watcher.ts`

### ✅ 1.6 Proactive Message Sender
Generalized outbound messaging interface for skills and scheduled tasks.

**Implemented:**
- `MessageSender` class with `send()` and `broadcast()` methods
- Rate-limited (10/hour per channel by default), allowlisted channels only
- Discord and Slack registered as channels in `main.ts`
- Available to all skills via `SkillContext.messageSender`
- All sends fire-and-forget, audit logged
- `src/core/message-sender.ts`

### ✅ 1.7 Hybrid Memory with MMR
Upgrade Python memory service retrieval from pure cosine similarity to weighted hybrid with Maximal Marginal Relevance.

```
1. Retrieve top-20 by cosine similarity
2. Temporal decay: score *= exp(-λ * days_since_access), λ = ln(2)/30
3. Access bonus: score += 0.1 * min(access_count/10, 1)
4. MMR re-rank: iteratively select maximizing (relevance - 0.3 * max_similarity_to_selected)
5. Return top-N within token budget
```
- **Files**: `services/memory/`
- **Effort: M** (3-4 hrs)

### ✅ 1.8 Memory Write Policy
Auto-trigger structured memory writes on significant task completion.

- Post-task hook: was this notable? multiple tools? non-trivial resolution?
- Haiku generates structured entry with domain tags
- High-importance entries feed solution_patterns via Opus weekly batch
- **Files**: `src/core/orchestrator.ts`, `src/skills/memory/`
- **Effort: S-M** (2-3 hrs)

---

## Phase 2 — New Capabilities: Browser, Permissions (~22-28 hours)

*Theme: Add the highest-impact capability (browser) and the safety layer they require.*

### 🔲 2.1 Browser Automation Skill
Playwright in Docker containers via docker-executor. Navigate, click, fill forms, screenshot.

**Tools**: `browser_navigate(url, wait_for?)`, `browser_click(selector)`, `browser_fill(selector, value)`, `browser_screenshot()`, `browser_evaluate(script)` [tier 3], `browser_session_close()`

**Security**: Container isolation, URL allowlist/blocklist (mirrors Firecrawl), SSRF blocklist, ephemeral profiles, all URLs in audit trail.

```yaml
browser:
  enabled: false  # Explicit opt-in
  docker_image: "mcr.microsoft.com/playwright:latest"
  timeout_seconds: 300
  max_concurrent_sessions: 2
  url_blocklist: ["localhost", "127.0.0.1", "*.internal", "169.254.*"]
```
- **Files**: `src/skills/browser/skill.ts`
- **Effort: L** (8-10 hrs)
- **Depends on**: Docker executor, 1.1 (audit), 1.4 (permission tiers)

### 🔲 2.2 Telegram Interface
Third messaging interface, mobile-first. Same pattern as Discord/Slack.

- `telegraf` library, `orchestrator.handleMessage()` integration, file attachments
- User allowlisting, same security model as Discord/Slack

```yaml
telegram:
  bot_token: ""
  allowed_user_ids: []
```
- **Files**: `src/interfaces/telegram-bot.ts`
- **Effort: S-M** (3-4 hrs)

---

## Phase 3 — Proactive Intelligence (~18-24 hours)

*Theme: Shift from reactive to proactive. The agent monitors, surfaces, and alerts based on context it already has.*

### 🔲 3.1 Home Assistant Integration
HA MCP server or n8n webhook bridge. Entity states, automations, history. Proactive alerts for anomalous readings. UniFi device tracking via existing `knownClients` table.
- **Effort: M-L** (4-6 hrs)

### 🔲 3.2 Morning Briefing Pipeline
Daily scheduled context assembly: calendar, weather, home state, reminders, n8n events, email unread summary (will be from n8n webhook?). Sonnet synthesis into prioritized summary with suggested actions. Delivered via MessageSender (1.6).
- **Effort: M** (3-4 hrs) | **Depends on**: 1.6, 3.1

### 🔲 3.3 Ambient Monitoring Agents
Lightweight scheduled watchers with Haiku significance pre-filter:
- Topic monitor (Firecrawl + search on interest topics)
- Lab health monitor (Docker, Proxmox, disk space — weekly digest)
- Plex availability watcher
- **Effort: M** (4-6 hrs per monitor)

### 🔲 3.4 Workspace Routing
Different channels route to different agent configurations (tools, system prompt, memory tags).

```yaml
workspaces:
  home:
    channels: ["discord:12345", "telegram:67890"]
    allowed_skills: ["reminders", "notes", "memory", "weather", "gmail"]
    memory_tags: ["home", "family"]
  lab:
    channels: ["discord:54321"]
    allowed_skills: ["notes", "memory", "docker-executor", "subagents", "mcp", "browser"]
    memory_tags: ["tech", "homelab"]
```
- Orchestrator `handleMessage()` resolves workspace before building prompt/tools
- Uses existing `getToolDefinitions({ allowedSkills, blockedTools })`
- **Files**: `src/core/workspace.ts`, `src/core/orchestrator.ts`
- **Effort: M** (4-6 hrs) | **Depends on**: 1.1

---

## Phase 4 — Self-Improvement Engine (~22-28 hours) ✅

*Theme: The system starts reasoning about its own patterns and improving itself. Requires weeks of audit data from Phase 1.*

### ✅ 4.1 Self-Assessment Post-Task
Lightweight Haiku self-score after each Sonnet/Opus response: task completed? tool failures? fallbacks needed?

**Implemented:**
- `SelfAssessmentService` (`src/core/self-assessment.ts`) — fire-and-forget Haiku scoring
- Writes to `self_assessments` table (correlation_id, score 1-5, task_completed, failure_modes)
- Post-task hook in `orchestrator.handleMessageInner()` for all tool-using turns (toolCallCount ≥ 1)
- **Effort: M** (3 hrs)

### ✅ 4.2 Weekly Opus Reflection Cycle
Scheduled weekly: Opus reads audit log, produces structured improvement recommendations. All changes require explicit user approval.

**Implemented:**
- `SelfImprovementSkill` (`src/skills/self-improvement/`) — weekly_reflection cron (Sunday 3 AM)
- Input assembly: 7-day audit stats, low-scoring assessments, routing patterns, system prompt snapshot, tool list
- Output: up to 10 structured proposals in `improvement_proposals` table
- Summary sent to approval channel; `improvement_proposals_list` + `improvement_proposal_decide` tools
- **Effort: L** (4-5 hrs) | **Depends on**: 1.1 (weeks of data)

### ✅ 4.3 Prompt Evolution System
Version-controlled system prompts in Postgres. Opus rewrites sections, not whole prompts. A/B testing on light-tier tasks. Instant rollback.

**Implemented:**
- `PromptManager` (`src/core/prompt-manager.ts`) — getSection, createVersion, activateVersion, rollback, recordPerformance
- `prompt_versions` table (section_name, version, is_active, is_ab_variant, ab_weight, performance_score)
- `buildSystemPrompt()` checks DB-backed sections first; falls back to hardcoded text
- A/B variant selection on light-tier requests based on ab_weight
- `prompt_rollback` tool on SelfImprovementSkill (tier 3, requires confirmation)
- `prompt_evolution_enabled: false` by default — explicit opt-in
- **Effort: M** (4 hrs) | **Depends on**: 4.2

### ✅ 4.4 Routing Intelligence Upgrade
Use routing decision logs to update classifier with learned task-type signatures.

**Implemented:**
- `LearnedTierClassifier` (`src/core/learned-classifier.ts`) — retrain from routing_decisions + self_assessments
- Keyword pattern extraction from misrouted turns (light+low score → should be heavy; heavy+high score → could be light)
- `TierClassifier.setLearnedClassifier()` — integrates learned patterns before static heuristics (confidence threshold: 0.7)
- Weekly retrain cron (Sunday 4 AM) via `routing.retrain` scheduled task
- **Effort: M** (3 hrs) | **Depends on**: 1.3

### ✅ 4.5 Long-Horizon Task Execution (accelerated from Phase 5)
Persistent multi-day tasks with checkpointing, autonomous resumption, blocker surfacing.

**Implemented:**
- `task_state` table: `id, user_id, channel, workspace_id, goal, steps (jsonb), current_step, status, blockers (jsonb), next_action_at, result, metadata, created_at, updated_at`
- `TaskExecutionSkill` (`src/skills/tasks/`) — Tools: `task_create`, `task_status`, `task_advance`, `task_block`
- `task_resume` cron (every 15 min) — notifies user when next_action_at arrives
- **Effort: L** (6-8 hrs) | **Depends on**: 1.1, 1.6

---

## Phase 5 — Multi-Agent & Ecosystem (~24-32 hours)

*Theme: Specialist agents, self-critique, autonomous growth, and ecosystem extensibility.*

### 🔲 5.1 Orchestrator/Worker IO Contract
Typed IO envelopes for subagent tasks. Thin layer on existing `sessions_spawn`.
- **Effort: S-M** (2-3 hrs)

### 🔲 5.2 Specialist Agent Library
Pre-configured specialist presets: Home agent, Research agent, Lab agent, Planner agent. Each with focused system prompt + tool allowlist.
- **Effort: M** (6-8 hrs total)

### 🔲 5.3 Critique Loop
Haiku critic reviews high-stakes outputs before execution. Checks safety, accuracy, side effects, simplicity. Critique outcomes logged to audit.
- **Effort: M** (3-4 hrs)

### 🔲 5.4 Gap Detection & Skill Proposal
Monthly Opus review: 30 days of audit → top 3 capability gaps → structured proposals. User approves/rejects. Approved proposals built via docker-executor + skill-creator.
- **Effort: L** (4-5 hrs)

### 🔲 5.5 Expose Coda as MCP Server
Expose subset of coda's tools as an MCP server (stdio transport) for IDE integration.

- Reuses `src/integrations/mcp/schema-mapper.ts` in reverse
- Exposed tools: notes, memory, reminders, subagent delegation (configurable allowlist)
- **Files**: `src/interfaces/mcp-server.ts`
- **Effort: M** (4-5 hrs)

### 🔲 5.6 Skill Discovery Registry
Curated JSON catalog of available agent skills. Agent searches it and proposes installations.

- `skill_registry_search(query)` tool, JSON fetched via HTTPS + Redis cache
- Installation = download SKILL.md to `agent_skill_dirs` + existing `/rescan-skills`
- Unsigned skills require explicit user approval
- **Effort: S-M** (3-4 hrs)

### 🔲 5.7 Synthetic Few-Shot Library
Monthly Opus harvests best interactions from audit log into `solution_patterns` table. 2-3 most relevant examples surfaced as context prefix for new tasks.
- **Effort: S-M** (3 hrs) | **Depends on**: 1.2, 4.2

---

## Implementation Progress

| # | Item | Status | Effort | Unlocks |
|---|---|---|---|---|
| 1 | Audit system | ✅ Done | M | Everything |
| 2 | Solution pattern store (table) | ✅ Done | S | Few-shot retrieval |
| 3 | Routing decision logger | ✅ Done | S | Phase 4 routing upgrade |
| 4 | Permission tier system | ✅ Done | M | Browser safety |
| 5 | Config hot-reload | ✅ Done | S | Daily QoL |
| 6 | Message sender | ✅ Done | S | All proactive features |
| 7 | Hybrid memory MMR | ✅ Done | M | Better retrieval |
| 8 | Memory write policy | ✅ Done | S-M | Systematic learning |
| 9 | Browser automation | 🔲 Todo | L | Web interaction |
| 10 | Telegram | 🔲 Todo | S-M | Mobile interface |
| 11 | HA integration | 🔲 Todo | M-L | Home awareness |
| 12 | Morning briefing | 🔲 Todo | M | Daily proactive summary |
| 13 | Workspace routing | 🔲 Todo | M | Channel isolation |
| 14 | Ambient monitors | 🔲 Todo | M | Topic/lab/Plex watching |
| 15 | Self-assessment | ✅ Done | M | Reflection data |
| 16 | Opus reflection | ✅ Done | L | Self-improvement |
| 17 | Prompt evolution | ✅ Done | M | Evolving prompts |
| 17b | Routing intelligence | ✅ Done | M | Learned routing |
| 18 | Long-horizon tasks | ✅ Done | L | Multi-day autonomy |
| 19 | Specialist agents | 🔲 Todo | M | Parallel work |
| 20 | Critique loop | 🔲 Todo | M | Self-validation |
| 21 | MCP server (expose coda) | 🔲 Todo | M | IDE integration |
| 22 | Skill registry | 🔲 Todo | S-M | Ecosystem growth |
| 23 | Gap detection | 🔲 Todo | L | Autonomous growth |

---

## Ideas Backlog

Items captured from research and brainstorming that don't fit cleanly into the current phase roadmap.

### Browser Automation (Playwright/Puppeteer)
Firecrawl handles reading but not interaction. A Playwright integration would enable:
- Logging into portals requiring button clicks
- Actually booking/reserving (tables, tickets) not just finding links
- Navigating SPAs where data is only revealed after user interactions

### Plex Integrations
- **Spoiler-free companion** — query current playback timestamp before answering questions about a show/film
- **Semantic library search** — ingest Plex titles/plot summaries/subtitle text into vector memory
- **Smart recommender** — suggestions based on family viewing history, mood, and who's watching

### Additional Skills/Integrations
- **Stock/portfolio checker** — price alerts, position summaries
- **Dream journal analyzer** — log and find patterns in dreams
- **iOS app / Apple Intelligence** — companion node device exposing local capabilities

### Session & Memory Improvements
- **Automatic memory flush on compaction** — pre-compaction ping to write durable memories before context window resets
- **Per-type session reset overrides** — different reset policies for direct vs. group vs. thread sessions
- **Memory lifecycle management** — configurable archival TTLs, importance decay over time

---

## Key Principles

- **The system learns — the model doesn't.** Every improvement is to the scaffolding, memory, and routing.
- **Opus is expensive and brilliant** — use it only for things that shape the system's future behavior, never for routine tasks.
- **Approval gates are features, not friction.** Every Opus-proposed change going through your review is also training signal.
- **Build for rollback first.** Any component that can change behavior should be versioned and instantly reversible.
- **The few-shot library compounds.** After 6 months of logging, the agent effectively has a custom knowledge base of how you like things done.
- **Leverage what exists.** The foundation is built. Before adding a new table, service, or abstraction, check whether the existing event bus, alert routing, scheduler, or subagent system already provides 80% of what's needed.