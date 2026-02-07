# Phased Plan Evaluation

## Overall assessment
The plan is well-structured and logically sequenced, but it currently carries **execution risk** in four areas: timeline realism, cross-phase dependency coupling, security timing, and test-gate reliability.

## Key concerns and recommendations

### 1) Week-by-week scope is likely too aggressive
**Concern:** Phase 1 alone includes container infra, ORM schema/migrations, provider abstraction, orchestrator loop, Discord interface, slash commands, observability, and a large unit/integration test matrix in a single week.

**Why this matters:** This increases the risk of partial implementations and unstable foundations that ripple into later phases.

**Recommendation:** Split each phase into:
- **Must-have acceptance slice** (minimal production-ready subset)
- **Stretch backlog** (deferred items if schedule slips)

For Phase 1, prioritize: boot path + one provider + one tool call cycle + one interface + smoke tests.

---

### 2) Some dependencies appear before enabling infrastructure is fully in place
**Concern:** Phase 2 publishes proactive alerts while event bus routing is deferred to Phase 3.

**Why this matters:** Temporary direct integrations often become permanent, then create migration debt when the event bus arrives.

**Recommendation:** Add a lightweight event abstraction in Phase 1 (interface + adapter), even if backend routing matures in Phase 3. This avoids rework in Email/Reminder alert emitters.

---

### 3) Security and privacy controls are partially back-loaded
**Concern:** Strong hardening is concentrated in Phase 4, but sensitive data handling begins in Phases 1-2 (email content, message logs, long-term facts).

**Why this matters:** Retrofits on logging, retention, and secrets rotation are expensive and risk leaking sensitive user data.

**Recommendation:** Pull forward a "minimum security baseline" into Phase 1:
- structured log redaction policy (default deny for message content)
- explicit retention policy for Redis/Postgres records
- per-tool permission checks for high-risk actions (create calendar events, other state-changing tools)
- auditable confirmation tokens for state-changing actions

---

### 4) Provider abstraction may hide protocol edge-case incompatibilities
**Concern:** Treating all non-Anthropic providers as OpenAI-compatible is pragmatic but can break on tool calling, usage fields, or streaming quirks across Gemini/OpenRouter/local servers.

**Why this matters:** Failures may appear only in production provider swaps.

**Recommendation:** Define a capability matrix in config (supports tools, supports usage metrics, supports JSON schema strictness) and gate behavior at runtime.

---

### 5) Confirmation UX for destructive actions is underspecified
**Concern:** The plan requires explicit confirmation for send/create actions, but does not define a secure confirmation flow in chat.

**Why this matters:** Ambiguous confirmations can cause accidental sends/creates or spoofed approvals.

**Recommendation:** Introduce a standard confirmation protocol:
- assistant returns draft + immutable action hash
- user must reply with a dedicated confirm command referencing hash
- hash expires quickly and is single-use

---

### 6) Test-gate policy could block progress due to external integration flakiness
**Concern:** "All tests must pass" per phase is good discipline, but many integrations (IMAP, calendar, UniFi, Plex, weather, package tracking) are network-dependent.

**Why this matters:** CI instability can halt phase advancement for non-regression reasons.

**Recommendation:** Classify tests into tiers:
- **Required gate:** unit + deterministic integration with mocks/fixtures
- **Advisory:** live-provider contract tests
- **Optional nightly:** full end-to-end against real services

---

### 7) Operational complexity increases sharply by Phase 5+
**Concern:** Browser automation, smart-home control, infra monitoring, mobile app, and voice all increase blast radius.

**Why this matters:** A single orchestrator process can become overloaded and difficult to reason about.

**Recommendation:** Define service boundaries early:
- keep core orchestrator slim
- move heavy/long-running capabilities behind worker queues
- enforce per-skill concurrency and circuit breakers

---

## Suggested cross-phase exit criteria upgrades
For each phase gate, include the following measurable criteria in addition to "tests pass":
1. **Reliability SLO:** e.g., p95 response latency target and error budget.
2. **Security checklist:** redaction, secrets handling, permission checks.
3. **Rollback plan:** clear feature flags or disable toggles for new skills.
4. **Operational runbook:** minimal troubleshooting steps for top failure modes.

## Bottom line
The roadmap is strong and thoughtfully staged, but it will benefit from:
- narrower MVP slices per phase,
- earlier security/permission foundations,
- explicit compatibility/capability handling for providers,
- and a testing strategy that separates deterministic gates from live-service checks.

With those adjustments, the plan should be significantly more predictable to execute and safer to run day-to-day.

---

## Status: APPLIED

The following recommendations have been incorporated into the phase docs:

| # | Recommendation | Applied to | Status |
|---|---------------|------------|--------|
| 1 | Narrower MVP slices | Not doc-changed (execution discipline) | Acknowledged |
| 2 | Event abstraction before event bus | Phase 1 §1.3 — thin EventBus interface | Done |
| 3 | Security baseline pulled forward | Phase 1 §1.3 — log redaction, retention TTLs, confirmation flow | Done |
| 4 | Provider capability matrix | Phase 1 §1.2 — 3 adapters, capabilities config, Google SDK | Done |
| 5 | Confirmation UX with action hashes | Phase 1 §1.5 — confirmation tokens, single-use, 5min TTL | Done |
| 6 | Tiered test gates | Phases 1-7 test-gate sections — gate/advisory/nightly tiers | Done |
| 7 | Service boundaries for Phase 5+ | Phase 5 §5.6 — worker process architecture | Done |

Additionally applied:
- **External skill SDK** — Phase 1 §1.5 (SkillContext, manifest, external loading), Phase 4 §4.4 (hardening), Phase 4 §4.8 (SKILL-SDK.md docs)
- **Worker processes** — Phase 5 §5.6 (runsInWorker flag, resource limits, circuit breakers)

Post-review amendments:
- **Event delivery semantics** — Phase 3 §3.1 and tests now define secure at-least-once delivery with idempotency keys (not exactly-once)
- **DND policy** — Phase 4 now states security + system alerts bypass DND
- **Proxmox safety** — Phase 6 now requires confirmation for `shutdown` as well as `stop/restart`
- **REST trust boundary** — Phase 7 now requires trusted-source verification for Tailscale identity headers
- **External skill supply chain controls** — Phase 1 + Phase 4 now require integrity checks, trusted-source policy options, and safer loader path/permission validation
- **Pairing/JWT hardening** — Phase 7 now defines pairing TTL/attempt limits/device proof, JWT claim validation, key rotation, and refresh-token revocation controls
- **Privacy/retention controls** — Phase 1 now sets default `context_facts` retention (configurable) and explicit export/delete controls
- **Alert data minimization** — Phase 2 urgent email alerts now default to metadata-only payloads with snippet opt-in
