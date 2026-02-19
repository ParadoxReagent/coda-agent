# AI Agent Implementation Roadmap
### From Reactive Assistant to Autonomous Agent
*5 Phases · Personal Home Lab · Containerized · API-First*

---

## Deployed Stack (What's Already Running)

| | |
|---|---|
| **Models** | Multi-provider · Haiku (light tasks) → Sonnet (complex) · Opus reserved for reasoning |
| **Storage** | Postgres + pgvector (384-dim) · tsvector FTS · Redis Streams event bus |
| **Runtime** | Fully containerized (Docker Compose) · Home lab (Proxmox) · 279 automated tests |
| **Built-in Skills** | Reminders, Notes, Memory, Doctor, Scheduler, Docker Executor, Subagents (7 total) |
| **Agent Skills** | web-research, pdf, skill-creator, algorithmic-art, mcp-builder, slack-gif-creator, frontend-design (7 total) |
| **Integrations** | MCP (stdio + HTTP, multi-transport), n8n, Firecrawl, Weather, Discord, Slack (6 total) |
| **Constraints** | No local models >7b · No fine-tuning · API-dependent · Personal use only |

---

## Core Design Philosophy

Since fine-tuning is off the table, "learning" happens at four levels:

- **Memory accumulation** — the system remembers what worked for you specifically
- **Context enrichment** — better retrieval means the model gets smarter inputs
- **Prompt/tool evolution** — system prompts and routing logic improve over time
- **Infrastructure learning** — the scaffolding around the model gets smarter even when the model itself doesn't

Opus is reserved for infrequent but high-value reasoning tasks: self-improvement cycles, gap analysis, prompt rewrites, and complex orchestration. It never handles routine interactions — this keeps costs manageable while ensuring the parts that shape the system's long-term behavior get the best available reasoning.

---

## Summary Timeline

| Phase | Timeline | Key Deliverable | Capability Unlocked |
|---|---|---|---|
| ~~Foundation~~ | ~~Done~~ | ~~Semantic memory + event bus + all skills/integrations~~ | ~~Deployed and operational~~ |
| 1 | Weeks 1–2 | Solution patterns + routing observability | Remembers resolved solutions, visible routing decisions |
| 2 | Weeks 2–5 | HA integration + proactive briefings | Surfaces things you didn't ask for |
| 3 | Weeks 5–9 | Reflection cycle + prompt evolution | Identifies and patches its own weaknesses |
| 4 | Weeks 9–14 | Specialist agents + critique loop | Parallelizes work, self-validates actions |
| 5 | Months 4–6+ | Autonomous gap closure | Proposes and builds its own improvements |

---

## Foundation Work: Complete

All of the following were built as part of bringing coda-agent to its current state. These items are **done** and should not be re-implemented.

### Memory & Storage
- [x] `memories` table with pgvector (384-dim embeddings), tsvector full-text search, importance scoring, access count, tags, archival
- [x] Semantic memory Python microservice (sentence transformers, auto-injection into every conversation)
- [x] `contextFacts` table for long-term extracted facts per user
- [x] `notes` table with PostgreSQL tsvector full-text search
- [x] `conversations` table for medium/long-term conversation history
- [x] `skillsConfig` table for per-skill runtime config and state

### Routing & Infrastructure
- [x] Dual-tier LLM routing: Haiku (light) → Sonnet (complex)
- [x] Multi-provider LLM support with fallback
- [x] `llmUsage` table tracking tokens + estimated cost per provider/model/day
- [x] Redis Streams event bus (reminders, alerts, health checks)
- [x] `alertHistory` table (delivery tracking, suppression, suppression reason)
- [x] `userPreferences` table (DND, quiet hours, timezone, alerts-only mode)
- [x] Docker Compose deployment, fully containerized

