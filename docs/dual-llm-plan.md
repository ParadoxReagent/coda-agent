# Dual LLM Tier Routing

## Context

The agent currently uses a single LLM model for all requests. Simple tasks (notes, reminders, calendar lookups) use the same expensive model as complex research tasks. This wastes money. By routing simple requests to a cheaper/faster model (e.g., Haiku) and only using the capable model (e.g., Sonnet) when needed, we can significantly reduce costs while maintaining quality where it matters.

## Approach: Start Light, Escalate on Demand

**Every request starts with the light model.** If the light model calls a "heavy" tool (subagent spawning, web research, etc.), the system switches to the heavy model for the remainder of that turn. A fast heuristic pre-filter catches obvious complex requests (research keywords, long messages) and routes them directly to heavy.

**Why this approach:**
- No extra LLM call for classification (unlike a pre-classification approach)
- Simple requests (majority of traffic) complete entirely on the light model
- When escalation happens, only a few hundred cheap tokens are "wasted" on the light model's initial call
- The tool call that triggered escalation already contains parsed intent, giving the heavy model good context

## Config Changes

**File: `src/utils/config.ts`** — Add `TierConfigSchema` to `LLMConfigSchema`:

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
    heavy_tools:            # Tools that trigger escalation
      - "delegate_to_subagent"
      - "sessions_spawn"
      - "firecrawl_crawl"
      - "firecrawl_search"
      - "skill_activate"
    heavy_patterns:         # Message patterns that skip straight to heavy
      - "research"
      - "analyze"
      - "compare"
      - "deep dive"
    heavy_message_length: 800  # Char threshold for heavy routing
    show_tier: false           # Show tier indicator in responses
```

Tiers are **opt-in** (`enabled: false` by default). All existing behavior preserved when disabled.

## Files to Modify

### 1. `src/utils/config.ts` — Config schema
- Add `TierConfigSchema` (Zod) with light/heavy provider+model, heavy_tools list, heavy_patterns list, heavy_message_length, show_tier flag
- Add `tiers` field to `LLMConfigSchema`
- Add env var overrides: `TIER_ENABLED`, `TIER_LIGHT_MODEL`, `TIER_HEAVY_MODEL`

### 2. NEW: `src/core/tier-classifier.ts` — Classification logic
Small module (~60 lines) with two methods:
- `classifyMessage(message: string): { tier: "light" | "heavy", reason: string }` — heuristic check (length + patterns)
- `shouldEscalate(toolName: string): boolean` — checks if a tool call triggers escalation

### 3. `src/core/llm/manager.ts` — Tier-aware provider selection
- Add `TierSelection` interface extending `ProviderSelection` with `tier` field
- Add `userTierPreferences` map for per-user per-tier model preferences
- Add `getForUserTiered(userId, tier)` method — resolves provider+model for the requested tier
- Add `setUserTierPreference(userId, tier, provider, model)` method
- Add `isTierEnabled()` / `getUserTierStatus(userId)` helpers
- Existing `getForUser()` unchanged (backward compatible)

### 4. `src/core/orchestrator.ts` — Core routing + escalation (main change)
- Accept optional `TierClassifier` in constructor
- In `handleMessageInner()`:
  1. Before first LLM call: classify message -> pick initial tier -> get provider+model via `getForUserTiered()`
  2. In tool-use loop (line 106): after executing tools, check if any tool name triggers escalation via `tierClassifier.shouldEscalate()`
  3. If escalated: swap `provider` and `model` to heavy tier for all subsequent `provider.chat()` calls in this turn
  4. Pass `tier` to `trackUsage()` calls
- One-way escalation: once heavy, stays heavy for the turn

### 5. `src/skills/base.ts` — Tool-level tier hint
- Add optional `tierHint?: "heavy"` to `SkillToolDefinition`
- Skills can self-declare their tools as heavy (e.g., SubagentSkill marks `delegate_to_subagent` as heavy)

### 6. `src/core/llm/usage.ts` — Tier-aware tracking
- Add optional `tier` field to `UsageRecord`
- Add `getDailyUsageByTier()` method for per-tier cost breakdowns

### 7. `src/core/subagent-manager.ts` — Subagents always use heavy
- In `delegateSync()` and `executeAsyncRun()`: if tiers enabled, use `getForUserTiered(userId, "heavy")` instead of `getForUser(userId)`
- Exception: explicit model/provider in spawn options still overrides

### 8. `src/interfaces/discord-bot.ts` — User-facing commands
- Add `/model tier <light|heavy> <provider> <model>` subcommand
- Update `/model status` to show both tiers and per-tier usage/cost
- Existing `/model set` continues to work (sets both tiers to same model)

### 9. `config/config.example.yaml` — Document the new config
- Add commented-out `tiers` block with examples

### 10. `src/main.ts` — Wire TierClassifier into Orchestrator
- Construct `TierClassifier` from config when tiers enabled
- Pass to Orchestrator constructor

## Implementation Order

1. **Config schema** (`config.ts`) — foundation, no behavior change
2. **TierClassifier** (new file) — standalone, testable
3. **ProviderManager** tier methods (`manager.ts`) — builds on config
4. **SkillToolDefinition** tier hint (`base.ts`) — small addition
5. **UsageTracker** tier field (`usage.ts`) — small addition
6. **Orchestrator** routing + escalation (`orchestrator.ts`) — the core change
7. **SubagentManager** heavy default (`subagent-manager.ts`)
8. **Discord commands** (`discord-bot.ts`)
9. **Wiring** (`main.ts`) + config example

## Verification

1. **Tiers disabled (default)**: Run the agent without `tiers` config — confirm all behavior identical to current
2. **Simple request**: Send "remind me to buy groceries" — confirm it uses the light model (check logs for tier info)
3. **Keyword escalation**: Send "research the best TypeScript frameworks" — confirm it routes directly to heavy due to "research" pattern
4. **Tool-triggered escalation**: Send a message that causes the light model to call `delegate_to_subagent` — confirm mid-turn switch to heavy model in logs
5. **`/model tier` command**: Set light tier to a different model, confirm subsequent simple requests use it
6. **`/model status`**: Verify it shows both tiers and per-tier usage breakdown
7. **Subagents**: Spawn a subagent and confirm it uses the heavy tier model
8. **Cost savings**: Compare usage logs — light tier requests should show lower `estimatedCost`
