# N8n Inbound Event Auto-Response

**Status:** Design — not yet implemented
**Depends on:** n8n webhook integration (implemented), subagent system

---

## Problem

Inbound n8n data (news digests, alerts, research results, etc.) currently lands in the
`n8n_events` table silently. The agent only reacts to `priority: "high"` events by
sending a raw alert to Discord/Slack. There is no way to:

- Have the LLM *interpret* incoming data and compose a useful response
- Route different event types to different behaviors
- Send a formatted summary to a channel automatically

---

## Architecture Overview

```
n8n Workflow
    ↓ POST /n8n-ingest
Webhook Service (port 3001)
    ↓ Redis Streams (coda:events)
N8nSkill event subscriber (n8n.*)
    ↓ [NEW] check auto-respond rules
AutoRespondDispatcher
    ↓ build prompt + event data
Sub-agent LLM call
    ↓ formatted response
MessageSender → Discord / Slack / Telegram
```

The key insight: inbound events already flow through `N8nSkill.startup()`'s event
subscriber. We just need to extend that handler to optionally invoke the LLM and
route the output.

---

## Config Design

Add an `auto_respond` section under `n8n` in `config.yaml`:

```yaml
n8n:
  webhooks:
    web_research:
      url: "..."
      timeout_ms: 30000
      requires_confirmation: false

  auto_respond:
    # Keyed by event type (matches n8n payload `type` field)
    news_digest:
      enabled: true
      prompt: |
        You received a news digest from an automated workflow.
        Summarize the top stories in 3-5 bullet points.
        Be concise — this will be posted directly to Discord.
      channel: discord          # discord | slack | telegram
      cooldown_seconds: 3600    # prevent spam — 0 = no cooldown
      min_priority: normal      # high | normal | low (skip below this)
      max_events_per_call: 5    # cap how many events are bundled per LLM call

    web_research:
      enabled: true
      prompt: |
        You received web research results from an automated workflow.
        Present the findings clearly and cite key sources.
      channel: discord
      cooldown_seconds: 0       # no cooldown — each research result is unique

    weekly_report:
      enabled: true
      prompt: |
        You received a weekly summary report.
        Extract the 3 most important metrics and any action items.
      channel: slack
      cooldown_seconds: 0
```

Fields:
- `enabled` — toggle without removing config
- `prompt` — injected before the event data; tells the LLM how to handle this type
- `channel` — where to route the composed response
- `cooldown_seconds` — per-type rate limit (stored in Redis)
- `min_priority` — skip events below this priority level
- `max_events_per_call` — if multiple events of the same type arrive before the
  cooldown resets, bundle them into one LLM call rather than firing N times

---

## Implementation Plan

### 1. Types — `src/integrations/n8n/types.ts`

Add config types:

```typescript
export interface N8nAutoRespondRule {
  enabled: boolean;
  prompt: string;
  channel: "discord" | "slack" | "telegram";
  cooldown_seconds?: number;        // default 0
  min_priority?: "high" | "normal" | "low"; // default "low"
  max_events_per_call?: number;     // default 1
}

export interface N8nAutoRespondConfig {
  [eventType: string]: N8nAutoRespondRule;
}
```

Add to `N8nSkill`:
```typescript
private autoRespond: N8nAutoRespondConfig = {};
```

### 2. Startup — `src/integrations/n8n/skill.ts`

Load auto-respond rules alongside webhooks in `startup()`:

```typescript
const autoRespondEntries = (cfg.auto_respond as Record<string, unknown>) ?? {};
for (const [type, rule] of Object.entries(autoRespondEntries)) {
  this.autoRespond[type] = rule as N8nAutoRespondRule;
}
```

Extend the existing `ctx.eventBus.subscribe("n8n.*", ...)` handler — after the
database insert, call the dispatcher:

```typescript
await this.queries.insertEvent({ ... });

// [NEW] check for auto-respond rule
const rule = this.autoRespond[payload.type as string];
if (rule && rule.enabled) {
  await this.dispatchAutoRespond(payload.type as string, payload, rule);
}
```

### 3. Dispatcher — `src/integrations/n8n/skill.ts`

New private method:

