# Phase 5: Extended Skills — Home Assistant, Weather, 3D Printing, Browser Automation

**Timeline:** Post-MVP
**Depends on:** Phases 1-4 (stable core with event bus and alert routing)
**Goal:** Expand coda's capabilities into smart home control, environmental context, maker tool monitoring, and web-based task automation.

---

## 5.1 Home Assistant Skill

### Integration Approach
- [ ] Use Home Assistant REST API (LAN-only, long-lived access token)
- [ ] Base URL from config (e.g., `http://192.168.x.x:8123`)
- [ ] Async HTTP client via native `fetch`

### Tools
- [ ] Tool: `ha_status`
  - Output: summary of key entity states (lights, locks, climate, sensors)
  - Configurable "important entities" list — not every HA entity, just the ones you care about
- [ ] Tool: `ha_control` (`requiresConfirmation: true` for security entities)
  - Input: `entityId` (string), `action` (string: "turn_on", "turn_off", "toggle", "set"), `attributes` (object, optional — e.g., brightness, temperature)
  - Output: confirmation of state change
  - Lock/unlock and security-related entities use confirmation token flow; lights and non-security entities execute directly
- [ ] Tool: `ha_query`
  - Input: `query` (natural language — "What's the temperature in the bedroom?")
  - Implementation: map natural language to entity lookups via HA's entity registry
  - Output: current state of matched entities
- [ ] Tool: `ha_scene`
  - Input: `sceneName` (string)
  - Output: confirmation of scene activation
  - Useful for "movie time" (dims lights, closes blinds) or "bedtime" routines

### Entity Mapping
- [ ] Maintain a friendly-name → entity_id mapping in config:
  ```yaml
  home_assistant:
    entities:
      "living room lights": "light.living_room_main"
      "front door": "lock.front_door"
      "thermostat": "climate.main_floor"
      "bedroom temperature": "sensor.bedroom_temp"
  ```
- [ ] LLM uses friendly names; skill resolves to entity IDs
- [ ] Fallback: fuzzy match against HA entity registry if no config mapping exists

### Proactive Alerts
- [ ] Subscribe to HA event stream (WebSocket API) for real-time state changes
- [ ] Alert rules (configurable):
  - Door/window opened during away mode
  - Temperature above/below thresholds
  - Motion detected during unexpected hours
  - Smoke/CO detector triggered (always alert, ignore quiet hours)
- [ ] Publish to event bus as `alert.ha.*` events

---

## 5.2 Weather Skill

### Integration Approach
- [ ] Use Open-Meteo API (free, no API key required)
- [ ] Location from config (latitude/longitude)
- [ ] Cache weather data in Redis (30-minute TTL)

### Tools
- [ ] Tool: `weather_current`
  - Output: current temperature, conditions, humidity, wind, UV index
- [ ] Tool: `weather_forecast`
  - Input: `days` (number, default 3)
  - Output: daily forecast with high/low temps, precipitation chance, conditions
- [ ] Tool: `weather_alerts`
  - Output: active weather alerts/warnings for configured location

### Briefing Integration
- [ ] Include current weather + today's forecast in morning briefing
- [ ] Contextual notes: "Bring an umbrella — 80% chance of rain this afternoon"
- [ ] Proactive alert for severe weather warnings (published to event bus)

### Calendar-Aware Context
- [ ] If a calendar event has a different location, offer weather for that location
- [ ] "You have a meeting downtown at 2pm — it'll be 45F and rainy there"

---

## 5.3 3D Print Monitor Skill

### Integration Approach
- [ ] Support OctoPrint REST API (primary) and Klipper/Moonraker API (alternative)
- [ ] LAN-only access, API key authentication
- [ ] Configurable poll interval (default: 30 seconds during active print, 5 minutes idle)

### Tools
- [ ] Tool: `print_status`
  - Output: current print job status — file name, progress %, time elapsed, time remaining, temps (bed/nozzle)
  - If idle: "No active print job. Printer is idle."
- [ ] Tool: `print_history`
  - Input: `limit` (number, default 5)
  - Output: recent print jobs with status (completed/failed/cancelled), duration, filename
- [ ] Tool: `print_cancel` (`requiresConfirmation: true`)
  - Input: none (cancels current job)
  - Output: confirmation
  - Uses confirmation token flow
- [ ] Tool: `print_webcam`
  - Output: snapshot URL from OctoPrint webcam (if configured)
  - Discord: embed the image directly

