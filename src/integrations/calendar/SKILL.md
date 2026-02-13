---
name: calendar
description: "View today's schedule, upcoming events, create new events, and search your calendar via CalDAV."
---

# Calendar Skill

View today's schedule, upcoming events, create new events, and search your calendar via CalDAV.

## Tools

### `calendar_today`

Get today's calendar events. No parameters required.

### `calendar_upcoming`

Get upcoming calendar events for the next N days.

| Parameter | Type     | Required | Description                       |
|-----------|----------|----------|-----------------------------------|
| `days`    | `number` | No       | Number of days to look ahead (default: 7) |

Returns events grouped by date.

### `calendar_create`

Create a new calendar event. Automatically checks for scheduling conflicts.

| Parameter     | Type     | Required | Description                     |
|---------------|----------|----------|---------------------------------|
| `title`       | `string` | Yes      | Event title                     |
| `start_time`  | `string` | Yes      | Start time in ISO 8601 format   |
| `end_time`    | `string` | Yes      | End time in ISO 8601 format     |
| `location`    | `string` | No       | Event location                  |
| `description` | `string` | No       | Event description               |

**Requires confirmation:** This tool requires user confirmation before executing (the user must respond with `/confirm`).

### `calendar_search`

Search calendar events by keyword with optional date range.

| Parameter | Type     | Required | Description                     |
|-----------|----------|----------|---------------------------------|
| `query`   | `string` | Yes      | Search keyword                  |
| `from`    | `string` | No       | Start date (ISO 8601)           |
| `to`      | `string` | No       | End date (ISO 8601)             |

## Configuration

**Required.** The calendar skill only registers if CalDAV configuration is present.

```yaml
calendar:
  caldav_server_url: "https://caldav.example.com/dav"   # CalDAV server URL
  caldav_username: "your-username"                       # CalDAV username
  caldav_password: "your-password"                       # CalDAV password
  timezone: "America/New_York"                           # Timezone (default: America/New_York)
  default_calendar: "personal"                           # Optional: default calendar name
```

### Environment Variable Overrides

| Variable              | Description          |
|-----------------------|----------------------|
| `CALDAV_SERVER_URL`   | CalDAV server URL    |
| `CALDAV_USERNAME`     | CalDAV username      |
| `CALDAV_PASSWORD`     | CalDAV password      |

## Supported CalDAV Servers

Works with any standard CalDAV server:
- Nextcloud
- Radicale
- Baikal
- iCloud (with app-specific password)
- Google Calendar (via CalDAV)
- FastMail

## Example Conversations

```
User: "What's on my calendar today?"
Assistant: [calls calendar_today]

User: "What do I have this week?"
Assistant: [calls calendar_upcoming with days: 7]

User: "Schedule a meeting with Bob tomorrow at 2pm for 1 hour"
Assistant: [calls calendar_create with title, start_time, end_time]
  → "I'd like to create this event. There's a conflict with 'Team Standup'. /confirm to proceed."

User: "Find all meetings about the Q4 review"
Assistant: [calls calendar_search with query: "Q4 review"]
```
