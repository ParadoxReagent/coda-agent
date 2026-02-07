# Phase 3: Home Integration — UniFi, Plex, Event Bus

**Timeline:** Week 3
**Depends on:** Phase 1 (Foundation), Phase 2 (MVP Skills for event bus consumers)
**Goal:** Integrate home network monitoring and media control, and build the event bus that makes coda proactively useful.

---

## 3.1 Event Bus

### Redis Streams Implementation (`src/core/events.ts`)
- [ ] Implement `EventBus` class using Redis Streams:
  - `publish(eventType, payload)` — publish an event to a stream
  - `subscribe(eventPattern, callback)` — register a handler for event types
  - `startConsumer()` — background task consuming events from streams
- [ ] Event format:
  ```typescript
  interface CodaEvent {
    eventType: string;         // "alert.unifi.new_client"
    timestamp: string;         // ISO 8601
    sourceSkill: string;       // "unifi"
    payload: Record<string, unknown>;
    severity: "high" | "medium" | "low";
  }
  ```
- [ ] Consumer groups for reliable delivery (events aren't lost on restart)
- [ ] Dead letter handling for events that fail processing 3 times

### Alert Router (`src/core/alerts.ts`)
- [ ] Implement `AlertRouter` that subscribes to `alert.*` events:
  - Route events to configured channels (Discord, Slack, future)
  - Respect per-event-type rules:
    - `severity` — high/medium/low
    - `channels` — which interfaces to notify
    - `quietHours` — suppress during configured quiet hours (except security events)
    - `cooldown` — minimum seconds between duplicate alerts per source
- [ ] Load rules from `config/alerts.yaml`
- [ ] Quiet hours configuration: start/end times, timezone, override for high-severity
- [ ] Cooldown tracking in Redis (per eventType + source key, TTL = cooldown seconds)

### Alert Formatting
- [ ] Each event type has a formatter that produces channel-appropriate output:
  - Discord: embeds with color-coded severity (red/orange/blue)
  - Slack: Block Kit formatted messages
  - Plain text fallback
- [ ] Include actionable context in alerts (e.g., "Reply with `block xx:xx:xx` to block this client")

---

## 3.2 UniFi Monitoring Skill

### UniFi API Client (`src/skills/unifi/client.ts`)
- [ ] Implement async UniFi Controller API client using `undici` or `fetch`:
  - Authentication (local credentials, LAN-only)
  - `getClients()` — list all connected clients
  - `getDevices()` — list APs, switches, gateways
  - `getClientDetails(mac)` — detailed info for one client
  - `blockClient(mac)` / `unblockClient(mac)` — client control
- [ ] Session management: login, cookie persistence, auto-reauth on 401

### Background Monitor (`src/skills/unifi/monitor.ts`)
- [ ] Background polling task (every 60 seconds):
  1. Fetch current client list
  2. Compare against known clients (loaded from Postgres at startup)
  3. Detect new/unknown clients → publish `alert.unifi.new_client`
  4. Compare bandwidth against rolling baseline → publish `alert.unifi.bandwidth_spike`
  5. Check AP/device health → publish `alert.unifi.device_offline`
- [ ] Update known clients list on explicit user approval ("Yes, this is my device")

### Traffic Baseline (`src/skills/unifi/baseline.ts`)
- [ ] Maintain rolling traffic baseline per client in Redis:
  - Average TX/RX over last 24 hours
  - Standard deviation
  - Spike threshold: mean + 3 * stddev (configurable)
- [ ] Learn baseline over first 7 days of operation
- [ ] Decay old data to adapt to changing patterns

### Known Clients Database
- [ ] Drizzle schema — `known_clients` table:
  - `mac` (primary key), `hostname`, `friendlyName`, `firstSeen`, `lastSeen`
  - `isKnown` (boolean — user-approved), `notes`
- [ ] Seed from `config/known_clients.yaml` on first run
- [ ] Tool to add/update known clients: "That's my phone, name it Mike's iPhone"

### Tools
- [ ] Tool: `unifi_status`
  - Output: client count, bandwidth summary, AP health, gateway uptime
- [ ] Tool: `unifi_clients`
  - Input: `filter` (optional: "unknown", "wireless", "wired")
  - Output: client list with hostname, IP, MAC, AP, signal, bandwidth
- [ ] Tool: `unifi_alerts`
  - Input: `hoursBack` (default 24)
  - Output: recent anomaly events
- [ ] Tool: `unifi_client_lookup`
  - Input: `query` (MAC, hostname, or IP)
  - Output: detailed client info + history
- [ ] Tool: `unifi_block_client`
  - Input: `mac` (string)
  - Output: confirmation (requires explicit user confirmation before execution)
  - **Destructive action — orchestrator must confirm with user before executing**

---

## 3.3 Scheduled Tasks System

### Why Scheduled Tasks
The event bus handles reactive events, but coda also needs to run actions on a schedule — pre-fetch briefing data, run periodic health checks, trigger time-based automations. The scheduled tasks system provides cron-based recurring execution.

### Implementation (`src/core/scheduler.ts`)
- [ ] Implement `TaskScheduler` class:
  - Cron-based scheduling using `croner` (lightweight, no native deps)
  - Tasks registered at startup by skills or core components
  - Each task has: `name`, `cronExpression`, `handler`, `enabled` flag
  - Configurable in `config.yaml` under `scheduler.tasks`
- [ ] Built-in scheduled tasks:
  - `briefing.prepare` — pre-fetch and cache morning briefing data (default: 6:00 AM)
  - `email.poll` — trigger email polling (backup to the interval-based poller)
  - `reminders.check` — check for due reminders (every 60s, default from Phase 2)
  - `health.check` — run internal health checks and log status (every 5 min)
- [ ] Skills can register their own scheduled tasks at startup:
  - UniFi: `unifi.poll` — client/device polling (every 60s)
  - Future skills register their own schedules
- [ ] Execution logging: every task run is logged with duration and success/failure
- [ ] Error handling: failed tasks retry once, then log error and skip until next scheduled run
- [ ] `alert.system.task_failed` event published on persistent task failures

### Tools
- [ ] Tool: `scheduler_list`
  - Output: all registered scheduled tasks with cron expression, last run, next run, status
- [ ] Tool: `scheduler_toggle`
  - Input: `taskName` (string), `enabled` (boolean)
  - Output: confirmation of enable/disable
  - Use case: "Disable the email poller" or "Re-enable UniFi monitoring"

### Configuration
```yaml
scheduler:
  tasks:
    briefing_prepare:
      cron: "0 6 * * *"  # 6:00 AM daily
      enabled: true
    health_check:
      cron: "*/5 * * * *"  # Every 5 minutes
      enabled: true
```

---

## 3.4 Plex Skill

### Plex API Client (`src/skills/plex/skill.ts`)
- [ ] Implement Plex API client using native `fetch` against Plex REST API
- [ ] Connect using Plex token (LAN-only, no Plex relay)
- [ ] Constrain to playback control — no library modification, no server settings

### Tools
- [ ] Tool: `plex_search`
  - Input: `query` (string), `mediaType` (optional: "movie", "show", "music", "all")
  - Output: matching items with title, year, rating, summary snippet
- [ ] Tool: `plex_play`
  - Input: `query` (string), `device` (string, default from config e.g., "Living Room TV")
  - Output: "Now playing [title] on [device]" or error with available devices
  - Flow: search → find best match → find target client → play
- [ ] Tool: `plex_status`
  - Output: currently playing sessions (who, what, where), connected clients
- [ ] Tool: `plex_recently_added`
  - Input: `days` (number, default 7), `mediaType` (optional)
  - Output: recently added content
- [ ] Tool: `plex_suggest`
  - Input: `mood` or `genre` (string), `mediaType` (optional)
  - Output: suggestion from unwatched library items matching criteria
  - Uses Plex's library metadata (genre, rating, watched status)

### Device Management
- [ ] Maintain list of known Plex clients/players
- [ ] Default device configurable (e.g., "Living Room TV")
- [ ] If requested device not found, list available devices

---

## 3.5 Proactive Notification Pipeline

### Wiring It Together
- [ ] Event bus consumers register at startup
- [ ] Alert router subscribes to all `alert.*` events
- [ ] Discord bot exposes a `sendNotification(channelId, content)` method
- [ ] Alert router calls interface notification methods based on routing rules

### Notification Types
- [ ] **UniFi — New Client**: immediate Discord embed with MAC, hostname, AP, timestamp
- [ ] **UniFi — Bandwidth Spike**: Discord embed with client, current rate, baseline, duration
- [ ] **UniFi — Device Offline**: Discord embed with device name, last seen, affected clients
- [ ] **Email — Urgent** (from Phase 2): Discord message with sender and subject
- [ ] **Reminder — Due** (from Phase 2): Discord message with reminder title and details

### User Interaction with Alerts
- [ ] Alerts include suggested actions as hints in the message
- [ ] User can respond naturally: "Block that device" → orchestrator handles via UniFi skill
- [ ] Alerts link back to tools: "Use `unifi_client_lookup` for more details on this client"

---

## 3.6 Database Migrations

- [ ] Drizzle migration: create `known_clients` table
- [ ] Drizzle migration: create `alert_history` table (log of all alerts sent)
- [ ] Drizzle migration: create `traffic_baseline` table (optional, Redis may suffice)

---

## 3.7 Test Suite — Phase 3 Gate

All tests must pass before proceeding to Phase 4. Run with `npm run test:phase3`.

### Unit Tests

**Event Bus (`tests/unit/core/events.test.ts`)**
- [ ] `publish()` writes event to Redis Stream with correct format
- [ ] `subscribe()` registers handler and receives matching events
- [ ] Events are delivered to the correct handler based on pattern matching
- [ ] Consumer groups ensure events are processed exactly once
- [ ] Dead letter queue captures events that fail processing 3 times
- [ ] Event bus handles Redis disconnection gracefully

**Task Scheduler (`tests/unit/core/scheduler.test.ts`)**
- [ ] Registers tasks with cron expressions and executes on schedule
- [ ] `scheduler_list` returns all tasks with next run time and status
- [ ] `scheduler_toggle` enables/disables a task
- [ ] Disabled tasks do not execute
- [ ] Failed tasks retry once, then skip until next scheduled run
- [ ] Failed tasks publish `alert.system.task_failed` event
- [ ] Skills can register custom scheduled tasks at startup
- [ ] Task execution is logged with duration and success/failure

**Alert Router (`tests/unit/core/alerts.test.ts`)**
- [ ] Routes events to configured channels based on event type
- [ ] Respects quiet hours — suppresses medium/low severity during configured window
- [ ] Always delivers high severity alerts regardless of quiet hours
- [ ] Cooldown prevents duplicate alerts within configured window
- [ ] Cooldown is scoped per event type + source (not global)
- [ ] Loads routing rules from config
- [ ] Handles unknown event types gracefully (logs, does not crash)

**Alert Formatters (`tests/unit/core/alert-formatters.test.ts`)**
- [ ] Discord formatter produces embeds with correct severity colors
- [ ] Slack formatter produces valid Block Kit JSON
- [ ] Plain text fallback produces readable output
- [ ] All formatters handle missing/optional payload fields

**UniFi API Client (`tests/unit/skills/unifi/client.test.ts`)**
- [ ] Authenticates with UniFi Controller and stores session cookie
- [ ] `getClients()` returns parsed client list
- [ ] `getDevices()` returns parsed device list
- [ ] `blockClient()` sends correct API call
- [ ] Re-authenticates on 401 response
- [ ] Handles controller unreachable gracefully

**UniFi Monitor (`tests/unit/skills/unifi/monitor.test.ts`)**
- [ ] Detects new clients not in known clients list
- [ ] Does not alert for known/approved clients
- [ ] Publishes `alert.unifi.new_client` with correct payload
- [ ] Detects bandwidth spikes above threshold (mean + 3*stddev)
- [ ] Does not alert for normal traffic within baseline
- [ ] Detects AP going offline and publishes `alert.unifi.device_offline`
- [ ] Updates known clients when user approves a device

**Traffic Baseline (`tests/unit/skills/unifi/baseline.test.ts`)**
- [ ] Calculates rolling mean and stddev from traffic samples
- [ ] Correctly identifies spikes above configurable threshold
- [ ] Decays old data over time
- [ ] Returns neutral baseline during learning period (first 7 days)
- [ ] Handles clients with no traffic history

**UniFi Skill (`tests/unit/skills/unifi/skill.test.ts`)**
- [ ] `unifi_status` returns formatted network summary
- [ ] `unifi_clients` filters by wired/wireless/unknown
- [ ] `unifi_client_lookup` finds client by MAC, hostname, or IP
- [ ] `unifi_block_client` requires confirmation flag before executing

**Plex Skill (`tests/unit/skills/plex/skill.test.ts`)**
- [ ] `plex_search` returns matching media with metadata
- [ ] `plex_search` handles no results gracefully
- [ ] `plex_play` finds content and target device, initiates playback
- [ ] `plex_play` returns available devices when target not found
- [ ] `plex_status` returns current sessions or "nothing playing"
- [ ] `plex_recently_added` returns content added within N days
- [ ] `plex_suggest` returns unwatched content matching genre/mood

### Integration Tests

**Event Bus → Alert Router → Discord (`tests/integration/alert-pipeline.test.ts`)**
- [ ] Publishing an event flows through the alert router to the Discord notification method
- [ ] Quiet hours suppress notifications for medium-severity events
- [ ] High-severity events bypass quiet hours
- [ ] Cooldown prevents rapid duplicate notifications
- [ ] Multiple event types route to correct channels simultaneously

**UniFi Monitor → Event Bus (`tests/integration/unifi-monitor.test.ts`)**
- [ ] New client detection publishes event that reaches alert router
- [ ] Bandwidth spike publishes event with client details and baseline comparison
- [ ] AP offline publishes event within one polling cycle

### Test Helpers (additions to previous phases)
- [ ] `createMockUniFiController()` — mock UniFi API with configurable client/device data
- [ ] `createMockPlexServer()` — mock Plex API with configurable library and clients
- [ ] `createTestClients()` — fixture factory for UniFi client records
- [ ] `createTestTrafficSamples()` — fixture factory for baseline traffic data
- [ ] `createMockEventBus()` — in-memory event bus for testing without Redis

---

## Acceptance Criteria

1. UniFi monitor detects a new unknown device connecting and sends a Discord alert within 2 minutes
2. "What's on my network?" returns a summary of connected clients, bandwidth, and AP health
3. "Who is xx:xx:xx?" returns detailed info about a client by MAC address
4. Bandwidth spikes above 3x baseline trigger a Discord alert (respecting cooldown)
5. AP going offline triggers an immediate Discord alert
6. "Play [movie name]" starts playback on the default Plex client
7. "What's playing?" shows current Plex sessions
8. "Suggest a comedy movie" returns an unwatched comedy from the library
9. Alerts respect quiet hours for medium/low severity but always fire for high severity (security)
10. Alert cooldowns prevent notification spam (e.g., max 1 bandwidth alert per device per 5 min)
11. "List scheduled tasks" shows all registered tasks with next run time
12. "Disable the email poller" toggles a scheduled task off
13. Morning briefing data is pre-fetched by the scheduler at the configured time
14. **`npm run test:phase3` passes with 0 failures**

---

## Key Decisions for This Phase

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Scheduler | `croner` (cron library) | Lightweight, zero native deps, supports seconds precision |
| Event bus | Redis Streams | Already have Redis, reliable delivery, consumer groups |
| UniFi API | Direct REST via native `fetch` or `undici` | No good TS SDK, REST API is straightforward |
| Plex API | Direct REST via native `fetch` | Plex API is well-documented REST, no SDK needed in TS |
| Alert storage | Redis for cooldowns, Postgres for history | Fast lookups + durable audit trail |
| Baseline algorithm | Rolling mean + stddev (24h window) | Simple, effective, adaptive |
| Quiet hours | Config-driven with severity override | Flexible without being complex |

---

## Key Dependencies (additions to previous phases)

```json
{
  "dependencies": {
    "croner": "^9.0.0",
    "undici": "^7.0.0"
  }
}
```

Note: UniFi and Plex integrations use native `fetch` or `undici` — no additional SDK dependencies needed. `croner` is a lightweight cron scheduler with zero native dependencies — replaces the need for `node-cron` or system crontab.