### Proactive Alerts
- [ ] `alert.print.completed` — print job finished successfully
- [ ] `alert.print.failed` — print job failed (thermal runaway, disconnect, error state)
- [ ] `alert.print.progress` — configurable milestone notifications (25%, 50%, 75%)
- [ ] Respect quiet hours for progress alerts, but always alert on failures (thermal safety)

### Adaptive Polling
- [ ] Poll frequently during active prints (30s)
- [ ] Poll infrequently when idle (5min)
- [ ] Stop polling entirely if printer is powered off / unreachable (check every 15min)

---

## 5.4 Browser Automation Skill

### Why TypeScript Makes This Natural
This is where the TypeScript stack choice pays off. Playwright is a first-class Node.js library — no bindings or shims. It can run in a dedicated Node worker process while staying in the same TypeScript/JS ecosystem as the rest of coda.

### Integration Approach
- [ ] Use Playwright (`playwright`) for headless browser automation
- [ ] Chromium-only (no need for Firefox/WebKit for personal use)
- [ ] Browser instance managed as a long-lived resource (launched on skill startup, reused across calls)
- [ ] Dedicated browser profile directory for persistent logins/cookies

### Tools
- [ ] Tool: `browser_navigate`
  - Input: `url` (string)
  - Output: page title, final URL (after redirects), status code
- [ ] Tool: `browser_screenshot`
  - Input: `url` (string, optional — uses current page if omitted), `fullPage` (boolean, default false)
  - Output: screenshot image (Discord embed or file attachment)
  - Use case: "Screenshot my Grafana dashboard", "What does [site] look like right now?"
- [ ] Tool: `browser_extract`
  - Input: `url` (string), `selector` (string, optional), `prompt` (string — what to extract)
  - Output: extracted text/data from the page
  - Implementation: navigate to URL, get page content, optionally scope to CSS selector, use LLM to extract requested info
  - Use case: "What's the current price of [product] on Amazon?", "Check if [site] is showing any maintenance notices"
- [ ] Tool: `browser_fill_form` (`requiresConfirmation: true`)
  - Input: `url` (string), `fields` (array of {selector, value}), `submitSelector` (string, optional)
  - Output: confirmation of form submission + resulting page title/URL
  - Uses confirmation token flow — user sees field summary + `confirm <token>` prompt before submission
  - Use case: automated form filling for repetitive tasks
- [ ] Tool: `browser_pdf`
  - Input: `url` (string)
  - Output: PDF file of the rendered page
  - Use case: "Save this article as a PDF"

### Security Considerations
- [ ] Browser runs in a sandboxed Chromium instance with `--no-sandbox` disabled
- [ ] No access to local filesystem from browser context
- [ ] URL allowlist/blocklist in config — prevent navigation to sensitive internal services unless explicitly permitted
- [ ] All form submissions require user confirmation
- [ ] Browser context is isolated from the coda process (no shared cookies with host)
- [ ] Rate limit browser operations (max 10 per hour by default)
- [ ] Screenshot and PDF outputs are stored temporarily, auto-cleaned after 1 hour

### Persistent Sessions (Optional)
- [ ] Support named browser contexts with persistent cookies/storage
- [ ] Use case: stay logged into Grafana, router admin, etc.
- [ ] Contexts stored in encrypted profile directories
- [ ] Explicit session management: `browser_session_create`, `browser_session_list`, `browser_session_delete`

---

## 5.5 Web Search Skill

### Integration Approach
- [ ] Primary: self-hosted SearXNG instance (privacy-respecting, no API key needed)
  - SearXNG runs as a Docker container alongside coda
  - JSON API at `http://searxng:8080/search?q=...&format=json`
- [ ] Alternative: Tavily API (purpose-built for LLM search, simple REST API)
- [ ] Configurable: which engine to use, max results per query

### Tools
- [ ] Tool: `web_search`
  - Input: `query` (string), `maxResults` (number, default 5)
  - Output: list of results with title, URL, snippet
  - Use case: "Search for the latest Node.js 22 release notes", "What is [topic]?"
- [ ] Tool: `web_search_news`
  - Input: `query` (string), `maxResults` (number, default 5)
  - Output: recent news results with title, URL, snippet, date
  - Use case: "Any news about [topic]?", "Latest [company] updates"

### Briefing Integration
- [ ] Web search can be used by the morning briefing to add contextual information
- [ ] Future: autonomous research tasks (Phase 7) will leverage web search heavily

### Security Considerations
- [ ] SearXNG instance is not exposed outside Docker network
- [ ] Search queries are logged but not stored long-term
- [ ] Results are treated as external content (sanitized before LLM sees them)

