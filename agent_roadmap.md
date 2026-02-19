# AI Agent Implementation Roadmap
### From Reactive Assistant to Autonomous Agent
*5 Phases · Personal Home Lab · Containerized · API-First*

---

## Current Stack & Constraints

| | |
|---|---|
| **Models** | Haiku (light tasks) → Sonnet (complex) → Opus (reasoning/self-improvement) |
| **Storage** | Postgres + pgvector · Redis · Sentence Transformers for embeddings |
| **Runtime** | Fully containerized (Docker) · Home lab (Proxmox) · n8n for orchestration |
| **Available** | Memory, notes, reminders, scheduler, n8n, firecrawl, weather, PDF, subagents, docker-executor, skills |
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
| 1 | Weeks 1–3 | Semantic memory + smart routing | Remembers your preferences and past solutions |
| 2 | Weeks 3–6 | HA integration + proactive briefings | Surfaces things you didn't ask for |
| 3 | Weeks 6–10 | Reflection cycle + prompt evolution | Identifies and patches its own weaknesses |
| 4 | Weeks 10–15 | Specialist agents + critique loop | Parallelizes work, self-validates actions |
| 5 | Months 4–6+ | Autonomous gap closure | Proposes and builds its own improvements |

---

## Phase 1 — Foundation: Smarter Memory & Routing
**Timeline: Weeks 1–3**

Everything else depends on this phase being solid. The goal is to replace shallow memory with a proper semantic store and make the routing layer aware of task *type*, not just complexity.

### 1.1 Semantic Memory Upgrade

You already have pgvector and sentence transformers — the gap is structure. Right now memory is likely flat key-value or short snippets. Upgrade to a schema that captures context, outcome, and recency together.

**memory_entries table**
- Fields: `id`, `content`, `embedding (vector)`, `category`, `outcome (success/fail/partial)`, `source_tool`, `created_at`, `last_accessed`, `access_count`, `tags[]`
- Index on embedding with `ivfflat` or `hnsw` for fast ANN search
- Separate `solution_patterns` table for successful multi-step resolutions worth retrieving as few-shot examples

**Memory write policy**
- Every task completion triggers a structured memory write via Opus — not just logging what happened but *why* it worked
- Tag memories with domain (home, personal, tech, family) for scoped retrieval

**Retrieval strategy**
- Hybrid search: semantic similarity (pgvector cosine) + recency weighting + tag filter
- Surface top 3–5 relevant memories as context prefix before every non-trivial task

### 1.2 Tiered Routing Upgrade

Extend your current Haiku/Sonnet split to a four-tier system with explicit task-type awareness.

- **Haiku** — fast, narrow, well-defined tasks (lookups, formatting, tool dispatch, simple retrieval)
- **Sonnet** — synthesis, multi-step reasoning, anything requiring judgment
- **Opus** — self-improvement cycles, prompt rewrites, gap analysis, complex orchestration (scheduled, not real-time)
- **Specialist routing** — add latency as a third signal alongside complexity and task type; real-time interaction always prefers Haiku unless quality threshold is clearly at risk

Implement routing as a lightweight classifier (Redis-cached decision tree or simple prompt to Haiku) that returns `{model, rationale, confidence}`. Log every routing decision — this data feeds Phase 3.

### Phase 1 Task Breakdown

| Priority | Task | Effort | Depends On | Notes |
|---|---|---|---|---|
| P1 | pgvector memory schema | 3–4 hrs | — | Foundation for everything else |
| P1 | Semantic retrieval service | 2–3 hrs | Memory schema | Hybrid cosine + recency |
| P1 | Memory write policy | 2 hrs | Memory schema | Opus summarizes on task complete |
| P2 | Routing classifier upgrade | 3 hrs | — | Add task-type dimension |
| P2 | Routing decision logger | 1 hr | Routing classifier | Feeds Phase 3 analytics |
| P3 | Solution pattern store | 2 hrs | Memory schema | Few-shot retrieval by task type |

---

## Phase 2 — Proactive Intelligence: Ambient Awareness
**Timeline: Weeks 3–6**

This is the shift from reactive to proactive. The agent stops waiting to be asked and starts monitoring, surfacing, and alerting based on context it already has. This is not just cron jobs — each scheduled task has a reasoning layer that decides whether what it found is worth surfacing and how to contextualize it for you.

### 2.1 Home Assistant Integration

Given your existing HA and UniFi setup this is high-value, low-effort. The agent gains physical-world context.

- Build an HA MCP server or n8n webhook bridge exposing: entity states, automations, history, and event bus
- Agent can query home state as context before responding to anything location or schedule-adjacent
- Proactive alerts: anomalous sensor readings, devices left on, energy spikes — agent decides via Sonnet whether to notify
- UniFi integration: unknown device detection, bandwidth anomalies, offline nodes — surface via morning briefing

