# Calendar Skill

View today's schedule, upcoming events, create new events, and search your calendar via CalDAV.

## Prerequisites

- A **CalDAV server** — any standard implementation works:
  - Radicale (self-hosted, lightweight)
  - Nextcloud Calendar
  - iCloud (CalDAV-compatible)
  - Google Calendar via CalDAV bridge
  - Synology Calendar

## Configuration

Add a `calendar:` section to `config/config.yaml`:

```yaml
calendar:
  caldav_server_url: "https://caldav.example.com/dav.php"
  caldav_username: "your-username"
  caldav_password: "your-password"
  timezone: "America/New_York"    # default: America/New_York
  default_calendar: "personal"    # optional — uses first calendar if omitted
```

**Environment variable overrides:**

| Variable | Overrides |
|---|---|
| `CALDAV_SERVER_URL` | `calendar.caldav_server_url` |
| `CALDAV_USERNAME` | `calendar.caldav_username` |
| `CALDAV_PASSWORD` | `calendar.caldav_password` |

## Tools

### `calendar_today`

Get today's calendar events. Takes no parameters.

Returns all events for the current day sorted by start time.

### `calendar_upcoming`

Get upcoming calendar events for the next N days.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `days` | number | `7` | Number of days to look ahead |

Returns events grouped by date.

### `calendar_create`

Create a new calendar event. Automatically checks for conflicts with existing events.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `title` | string | yes | Event title |
| `start_time` | string | yes | Start time (ISO 8601, e.g. `2025-03-15T14:00:00`) |
| `end_time` | string | yes | End time (ISO 8601) |
| `location` | string | | Event location |
| `description` | string | | Event description |

This tool **requires user confirmation** before executing.

If the new event overlaps with existing events, the response includes a conflict warning but still creates the event.

### `calendar_search`

Search calendar events by keyword with an optional date range.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | yes | Search keyword (matches title, description) |
| `from` | string | | Start of date range (ISO 8601) |
| `to` | string | | End of date range (ISO 8601) |

## Security

All event titles and descriptions are passed through `ContentSanitizer` before being returned to the LLM, protecting against prompt injection via calendar event content.