---

## 5.6 Worker Process Architecture

### Why This Matters Now
Phase 5 skills (browser automation, HA WebSocket event stream, 3D print adaptive polling) add significant long-running background processing. Running all of this in a single orchestrator process increases memory pressure and blast radius.

### Implementation
- [ ] Define a `SkillWorker` interface for skills that need dedicated background processing:
  - Long-lived connections (HA WebSocket, OctoPrint polling)
  - Heavy resource usage (Playwright browser instances)
  - Skills declare `runsInWorker: true` in their manifest
- [ ] Worker skills run in separate Node.js child processes via `child_process.fork()`:
  - Communicate with the orchestrator via a message channel
  - Tool calls are dispatched to the worker process, results returned to orchestrator
  - Worker crash does not take down the orchestrator
  - `worker_threads` are not used for isolation-critical skills (shared-process model is weaker for fault/resource isolation)
- [ ] Per-skill resource limits:
  - Memory ceiling per worker (configurable, e.g., 512MB for browser skill) enforced with process-level controls (`execArgv --max-old-space-size`) plus container/cgroup limits
  - Concurrency limit per skill (e.g., max 3 concurrent browser operations)
  - Circuit breaker: if worker crashes repeatedly, disable skill and alert
- [ ] Skills that don't declare `runsInWorker` continue to run in-process (no change for simple skills)

---

## 5.7 Database Migrations

- [ ] Drizzle migration: `ha_entity_mapping` table (optional, may use config file instead)
- [ ] Drizzle migration: `browser_sessions` table for persistent browser contexts

---

## 5.8 Test Suite — Phase 5 Gate

Gate-tier tests must pass before proceeding to Phase 6. Run with `npm run test:phase5`.
- Gate: deterministic unit + integration tests (no live network dependency)
- Advisory: live-provider contract checks (non-blocking)
- Nightly: full end-to-end against real external services

### Unit Tests

**Home Assistant Skill (`tests/unit/skills/ha/skill.test.ts`)**
- [ ] `ha_status` returns formatted summary of configured entities
- [ ] `ha_control` sends correct service call to HA API
- [ ] `ha_control` requires confirmation for security entities (locks, alarms)
- [ ] `ha_query` resolves friendly names to entity IDs
- [ ] `ha_query` uses fuzzy matching when no exact config mapping exists
- [ ] `ha_scene` activates the correct scene
- [ ] Handles HA API unreachable gracefully

**Weather Skill (`tests/unit/skills/weather/skill.test.ts`)**
- [ ] `weather_current` returns formatted current conditions
- [ ] `weather_forecast` returns N-day forecast grouped by date
- [ ] `weather_alerts` returns active warnings or "no alerts"
- [ ] Weather data is cached in Redis with 30-min TTL
- [ ] Stale cache serves last-known data when API is unreachable

**3D Print Monitor (`tests/unit/skills/print/skill.test.ts`)**
- [ ] `print_status` returns progress during active print
- [ ] `print_status` returns idle message when no print is active
- [ ] `print_history` returns recent jobs with correct status
- [ ] `print_cancel` requires confirmation flag before executing
- [ ] Adaptive polling switches between active (30s) and idle (5min) intervals
- [ ] Handles printer unreachable gracefully

**Browser Automation (`tests/unit/skills/browser/skill.test.ts`)**
- [ ] `browser_navigate` returns page title and final URL
- [ ] `browser_screenshot` captures and returns image data
- [ ] `browser_screenshot` with `fullPage: true` captures entire page
- [ ] `browser_extract` extracts text from page content
- [ ] `browser_extract` scopes extraction to CSS selector when provided
- [ ] `browser_fill_form` requires confirmation flag before submitting
- [ ] `browser_pdf` generates PDF from page
- [ ] URL allowlist blocks navigation to restricted URLs
- [ ] URL blocklist prevents navigation to blocked domains
- [ ] Rate limiting enforces max operations per hour
- [ ] Handles page load timeout gracefully
- [ ] Handles navigation errors (404, 500, DNS failure) gracefully

**Web Search Skill (`tests/unit/skills/search/skill.test.ts`)**
- [ ] `web_search` returns results with title, URL, and snippet
- [ ] `web_search` respects `maxResults` parameter
- [ ] `web_search_news` returns results with date metadata
- [ ] Results are sanitized as external content before returning
- [ ] Handles SearXNG unavailable gracefully (returns error message)
- [ ] Handles Tavily API unavailable gracefully (returns error message)
- [ ] Handles empty search results gracefully