### 2.2 Context Aggregator & Morning Briefing

Build a daily context assembly pipeline that runs on a schedule, not in response to a message.

- n8n workflow pulls: calendar events, weather, home state, open reminders, last 24hrs of HA alerts, and Plex new additions
- Sonnet synthesizes into a prioritized briefing — not a list dump but an actual summary with suggested actions
- Delivered via your preferred channel (push notification, email, Slack — whatever fits your setup)
- The briefing itself becomes a memory entry, creating a longitudinal record of daily context over time

### 2.3 Ambient Monitoring Agents

Persistent lightweight watchers that run on schedule and escalate to reasoning models only when they find something interesting.

- **Topic monitor** — firecrawl + web search on topics you care about; Haiku filters noise, Sonnet summarizes signal
- **Lab health monitor** — Docker container status, Proxmox resource usage, disk space, service uptime — weekly digest
- **Plex availability watcher** — monitors wishlist/watchlist, notifies when something becomes available

**Significance threshold** — each monitor runs a Haiku pre-filter: *is this worth escalating?* Only escalations go to Sonnet. This keeps costs near zero for routine checks.

### Phase 2 Task Breakdown

| Priority | Task | Effort | Depends On | Notes |
|---|---|---|---|---|
| P1 | Home Assistant MCP/bridge | 4–6 hrs | Phase 1 complete | HA REST API → MCP tools |
| P1 | Morning briefing pipeline | 3–4 hrs | HA bridge, n8n | n8n orchestrated, Sonnet synthesis |
| P2 | Significance threshold layer | 2 hrs | Routing upgrade | Haiku pre-filter for all monitors |
| P2 | Topic monitor agent | 2–3 hrs | Firecrawl, threshold layer | Interest topics from memory |
| P2 | Lab health monitor | 2 hrs | Docker executor | Digest not real-time alerts |
| P3 | UniFi integration | 3 hrs | HA bridge pattern | Device anomaly detection |
| P3 | Plex availability watcher | 2 hrs | Plex MCP | Watchlist monitoring |

---

## Phase 3 — Self-Improvement Engine
**Timeline: Weeks 6–10**

This is where the system starts to genuinely improve itself over time. Opus handles all reasoning in this phase. The key distinction from Phase 1's memory work: Phase 1 is about *remembering outcomes*. Phase 3 is about *reasoning about patterns across many outcomes* and changing system behavior as a result.

### 3.1 Interaction Audit Log

You can't improve what you don't measure. Build a structured audit log before building the improvement engine.

- Log every interaction: input, model used, tools called, tool success/fail, output, routing decision, response time
- Add a lightweight self-assessment step after each Sonnet/Opus response: was this task completed? Did any tool fail? Was a fallback needed?
- Store in Postgres with enough structure to query: *"show me all tasks where tool X failed"* or *"what request types most often escalate from Haiku to Sonnet"*

### 3.2 Weekly Reflection Cycle — Opus

A scheduled weekly task where Opus reads the audit log and produces structured improvement recommendations.

**Input to Opus:** last 7 days of audit log, current system prompt, current tool list, memory retrieval hit rates

**Opus produces a structured report covering:**
- Recurring failure modes with root cause hypotheses
- Tasks where model was over/under-qualified (Haiku doing Sonnet work or vice versa)
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

Use the accumulated routing log from Phase 1 to make smarter routing decisions.

- After 4+ weeks of logged routing decisions and outcomes, Opus analyzes: which task types were systematically mis-routed?
- Update routing classifier with learned task-type signatures based on actual outcome data
- Add confidence scoring: low-confidence Haiku responses auto-escalate rather than returning uncertain answers

### Phase 3 Task Breakdown

| Priority | Task | Effort | Depends On | Notes |
|---|---|---|---|---|
| P1 | Interaction audit log schema | 2–3 hrs | Phase 1 routing logger | Foundation for all improvement |
| P1 | Self-assessment post-task | 3 hrs | Audit log | Haiku self-scores each response |
| P1 | Weekly Opus reflection job | 4–5 hrs | Audit log, self-assessment | Core learning mechanism |
| P2 | Prompt version control | 2 hrs | Audit log | Postgres-backed, rollback-ready |
| P2 | Proposed change approval flow | 2–3 hrs | Reflection job | Human-in-loop gate |
| P2 | Routing upgrade from log data | 3 hrs | 8+ weeks routing data | Data-driven routing improvement |
| P3 | Prompt A/B testing framework | 4 hrs | Prompt versioning | Safe staged rollout |

---

## Phase 4 — Multi-Agent Architecture
**Timeline: Weeks 10–15**