### Skills (7 Built-in)
- [x] **Reminders** — natural language time parsing, recurring, snooze, background checker
- [x] **Notes** — full-text search with tsvector, tags, `context:always` injection
- [x] **Memory** — semantic similarity search, importance-weighted, auto-context injection
- [x] **Doctor** — self-healing, error classification, pattern detection, truncation handling
- [x] **Scheduler** — runtime cron management, per-skill scheduled tasks
- [x] **Docker Executor** — sandboxed ephemeral containers, resource limits, image whitelist
- [x] **Subagents** — isolated sessions, concurrency limits, transcript tracking, parent/child runs, async + sync modes

### Agent Skills (7 Shipped)
- [x] **web-research** — guided research strategies using Firecrawl
- [x] **pdf** — extract text, fill forms, merge documents (sandboxed Docker)
- [x] **skill-creator** — scaffold, validate, and package new agent skills
- [x] **algorithmic-art** — generative art via code execution
- [x] **mcp-builder** — build and test new MCP servers
- [x] **slack-gif-creator** — programmatic GIF generation
- [x] **frontend-design** — UI/component design assistance

### Integrations (6)
- [x] **MCP** — stdio + HTTP transports, tool allowlist/blocklist, confirmation gates, injection sanitization
- [x] **n8n** — webhook bridge, flexible event querying, priority/tag filtering
- [x] **Firecrawl** — scrape, crawl, map, search with Redis caching
- [x] **Weather** — current conditions and forecast
- [x] **Discord** — bidirectional file attachments, reactions, thread support
- [x] **Slack** — bidirectional file attachments, OAuth, `files.uploadV2`

### Monitoring Infrastructure
- [x] `knownClients` table for UniFi device tracking (schema ready, integration not yet wired)
- [x] `subagentRuns` table with full lifecycle (accepted → running → completed/failed → archived)
- [x] 279 automated tests

---

## Phase 1 — Memory Refinement & Routing Observability
**Timeline: Weeks 1–2 · ~8–12 hours remaining**

The foundation is solid. This phase closes the remaining gaps: a dedicated solution pattern store for few-shot retrieval, a hybrid retrieval upgrade that combines cosine similarity with recency weighting, routing decision logging (critical dependency for Phase 3), and a structured memory write policy that triggers automatically on task completion.

### 1.1 Solution Pattern Store

The `memories` table handles general facts and preferences well. Multi-step successful resolutions deserve their own table so they can be retrieved as few-shot examples by task type.

**`solution_patterns` table**
- Fields: `id`, `title`, `task_type`, `problem_description`, `resolution_steps` (jsonb), `tools_used[]`, `outcome` (success/partial), `source_memory_id`, `embedding (vector)`, `tags[]`, `retrieval_count`, `created_at`
- Populated by Opus when a multi-step task completes cleanly — the agent writes *what worked*, not just *what happened*
- Retrieved as 1–2 example prefixes before any complex task that matches by semantic similarity and task type

### 1.2 Hybrid Retrieval Upgrade

The memory service currently does cosine similarity search. Upgrade to a weighted combination:

```
score = (0.6 × cosine_similarity) + (0.3 × recency_decay) + (0.1 × access_frequency_bonus)
```

