# Phase 2: MVP Skills — Email, Calendar, Reminders

> **Note:** Email, calendar, and n8n have been moved from `src/skills/` to `src/integrations/` and their tests from `tests/unit/skills/` to `tests/unit/integrations/`. Paths in this document reflect the original plan.

**Timeline:** Week 2
**Depends on:** Phase 1 (Foundation & Core Engine)
**Goal:** Deliver the three most universally useful personal assistant skills and wire up the morning briefing workflow.

---

## 2.1 Email Skill

### IMAP Poller (`src/skills/email/poller.ts`)
- [ ] Implement background IMAP polling task:
  - Connect via `imapflow` with OAuth2 (Gmail/O365) or app password
  - Poll INBOX on configurable interval (default: 5 minutes)
  - Fetch unread messages: sender, subject, date, snippet (first 500 chars)
  - Cache message metadata + snippets in Redis (keyed by message UID, 24h TTL)
  - Track last-seen UID to avoid reprocessing
- [ ] Support multiple IMAP folders (configurable)
- [ ] Connection resilience: retry with exponential backoff on IMAP disconnects
- [ ] Poller ownership rule:
  - Phase 2: this interval poller is the single active owner
  - Phase 3+: when `scheduler.tasks.email_poll` is enabled, disable local interval polling to avoid duplicate runs

### Email Categorizer (`src/skills/email/categorizer.ts`)
- [ ] Categorize emails into buckets:
  - **Urgent** — matches sender allowlist or keyword rules
  - **Needs Response** — direct emails (not CC/BCC), from known contacts
  - **Informational** — newsletters, notifications, automated alerts
  - **Spam/Low Priority** — marketing, social media notifications
- [ ] Rules-based first pass (fast, no LLM call):
  - Sender allowlist/blocklist
  - Subject keyword matching
  - Mailing list header detection
- [ ] Optional LLM-based classification for ambiguous emails (batched, not per-email)

### Email Skill Implementation (`src/skills/email/skill.ts`)
- [ ] Tool: `email_check`
  - Input: `hours_back` (number, default 24), `folder` (string, default "INBOX")
  - Output: categorized summary — count per category, top items with sender + subject
- [ ] Tool: `email_read`
  - Input: `email_id` (string) — the UID from `email_check` results
  - Output: full email body (sanitized through `ContentSanitizer`)
- [ ] Tool: `email_search`
  - Input: `query` (string), `sender` (string, optional), `dateFrom`/`dateTo` (optional)
  - Output: matching emails with metadata
- [ ] Tool: `email_flag`
  - Input: `email_id` (string), `flag` (string: "starred" | "important" | "followup")
  - Output: confirmation

### Proactive Email Alerts
- [ ] Publish `alert.email.urgent` event via `eventBus.publish()` when urgent emails arrive during polling
- [ ] Default payload is minimized: sender + subject + message UID (no body snippet)
- [ ] Optional `includeSnippetInAlerts` config (default `false`) enables a sanitized/truncated snippet for trusted channels only
- [ ] Phase 1's in-process `EventBus` routes events to a simple Discord DM handler
- [ ] Phase 3 replaces the backend with Redis Streams — no changes needed in email skill code

### Security Considerations
- [ ] IMAP credentials stored in encrypted config only
- [ ] All email content passed through `ContentSanitizer.sanitizeEmail()` before LLM sees it
- [ ] OAuth2 refresh token rotation for Gmail/O365
- [ ] Alert payload redaction policy enforced so sensitive email content is not broadcast by default

---

## 2.2 Calendar Skill

### Calendar Integration (`src/skills/calendar/skill.ts`)
- [ ] Support CalDAV as primary protocol (works with Nextcloud, Radicale, iCloud, Google)
- [ ] Use `tsdav` library for CalDAV read/write operations
- [ ] Alternative: Google Calendar API via `googleapis` if CalDAV isn't viable

### Tools
- [ ] Tool: `calendar_today`
  - Input: `timezone` (string, optional — default from user config)
  - Output: today's events with time, title, location, attendees
- [ ] Tool: `calendar_upcoming`
  - Input: `days` (number, default 7)
  - Output: events for the next N days, grouped by date