With a stable foundation, memory system, and self-improvement loop in place, you can safely introduce parallel and specialized sub-agents without it becoming chaotic. The orchestrator (Sonnet) coordinates; workers (Haiku or specialized) execute.

### 4.1 Orchestrator / Worker Split

Formalize the distinction between the orchestrator agent (which plans, routes, and synthesizes) and worker agents (which execute specific tasks).

- **Orchestrator:** always Sonnet, handles all user-facing interaction, breaks complex tasks into subtasks
- **Workers:** Haiku instances spun up for parallel execution — web search, memory retrieval, tool calls
- You already have the subagents skill — this phase is about formalizing the contract between orchestrator and workers with structured input/output schemas
- Workers write their outputs to Redis for the orchestrator to collect and synthesize — no direct chaining

### 4.2 Specialist Agent Library

Build a small library of pre-configured specialist agents, each with a focused system prompt and limited tool access.

- **Home agent** — only has access to HA, UniFi, and calendar. Answers anything home/family related.
- **Research agent** — firecrawl, web search, memory. Handles any "find out about X" task.
- **Lab agent** — docker-executor, system info, Proxmox API. Handles infrastructure tasks.
- **Planner agent** — calendar, reminders, scheduler. Handles time and task management.

Tighter context per specialist = better focus = lower cost per quality unit than a generalist handling everything.

### 4.3 Critique Loop

For high-stakes outputs (anything that results in a real-world action), add a critic pass before execution.

- After orchestrator produces a plan or response, a second Haiku instance reviews it with a critic prompt
- Critic checks: is this safe? Does it match what was asked? Are there side effects? Is there a simpler approach?
- Orchestrator sees critique and either confirms or revises before acting
- Log critique outcomes — over time this data shows where the orchestrator most often needs correction

### Phase 4 Task Breakdown

| Priority | Task | Effort | Depends On | Notes |
|---|---|---|---|---|
| P1 | Orchestrator/worker contract | 3–4 hrs | Phase 3 stable | Structured IO schemas in Redis |
| P1 | Home specialist agent | 2–3 hrs | HA integration, contract | HA + UniFi + calendar only |
| P2 | Research specialist agent | 2 hrs | Worker contract | Firecrawl + memory + web |
| P2 | Lab specialist agent | 2–3 hrs | Worker contract | Docker + Proxmox |
| P2 | Critique loop for actions | 3–4 hrs | Orchestrator split | Haiku critic on all real-world actions |
| P3 | Planner specialist agent | 2 hrs | Worker contract | Calendar + reminders |
| P3 | Critique outcome logging | 1 hr | Critique loop, audit log | Feeds Phase 3 reflection |

---

## Phase 5 — Autonomy & Closed-Loop Improvement
**Timeline: Months 4–6+**

Phase 5 is never fully "done" — it's the ongoing operating mode once the previous phases are stable. The system can now identify its own capability gaps, propose new tools, and execute long-horizon tasks without step-by-step guidance. Your role shifts from operator to approver.

### 5.1 Gap Detection & Skill Proposal

The reflection cycle from Phase 3 already identifies gaps. Phase 5 closes the loop by having the agent propose solutions, not just problems.

- Opus monthly review: reads 30 days of audit logs, identifies the top 3 capability gaps by frequency and impact
- For each gap, Opus produces a structured proposal: what capability is missing, what tool/integration would address it, estimated build effort, and a draft spec
- Proposals are queued for your review — you approve, reject, or defer
- Approved proposals get executed by the agent using docker-executor and skill-creator to actually build and test the new capability

### 5.2 Long-Horizon Task Execution

Enable multi-day tasks that the agent works on autonomously, checkpointing progress and resuming without you re-initiating.

- Task state stored in Postgres: goal, steps completed, current step, blockers, next action
- Scheduled executor checks for in-progress tasks and advances them if unblocked
- Agent surfaces blockers to you when human input is needed — otherwise works independently
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
- The agent effectively shows itself how it solved similar things before — the closest approximation to fine-tuning available without actually training

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

## Key Principles

- **The system learns — the model doesn't.** Every improvement you make is to the scaffolding, memory, and routing. Accept this and you'll stop fighting the constraint.
- **Opus is expensive and brilliant** — use it only for things that shape the system's future behavior, never for routine tasks.
- **Approval gates are features, not friction.** Every Opus-proposed change going through your review is also training signal for what you actually want.
- **Build for rollback first.** Any component that can change the system's behavior should be versioned and instantly reversible.
- **The few-shot library compounds.** After 6 months of logging, the agent effectively has a custom knowledge base of how you like things done. This is the closest you'll get to fine-tuning without fine-tuning.

---

*Total estimated build time across all phases: 80–110 hours of focused work, spread over 4–6 months. Phase 1 delivers value immediately. Each subsequent phase makes the previous investment more valuable.*