- Recency decay: exponential with 30-day half-life so stale memories don't crowd out recent ones
- Access frequency: memories retrieved repeatedly float higher (they're proving useful)
- Tag filter as a hard pre-filter before scoring — scoped retrieval for domain-specific queries

### 1.3 Routing Decision Logger

Every routing decision — which model was chosen, why, and with what confidence — should be logged to Postgres. This data is the foundation for Phase 3's self-improvement engine.

**`routing_decisions` table**
- Fields: `id`, `session_id`, `task_type`, `model_chosen`, `rationale`, `confidence`, `input_complexity_score`, `latency_ms`, `created_at`
- Written after every non-trivial routing call (skip logging Haiku pass-throughs for trivial tasks)
- The routing classifier returns `{model, rationale, confidence}` — store all three

### 1.4 Memory Write Policy

Automatically trigger a structured memory write when a significant task completes. Currently memory is written on-demand; make it systematic.

- On Sonnet/Opus task completion, a post-task hook checks: *was this notable? did it involve multiple tools? did it resolve something non-trivial?*
- If yes, Haiku generates a structured memory entry: what was asked, what was done, what worked, any caveats
- Domain-tag the entry (home, personal, tech, family) for scoped retrieval later
- Entries with high importance scores feed the solution_patterns table via Opus (weekly batch)

### Phase 1 Task Breakdown

| Priority | Task | Effort | Depends On | Notes |
|---|---|---|---|---|
| P1 | `solution_patterns` table + schema migration | 1–2 hrs | — | Few-shot retrieval foundation |
| P1 | Routing decision logger | 1–2 hrs | — | Critical dependency for Phase 3 |
| P2 | Hybrid retrieval upgrade | 2–3 hrs | Memory service | Cosine + recency + access weighting |
| P2 | Post-task memory write hook | 2–3 hrs | Routing logger | Auto-trigger on task complete |
| P3 | Opus-driven solution pattern extraction | 2 hrs | Both tables | Weekly batch job, Opus-rated |

---

## Phase 2 — Proactive Intelligence: Ambient Awareness
**Timeline: Weeks 2–5 · ~18–24 hours remaining**

This is the shift from reactive to proactive. The agent stops waiting to be asked and starts monitoring, surfacing, and alerting based on context it already has. Importantly, the infrastructure to support this (Redis Streams event bus, alert routing, n8n ingestion, scheduler) is already in place — new monitors plug into existing patterns.

### 2.1 Home Assistant Integration

Given your existing HA and UniFi setup this is high-value, low-effort. The `knownClients` table schema is already deployed for UniFi device tracking.

- Build an HA MCP server or n8n webhook bridge exposing: entity states, automations, history, and event bus
- Agent can query home state as context before responding to anything location or schedule-adjacent
- Proactive alerts: anomalous sensor readings, devices left on, energy spikes — agent decides via Sonnet whether to notify, routed through the existing alert system
- UniFi integration: wire `knownClients` to actual UniFi polling — unknown device detection, bandwidth anomalies, offline nodes surface via morning briefing

### 2.2 Context Aggregator & Morning Briefing

Build a daily context assembly pipeline that runs on a schedule, not in response to a message. Uses the existing scheduler skill to register the cron, existing n8n events for ingestion, and existing alert routing for delivery.

- Scheduler task pulls: calendar events, weather, home state, open reminders, last 24hrs of n8n events, and HA alerts
- Sonnet synthesizes into a prioritized briefing — not a list dump but an actual summary with suggested actions
- Delivered via preferred channel (Discord or Slack, both already integrated)
- The briefing itself becomes a memory entry, creating a longitudinal record of daily context

### 2.3 Ambient Monitoring Agents

Persistent lightweight watchers that run on schedule (via existing scheduler) and escalate to reasoning models only when they find something interesting.

- **Topic monitor** — Firecrawl + search on topics you care about; Haiku filters noise, Sonnet summarizes signal
- **Lab health monitor** — Docker container status, Proxmox resource usage, disk space, service uptime — weekly digest (doctor skill already handles error patterns; this adds proactive digests)
- **Plex availability watcher** — monitors watchlist, notifies when something becomes available

**Significance threshold** — each monitor runs a Haiku pre-filter: *is this worth escalating?* Only escalations go to Sonnet. This keeps costs near zero for routine checks. The alert routing and suppression system already handles deduplication.

### Phase 2 Task Breakdown

| Priority | Task | Effort | Depends On | Notes |
|---|---|---|---|---|
| P1 | Home Assistant MCP/bridge | 4–6 hrs | — | HA REST API → MCP tools or n8n bridge |
| P1 | Morning briefing pipeline | 3–4 hrs | HA bridge, scheduler | Sonnet synthesis, alert routing delivery |
| P2 | UniFi device polling | 2 hrs | HA bridge pattern | Wire knownClients to live UniFi data |
| P2 | Significance threshold layer | 1–2 hrs | — | Haiku pre-filter; plugs into event bus |
| P2 | Topic monitor agent | 2–3 hrs | Firecrawl, threshold layer | Interest topics from memory |
| P3 | Lab health monitor | 2 hrs | Scheduler, docker-executor | Digest separate from doctor's per-error alerts |
| P3 | Plex availability watcher | 2–3 hrs | n8n or Plex API | Watchlist monitoring |

---

## Phase 3 — Self-Improvement Engine
**Timeline: Weeks 5–9 · ~22–28 hours remaining**

This is where the system starts to genuinely improve itself over time. Opus handles all reasoning in this phase. The key distinction from Phase 1's memory work: Phase 1 is about *remembering outcomes*. Phase 3 is about *reasoning about patterns across many outcomes* and changing system behavior as a result.

**Dependency:** Phase 3's routing intelligence upgrade requires at least 4–6 weeks of routing decision logs from Phase 1.3. Build the audit log and reflection cycle first; hold the routing upgrade until data is available.

### 3.1 Interaction Audit Log

Build a structured audit log before building the improvement engine.

- Log every interaction: input, model used, tools called, tool success/fail, output, routing decision (join with `routing_decisions`), response time
- Add a lightweight self-assessment step after each Sonnet/Opus response: was this task completed? Did any tool fail? Was a fallback needed?
- Store in Postgres with enough structure to query: *"show me all tasks where tool X failed"* or *"what request types most often escalate from Haiku to Sonnet"*

### 3.2 Weekly Reflection Cycle — Opus

A scheduled weekly task where Opus reads the audit log and produces structured improvement recommendations.

**Input to Opus:** last 7 days of audit log, current system prompt, current tool list, memory retrieval hit rates, routing decision outcomes

**Opus produces a structured report covering:**
- Recurring failure modes with root cause hypotheses
- Tasks where model was over/under-qualified
- Memory retrieval misses — queries that should have hit memory but didn't
- Capability gaps — tasks that required tool fallback or apology
- Proposed prompt improvements with before/after diffs

All recommendations require your explicit approval before deployment — agent proposes, you decide.

### 3.3 Prompt Evolution System

The system prompt is the agent's DNA. Make it evolvable.

- Version control all prompt changes in Postgres with timestamp, author (you or Opus-proposed), and rationale
- A/B test prompt variants on low-stakes tasks before promoting to production
- Opus rewrites specific *sections* rather than the whole prompt — targeted improvements are safer and easier to review
- Rollback is trivially easy — any version can be restored from the log

### 3.4 Routing Intelligence Upgrade

Use the accumulated routing log from Phase 1.3 to make smarter routing decisions.

- After 6+ weeks of logged routing decisions and outcomes, Opus analyzes: which task types were systematically mis-routed?
- Update routing classifier with learned task-type signatures based on actual outcome data
- Add confidence scoring: low-confidence Haiku responses auto-escalate rather than returning uncertain answers

### Phase 3 Task Breakdown

| Priority | Task | Effort | Depends On | Notes |
|---|---|---|---|---|
| P1 | Interaction audit log schema | 2–3 hrs | Phase 1 routing logger | Foundation for all self-improvement |
| P1 | Self-assessment post-task | 3 hrs | Audit log | Haiku self-scores each response |
| P1 | Weekly Opus reflection job | 4–5 hrs | Audit log + self-assessment | Core learning mechanism |
| P2 | Prompt version control | 2 hrs | Audit log | Postgres-backed, rollback-ready |
| P2 | Proposed change approval flow | 2–3 hrs | Reflection job | Human-in-loop gate |
| P2 | Routing upgrade from log data | 3 hrs | 6+ weeks routing data | Data-driven; hold until data is mature |
| P3 | Prompt A/B testing framework | 4 hrs | Prompt versioning | Safe staged rollout |

---

## Phase 4 — Multi-Agent Architecture
**Timeline: Weeks 9–14 · ~14–20 hours remaining**

The subagent system already exists: isolated sessions, concurrency limits, async/sync modes, parent/child tracking, and full transcript persistence in `subagentRuns`. This phase formalizes the IO contract between orchestrator and workers, and builds specialist configurations on top of the existing infrastructure — not from scratch.

### 4.1 Orchestrator / Worker Contract

The current subagent system accepts free-text tasks and returns free-text results. Formalize with structured schemas so orchestrators can reliably parse worker outputs.

- Define a typed IO envelope: `{task_type, input_schema, output_schema, allowed_tools[], timeout_ms}`
- Workers write structured results to Redis for the orchestrator to collect and synthesize
- Orchestrator (Sonnet) handles all user-facing interaction; workers (Haiku or specialist) execute subtasks
- This is a thin layer on top of existing `sessions_spawn` — mainly schema enforcement and output parsing

### 4.2 Specialist Agent Library

Build a small library of pre-configured specialist agents, each with a focused system prompt and limited tool access. These use the existing `allowed_tools` / `blocked_tools` fields in `subagentRuns`.

- **Home agent** — HA, UniFi, calendar only. Answers anything home/family related.
- **Research agent** — Firecrawl, web search, memory. Handles any "find out about X" task.
- **Lab agent** — docker-executor, system info, Proxmox. Handles infrastructure tasks.
- **Planner agent** — reminders, notes, scheduler. Handles time and task management.

Specialist configs are stored as named presets — orchestrator picks the right specialist by task type.

### 4.3 Critique Loop

For high-stakes outputs (anything resulting in a real-world action), add a critic pass before execution.

- After orchestrator produces a plan, a second Haiku instance reviews with a critic prompt
- Critic checks: is this safe? Does it match what was asked? Are there side effects? Is there a simpler approach?
- Orchestrator sees critique and either confirms or revises before acting
- Log critique outcomes in the audit log — feeds Phase 3 reflection

### Phase 4 Task Breakdown

| Priority | Task | Effort | Depends On | Notes |
|---|---|---|---|---|
| P1 | Orchestrator/worker IO contract | 2–3 hrs | Phase 3 stable | Structured schemas on existing subagents |
| P1 | Home specialist agent config | 2–3 hrs | Phase 2 HA integration | HA + UniFi + calendar allowed_tools preset |
| P2 | Research specialist agent config | 1–2 hrs | Worker contract | Firecrawl + memory + web preset |
| P2 | Lab specialist agent config | 1–2 hrs | Worker contract | Docker + scheduler preset |
| P2 | Critique loop for actions | 3–4 hrs | Orchestrator split | Haiku critic on real-world actions |
| P3 | Planner specialist agent config | 1–2 hrs | Worker contract | Reminders + notes + scheduler preset |
| P3 | Critique outcome logging | 1 hr | Critique loop + audit log | Feeds Phase 3 reflection |

---

## Phase 5 — Autonomy & Closed-Loop Improvement
**Timeline: Months 4–6+ · ~23–31 hours remaining**

Phase 5 is never fully "done" — it's the ongoing operating mode once the previous phases are stable. The system can now identify its own capability gaps, propose new tools, and execute long-horizon tasks without step-by-step guidance. Your role shifts from operator to approver.

### 5.1 Gap Detection & Skill Proposal

The reflection cycle from Phase 3 already identifies gaps. Phase 5 closes the loop by having the agent propose solutions, not just problems.

- Opus monthly review: reads 30 days of audit logs, identifies the top 3 capability gaps by frequency and impact
- For each gap, Opus produces a structured proposal: what capability is missing, what tool/integration would address it, estimated build effort, and a draft spec
- Proposals are queued for your review — you approve, reject, or defer
- Approved proposals get executed using docker-executor and skill-creator (already deployed) to build and test the new capability

### 5.2 Long-Horizon Task Execution

Enable multi-day tasks that the agent works on autonomously, checkpointing progress and resuming without you re-initiating.

- Task state stored in Postgres: goal, steps completed, current step, blockers, next action
- Scheduled executor checks for in-progress tasks and advances them if unblocked
- Agent surfaces blockers when human input is needed — otherwise works independently
- Examples: *"Research and summarize the best self-hosted alternatives to X over the next week"*, *"Monitor home energy usage for 2 weeks and produce a report"*

### 5.3 Permission Tier System

As autonomy increases, explicit permission scoping becomes critical. This is the safety layer that makes everything else viable.

| Tier | Scope | Behavior |
|---|---|---|
| **0** | Read only | Always permitted: memory retrieval, sensor reads, web search, calendar view |
| **1** | Write to personal data | Soft confirmation unless pre-approved pattern: reminders, notes, memory updates |
| **2** | External action | Always requires explicit confirmation: sending messages, creating events, modifying files |
| **3** | Infrastructure change | Approval + audit log entry: deploying containers, modifying system prompts, installing skills |
| **4** | Irreversible | Confirmation + 5-minute delay: deleting data, external API calls with side effects |

> This is worth thinking about from Phase 2 onward, even if you don't enforce it strictly until Phase 5. Having the mental model in place early will shape better design decisions throughout.

### 5.4 Synthetic Few-Shot Library (Compounding)

By this phase you have months of audit log data. Systematically harvest the best examples into a few-shot library.

- Opus monthly: scans audit log for highly-rated interactions (by self-assessment), extracts as structured examples
- Examples are tagged by task type and stored in the `solution_patterns` table from Phase 1
- Retrieval layer surfaces the 2–3 most relevant examples as context prefix for any new task
- The agent effectively shows itself how it solved similar things before — the closest approximation to fine-tuning without actually training

### Phase 5 Task Breakdown

| Priority | Task | Effort | Depends On | Notes |
|---|---|---|---|---|
| P1 | Permission tier enforcement | 4–6 hrs | Phase 4 stable | Non-negotiable safety layer |
| P1 | Long-horizon task state store | 3–4 hrs | Phase 4 orchestrator | Postgres task state schema |
| P1 | Gap proposal pipeline | 4–5 hrs | Phase 3 reflection | Opus proposes, you approve |
| P2 | Proposal execution engine | 4–5 hrs | Gap proposals, docker-executor | Agent builds its own tools |
| P2 | Synthetic few-shot harvester | 3 hrs | Audit log (months of data) | Monthly Opus job |
| P3 | Long-horizon task executor | 3–4 hrs | Task state store | Scheduled autonomous advancement |
| P3 | Monthly capability review | 2 hrs | All Phase 5 components | Ongoing operating cadence |

---

## Ideas Backlog

Items captured from research and brainstorming that don't fit cleanly into the current phase roadmap. Review when planning Phase 5 gap proposals.

### Browser Automation (Playwright/Puppeteer)
Firecrawl handles reading but not interaction. A Playwright integration would enable:
- Logging into portals requiring button clicks
- Actually booking/reserving (tables, tickets) not just finding links
- Navigating SPAs where data is only revealed after user interactions

### Plex Integrations
- **Spoiler-free companion** — query current playback timestamp before answering questions about a show/film
- **Semantic library search** — ingest Plex titles/plot summaries/subtitle text into vector memory; find episodes by meaning ("the one where Dwight starts a fire")
- **Smart recommender** — suggestions based on family viewing history, mood, and who's watching (Tautulli integration)

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

- **The system learns — the model doesn't.** Every improvement you make is to the scaffolding, memory, and routing. Accept this and you'll stop fighting the constraint.
- **Opus is expensive and brilliant** — use it only for things that shape the system's future behavior, never for routine tasks.
- **Approval gates are features, not friction.** Every Opus-proposed change going through your review is also training signal for what you actually want.
- **Build for rollback first.** Any component that can change the system's behavior should be versioned and instantly reversible.
- **The few-shot library compounds.** After 6 months of logging, the agent effectively has a custom knowledge base of how you like things done. This is the closest you'll get to fine-tuning without fine-tuning.
- **Leverage what exists.** The foundation is built. Before adding a new table, service, or abstraction, check whether the existing event bus, alert routing, scheduler, or subagent system already provides 80% of what's needed.

---

*Total estimated remaining work: ~87–115 hours across Phases 1–5, spread over 4–6 months. Foundation is deployed and operational. Phase 1 delivers immediate improvements to memory quality and makes routing behavior visible. Each subsequent phase makes the previous investment more valuable.*