```typescript
private async dispatchAutoRespond(
  eventType: string,
  payload: Record<string, unknown>,
  rule: N8nAutoRespondRule
): Promise<void> {
  // 1. Priority gate
  const priorityRank = { high: 3, normal: 2, low: 1 };
  const minRank = priorityRank[rule.min_priority ?? "low"];
  const eventRank = priorityRank[(payload.priority as string) ?? "low"];
  if (eventRank < minRank) return;

  // 2. Cooldown check (Redis key: n8n:auto_respond:{eventType}:cooldown)
  if (rule.cooldown_seconds && rule.cooldown_seconds > 0) {
    const key = `n8n:auto_respond:${eventType}:cooldown`;
    const existing = await this.redis.get(key);
    if (existing) {
      this.logger.debug({ eventType }, "Auto-respond suppressed by cooldown");
      return;
    }
    await this.redis.set(key, "1", "EX", rule.cooldown_seconds);
  }

  // 3. Build prompt
  const eventJson = JSON.stringify(payload.data, null, 2);
  const fullPrompt = [
    rule.prompt.trim(),
    "",
    "## Event Data",
    "```json",
    eventJson,
    "```",
  ].join("\n");

  // 4. Publish a job event — picked up by a new AutoRespondConsumer
  //    (keeps LLM calls out of the event bus handler to avoid blocking)
  await this.eventBus.publish({
    eventType: "n8n.auto_respond.queued",
    timestamp: new Date().toISOString(),
    sourceSkill: this.name,
    payload: {
      event_type: eventType,
      channel: rule.channel,
      prompt: fullPrompt,
    },
    severity: "low",
  });
}
```

### 4. AutoRespondConsumer — `src/integrations/n8n/auto-respond.ts` (new file)

Subscribes to `n8n.auto_respond.queued`, calls the LLM, routes output:

```typescript
export class AutoRespondConsumer {
  constructor(
    private eventBus: EventBus,
    private llm: LLMClient,         // existing LLM client interface
    private messageSender: MessageSender,
    private logger: Logger
  ) {}

  start(): void {
    this.eventBus.subscribe("n8n.auto_respond.queued", async (event) => {
      const { event_type, channel, prompt } = event.payload;
      try {
        const response = await this.llm.complete({
          messages: [{ role: "user", content: prompt }],
          max_tokens: 1024,
        });

        await this.messageSender.send(channel, response.text);

        this.logger.info(
          { event_type, channel },
          "Auto-respond message sent"
        );
      } catch (err) {
        this.logger.error(
          { err, event_type },
          "Auto-respond LLM call failed"
        );
      }
    });
  }
}
```

Register in `N8nSkill.startup()`:

```typescript
const consumer = new AutoRespondConsumer(
  ctx.eventBus,
  ctx.llm,
  ctx.messageSender,
  this.logger
);
consumer.start();
```

### 5. Tool update — `n8n_list_webhooks` / new `n8n_list_auto_respond`

Add a tool so the LLM can inspect what auto-respond rules are configured:

```typescript
{
  name: "n8n_list_auto_respond",
  description: "List event types that trigger automatic LLM responses and their configuration.",
  input_schema: { type: "object", properties: {} },
}
```

---

## Sequencing Concerns

The dispatcher publishes a `n8n.auto_respond.queued` event rather than calling the
LLM inline. This is important because:

1. The event bus subscriber must return quickly — blocking it with an LLM call could
   starve other events
2. The queued event pattern gives us retry semantics for free (Redis Streams consumer
   groups will re-deliver on failure)
3. It decouples the "decide to respond" step from the "do the LLM call" step, making
   each testable independently

---

## Safeguards

| Risk | Mitigation |
|---|---|
| Spam if n8n workflow fires repeatedly | `cooldown_seconds` per rule |
| LLM called with huge payload | `max_events_per_call` + truncate `data` to ~2000 chars |
| Runaway cost from high-volume events | `min_priority` gate + cooldown |
| Prompt injection via event data | Event data wrapped in fenced code block, not interpolated into prompt prose |
| Response too long for Discord | MessageSender already handles chunking (2000 char limit) |

---

## n8n Workflow Side

For the agent to auto-respond usefully, n8n workflows must set these fields when
POSTing to `/n8n-ingest`:

```json
{
  "type": "news_digest",         ← must match auto_respond key in config
  "source_workflow": "my-news-workflow",
  "priority": "normal",          ← must meet min_priority threshold
  "data": {
    "articles": [...]            ← this is what gets passed to the LLM
  }
}
```

The `type` field is the routing key. Keep types stable — changing them requires
updating config.

---

## Files to Create / Modify

| File | Change |
|---|---|
| `src/integrations/n8n/types.ts` | Add `N8nAutoRespondRule`, `N8nAutoRespondConfig` |
| `src/integrations/n8n/skill.ts` | Load rules, extend event subscriber, add `dispatchAutoRespond()`, add `n8n_list_auto_respond` tool |
| `src/integrations/n8n/auto-respond.ts` | New: `AutoRespondConsumer` class |
| `config/config.example.yaml` | Add `n8n.auto_respond` section with examples |

No database changes needed — uses existing `n8n_events` table and Redis for cooldowns.