- [ ] Tool: `calendar_create` (`requiresConfirmation: true`)
  - Input: `title`, `startTime`, `endTime`, `location` (optional), `description` (optional)
  - Output: confirmation with event details
  - Uses the Phase 1 confirmation token flow — user sees event preview + `confirm <token>` prompt
- [ ] Tool: `calendar_search`
  - Input: `query` (string), `dateFrom`/`dateTo` (optional)
  - Output: matching events

### Conflict Detection
- [ ] When creating events, check for overlapping events and warn
- [ ] Include conflict info in `calendar_today` output if any exist

---

## 2.3 Reminder Skill

### Data Model
- [ ] Drizzle schema — `reminders` table:
  - `id` (UUID), `userId`, `title`, `description` (optional)
  - `dueAt` (timestamp with TZ, nullable for "no deadline" reminders)
  - `recurring` (cron expression, nullable)
  - `status` (pending, snoozed, completed, cancelled)
  - `createdAt`, `completedAt`, `snoozedUntil`
  - `channel` (where it was created — for delivery preference)

### Reminder Skill Implementation (`src/skills/reminders/skill.ts`)
- [ ] Tool: `reminder_create`
  - Input: `title`, `dueAt` (natural language → parsed to timestamp), `recurring` (optional)
  - Output: confirmation with reminder details and parsed time
  - Natural language time parsing: "tomorrow at 3pm", "in 2 hours", "every Monday at 9am"
- [ ] Tool: `reminder_list`
  - Input: `status` (optional filter: "pending", "snoozed", "all"), `limit` (default 10)
  - Output: active reminders sorted by due date
- [ ] Tool: `reminder_complete`
  - Input: `reminderId`
  - Output: confirmation
- [ ] Tool: `reminder_snooze`
  - Input: `reminderId`, `snoozeUntil` (natural language time)
  - Output: confirmation with new due time

### Background Reminder Checker
- [ ] Background task checking for due reminders every 60 seconds
- [ ] Publish `alert.reminder.due` event via `eventBus.publish()` when a reminder crosses its due time
- [ ] For recurring reminders, auto-create next occurrence on completion
- [ ] Snooze: update `snoozedUntil`, suppress alerts until then
- [ ] Checker ownership rule:
  - Phase 2: interval checker is active
  - Phase 3+: scheduler-owned `reminders.check` becomes the only active checker

### Natural Language Time Parsing
- [ ] Use `chrono-node` for natural language date/time parsing:
  - Relative: "in 30 minutes", "in 2 hours", "tomorrow", "next week"
  - Absolute: "at 3pm", "on Friday at noon", "March 15 at 10am"
  - Recurring: "every day at 9am", "every Monday", "every 2 weeks"
- [ ] Always confirm parsed time back to the user

---

## 2.4 Notes & Knowledge Base Skill

### Data Model
- [ ] Drizzle schema — `notes` table:
  - `id` (UUID), `userId`, `title` (optional), `content` (text)
  - `tags` (text array)
  - `createdAt`, `updatedAt`
- [ ] Full-text search index on `content` and `title` columns (Postgres `tsvector`)

### Notes Skill Implementation (`src/skills/notes/skill.ts`)
- [ ] Tool: `note_save`
  - Input: `content` (string), `title` (optional), `tags` (string array, optional)
  - Output: confirmation with note ID and tags
  - Use case: "Remember that my AWS account ID is 123456789", "Save this: [info]"
- [ ] Tool: `note_search`
  - Input: `query` (string), `tags` (string array, optional)
  - Output: matching notes ranked by relevance
  - Uses Postgres full-text search
- [ ] Tool: `note_list`
  - Input: `tags` (string array, optional), `limit` (number, default 10)
  - Output: recent notes, optionally filtered by tag
- [ ] Tool: `note_delete`
  - Input: `noteId` (string)
  - Output: confirmation

### Context Integration
- [ ] Orchestrator can optionally fetch relevant notes based on conversation topic
- [ ] Notes tagged with `context:always` are included in every system prompt
- [ ] Keeps coda's "memory" persistent across conversations without bloating conversation history

---

## 2.5 Morning Briefing