**Browser Session Management (`tests/unit/skills/browser/sessions.test.ts`)**
- [ ] Creates named browser context with persistent storage
- [ ] Lists active browser sessions
- [ ] Deletes browser session and cleans up storage
- [ ] Sessions survive skill restart (persisted to disk)

**Worker Process (`tests/unit/core/worker.test.ts`)**
- [ ] Skill with `runsInWorker: true` is launched in a separate process
- [ ] Isolation-critical skills use `child_process.fork()` (not `worker_threads`)
- [ ] Tool calls are dispatched to worker and results returned to orchestrator
- [ ] Worker crash does not affect orchestrator
- [ ] Worker crash triggers circuit breaker after repeated failures
- [ ] Memory ceiling is enforced per worker via configured process/container limits
- [ ] Concurrency limit prevents exceeding max parallel operations

### Integration Tests

**HA Event Stream (`tests/integration/ha-events.test.ts`)**
- [ ] HA state change events flow through to coda event bus
- [ ] Smoke/CO alerts bypass quiet hours
- [ ] Temperature threshold alerts fire correctly

**Weather + Calendar (`tests/integration/weather-calendar.test.ts`)**
- [ ] Morning briefing includes weather section
- [ ] Calendar events with locations include location-specific weather

**Print Alert Pipeline (`tests/integration/print-alerts.test.ts`)**
- [ ] Print completion publishes event that reaches Discord
- [ ] Print failure publishes high-severity alert that bypasses quiet hours
- [ ] Progress milestones publish at configured percentages

**Browser E2E (`tests/integration/browser-e2e.test.ts`)**
- [ ] Navigate to URL → screenshot → extract content (full workflow)
- [ ] Form fill with confirmation → submit → verify result page
- [ ] Persistent session retains cookies across multiple operations
- [ ] URL restriction prevents navigation to blocked URL

### Test Helpers (additions to previous phases)
- [ ] `createMockHAController()` — mock HA API with configurable entities and states
- [ ] `createMockWeatherAPI()` — mock Open-Meteo responses
- [ ] `createMockOctoPrint()` — mock OctoPrint API with configurable print state
- [ ] `createMockBrowser()` — mock Playwright browser with configurable page responses
- [ ] `createMockSearchEngine()` — mock SearXNG/Tavily API with configurable results

---

## Acceptance Criteria

1. "Turn off the living room lights" → HA executes the command, confirms state change
2. "What's the temperature?" → returns readings from configured HA sensors
3. "What's the weather?" → returns current conditions from Open-Meteo
4. Morning briefing now includes weather section
5. "How's the print going?" → returns current print progress with temps and ETA
6. Print failure triggers immediate Discord alert
7. "Screenshot my Grafana dashboard" → returns rendered screenshot in Discord
8. "Check the price of [product] on [URL]" → navigates, extracts, returns price
9. Browser form submission requires explicit user confirmation
10. Severe weather warnings trigger a proactive alert
11. "Search for Node.js 22 release notes" returns relevant web results
12. "Any news about [topic]?" returns recent news articles
13. **`npm run test:phase5` passes with 0 failures**

---

## Key Decisions for This Phase

| Decision | Choice | Rationale |
|----------|--------|-----------|
| HA integration | REST API (not HACS/custom component) | Simpler, no HA addon dependency |
| HA entity mapping | Config file + fuzzy match fallback | Explicit control, graceful fallback |
| Weather API | Open-Meteo | Free, no key, reliable, good coverage |
| Print API | OctoPrint primary, Moonraker secondary | OctoPrint is more common, Moonraker for Klipper |
| Polling strategy | Adaptive (active vs idle) | Balance responsiveness with resource usage |
| Browser engine | Playwright (Chromium) | First-class Node.js, same runtime, best automation API |
| Worker isolation model | `child_process.fork()` for worker skills | Process boundary gives stronger crash and memory isolation than `worker_threads` |
| Browser security | URL allowlist + confirmation for forms | Prevent unintended navigation/submissions |
| Web search engine | SearXNG (self-hosted) primary, Tavily fallback | Privacy-first, no API key for SearXNG, Tavily for quality |

---

## Key Dependencies (additions to previous phases)

```json
{
  "dependencies": {
    "playwright": "^1.50.0"
  }
}
```

Note: Home Assistant, Weather, OctoPrint, and SearXNG integrations use native `fetch` — no additional SDK dependencies. Playwright bundles its own Chromium and requires `npx playwright install chromium` during Docker image build. SearXNG runs as a separate Docker container in the compose stack.