### Briefing Command
- [ ] Trigger: user sends "morning", "briefing", "good morning", or `/briefing`
- [ ] Orchestrator recognizes this as a briefing request (via system prompt instruction)
- [ ] LLM calls multiple tools in sequence:
  1. `email_check` — unread email summary
  2. `calendar_today` — today's agenda
  3. `reminder_list` — due/overdue reminders
- [ ] LLM composes a natural briefing from the results
- [ ] Format for Discord: use embeds or clean markdown sections

### Auto-Prepared Briefing
- [ ] Background task runs at configurable time (e.g., 6 AM) or on first activity:
  - Pre-fetch email summary, calendar, and reminders
  - Cache the prepared briefing in Redis (1h TTL)
- [ ] On first message of the day from the user, the orchestrator includes the cached briefing context in the system prompt
- [ ] The LLM can proactively offer the briefing: "Good morning! Want your daily rundown?"

---

## 2.6 Database Migrations

- [ ] Drizzle migration: create `reminders` table
- [ ] Drizzle migration: add indexes on `reminders(userId, status, dueAt)`
- [ ] Drizzle migration: create `notes` table with full-text search index
- [ ] Drizzle migration: add indexes on `notes(userId, tags)`
- [ ] Drizzle migration: add `email_cache` table for persistent email metadata (optional, Redis may suffice)

---

## 2.7 Test Suite — Phase 2 Gate

Gate-tier tests must pass before proceeding to Phase 3. Run with `npm run test:phase2`.
- Gate: deterministic unit + integration tests (no live network dependency)
- Advisory: live-provider contract checks (non-blocking)
- Nightly: full end-to-end against real external services

### Unit Tests

**Email Poller (`tests/unit/skills/email/poller.test.ts`)**
- [ ] Connects to IMAP with configured credentials
- [ ] Fetches unread messages and caches metadata in Redis
- [ ] Tracks last-seen UID and skips already-processed messages
- [ ] Retries on connection failure with exponential backoff
- [ ] Handles empty inbox gracefully

**Email Categorizer (`tests/unit/skills/email/categorizer.test.ts`)**
- [ ] Categorizes emails matching sender allowlist as "urgent"
- [ ] Categorizes direct emails from known contacts as "needs_response"
- [ ] Categorizes mailing list emails as "informational"
- [ ] Categorizes marketing emails as "low_priority"
- [ ] Handles emails that match no rules (default category)
- [ ] Handles missing/malformed headers gracefully

**Email Skill (`tests/unit/skills/email/skill.test.ts`)**
- [ ] `email_check` returns categorized summary for given time range
- [ ] `email_read` returns sanitized email body for valid UID
- [ ] `email_read` returns error for invalid/missing UID
- [ ] `email_search` filters by sender, date range, and query text
- [ ] `email_flag` sets the correct IMAP flag

**Notes Skill (`tests/unit/skills/notes/skill.test.ts`)**
- [ ] `note_save` creates note with content and tags in Postgres
- [ ] `note_save` auto-generates title from content if not provided
- [ ] `note_search` returns matching notes ranked by relevance
- [ ] `note_search` filters by tags when provided
- [ ] `note_search` returns empty result for no matches
- [ ] `note_list` returns recent notes sorted by creation date
- [ ] `note_list` filters by tags when provided
- [ ] `note_delete` removes note and returns confirmation
- [ ] `note_delete` returns error for non-existent note ID
- [ ] Notes tagged `context:always` are retrievable via special query

**Calendar Skill (`tests/unit/skills/calendar/skill.test.ts`)**
- [ ] `calendar_today` returns events for current day in configured timezone
- [ ] `calendar_upcoming` returns events grouped by date for N days
- [ ] `calendar_create` validates required fields and returns confirmation
- [ ] `calendar_create` detects overlapping events and includes conflict warning
- [ ] `calendar_search` filters events by keyword and date range
- [ ] Handles empty calendar gracefully

**Reminder Skill (`tests/unit/skills/reminders/skill.test.ts`)**
- [ ] `reminder_create` parses natural language time and stores in Postgres
- [ ] `reminder_create` handles relative times ("in 2 hours") correctly
- [ ] `reminder_create` handles absolute times ("Friday at 3pm") correctly
- [ ] `reminder_create` handles recurring patterns ("every Monday at 9am")
- [ ] `reminder_list` returns reminders sorted by due date
- [ ] `reminder_list` filters by status
- [ ] `reminder_complete` marks reminder as completed with timestamp
- [ ] `reminder_snooze` updates snooze time and suppresses alerts
- [ ] Background checker publishes event for due reminders
- [ ] Recurring reminder creates next occurrence on completion

**Natural Language Time Parser (`tests/unit/skills/reminders/time-parser.test.ts`)**
- [ ] Parses "in 30 minutes" relative to current time
- [ ] Parses "tomorrow at 3pm"
- [ ] Parses "next Monday"
- [ ] Parses "March 15 at 10am"
- [ ] Returns null/error for unparseable input
- [ ] Respects configured timezone

### Integration Tests

**Morning Briefing (`tests/integration/briefing.test.ts`)**
- [ ] Briefing trigger words invoke email, calendar, and reminder tools
- [ ] Briefing gracefully handles one skill being unavailable
- [ ] Auto-prepared briefing is cached in Redis and served on first message
- [ ] Cached briefing expires after TTL

**Email Alert Pipeline (`tests/integration/email-alerts.test.ts`)**
- [ ] Urgent email during polling publishes `alert.email.urgent` event
- [ ] Default alert payload contains sender + subject + UID (no snippet/body content)
- [ ] Optional snippet mode emits sanitized/truncated snippet only when explicitly enabled
- [ ] Non-urgent emails do not trigger alerts

**Notes Context Integration (`tests/integration/notes-context.test.ts`)**
- [ ] Saved notes are searchable and returned in subsequent queries
- [ ] Notes tagged `context:always` are included in orchestrator system prompt
- [ ] "Remember that..." saves a note and confirms

### Test Helpers (additions to Phase 1 helpers)
- [ ] `createMockIMAPClient()` — mock IMAP connection with configurable mailbox
- [ ] `createMockCalDAVClient()` — mock CalDAV client with configurable events
- [ ] `createTestEmails()` — fixture factory for email messages
- [ ] `createTestEvents()` — fixture factory for calendar events
- [ ] `createTestReminders()` — fixture factory for reminder records
- [ ] `createTestNotes()` — fixture factory for note records

---

## Acceptance Criteria

1. "What emails do I have?" returns a categorized summary of recent unread emails
2. "Read the email from [sender]" returns the full sanitized email body
3. "What's on my calendar today?" returns today's events
4. "Create a meeting with [name] tomorrow at 2pm" creates a calendar event (after confirmation)
5. "Remind me to [task] in 2 hours" creates a reminder that fires on time
6. "Show my reminders" lists active reminders with due dates
7. "Remember that my server IP is 10.0.0.5" saves a note retrievable later
8. "What was my server IP?" searches notes and returns the answer
9. Saying "morning" triggers a combined briefing covering email, calendar, and reminders
10. Urgent emails trigger a proactive Discord notification within 5 minutes of arrival
11. Due reminders trigger a Discord notification at the scheduled time
12. **`npm run test:phase2` passes with 0 failures**

---

## Key Decisions for This Phase

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Email access | IMAP via `imapflow` | Modern, promise-based, connection pooling, good TypeScript types |
| Email auth | OAuth2 primary, app password fallback | Security best practice |
| Email scope | Read-only (no SMTP/sending) | Reduces attack surface; sending can be added later |
| Calendar protocol | CalDAV via `tsdav` | TypeScript-native, protocol-level, provider-agnostic |
| Time parsing | `chrono-node` | Best-in-class NL date parser for JavaScript, actively maintained |
| Reminder storage | Postgres via Drizzle | Durable, queryable, type-safe schema |
| Notes storage | Postgres with full-text search | Durable, searchable, no extra dependency |
| Email caching | Redis (24h TTL) | Fast access, auto-expiry |

---

## Key Dependencies (additions to Phase 1)

```json
{
  "dependencies": {
    "imapflow": "^1.0.0",
    "tsdav": "^2.2.0",
    "chrono-node": "^2.7.0",
    "mailparser": "^3.7.0",
    "googleapis": "^144.0.0"
  },
  "devDependencies": {
    "@types/mailparser": "^3.4.0"
  }
}
```
