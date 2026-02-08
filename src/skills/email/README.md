# Email Skill

Check, read, search, and flag emails with automatic categorization.

## Prerequisites

- **Redis** — caches email metadata (24h TTL)
- **One of the following email backends:**
  - Gmail API with OAuth2 (recommended)
  - IMAP server with app password (legacy)

## Configuration

Add an `email:` section to `config/config.yaml`. You must provide **either** the OAuth config or the IMAP config.

### Gmail API with OAuth2 (recommended)

```yaml
email:
  oauth:
    client_id: "your-google-client-id.apps.googleusercontent.com"
    client_secret: "your-google-client-secret"
    redirect_port: 3000          # default: 3000
    scopes:                      # defaults shown
      - "https://www.googleapis.com/auth/gmail.readonly"
      - "https://www.googleapis.com/auth/gmail.modify"
  gmail_user: "you@gmail.com"

  labels: ["INBOX"]              # Gmail labels to poll (default: ["INBOX"])
  poll_interval_seconds: 300     # default: 300 (5 minutes)

  categorization:
    urgent_senders: ["boss@company.com"]
    urgent_keywords: ["urgent", "asap", "emergency"]
    known_contacts: ["friend@example.com", "coworker@company.com"]
```

To complete OAuth setup, run:

```bash
pnpm setup:email-oauth
```

This opens a browser for Google consent and stores the refresh token in the database.

**Environment variable overrides:**

| Variable | Overrides |
|---|---|
| `GMAIL_OAUTH_CLIENT_ID` | `email.oauth.client_id` |
| `GMAIL_OAUTH_CLIENT_SECRET` | `email.oauth.client_secret` |
| `GMAIL_OAUTH_REDIRECT_PORT` | `email.oauth.redirect_port` |
| `GMAIL_USER` | `email.gmail_user` |

### Legacy IMAP

```yaml
email:
  imap_host: "imap.example.com"
  imap_port: 993                 # default: 993
  imap_user: "you@example.com"
  imap_pass: "your-app-password"
  imap_tls: true                 # default: true

  folders: ["INBOX"]             # IMAP folders to poll (default: ["INBOX"])
  poll_interval_seconds: 300

  categorization:
    urgent_senders: []
    urgent_keywords: []
    known_contacts: []
```

**Environment variable overrides:**

| Variable | Overrides |
|---|---|
| `IMAP_HOST` | `email.imap_host` |
| `IMAP_USER` | `email.imap_user` |
| `IMAP_PASS` | `email.imap_pass` |

## Email Categorization

Emails are automatically sorted into four categories using a fast rules-based pass (no LLM calls):

| Category | Rule |
|---|---|
| `urgent` | Sender matches `urgent_senders` or subject/snippet matches `urgent_keywords` |
| `needs_response` | Direct email (not CC/BCC) from a `known_contacts` address |
| `low_priority` | Detected as a mailing list (List-Unsubscribe header, etc.) |
| `informational` | Everything else |

## Tools

### `email_check`

Check for new emails. Returns a summary grouped by category.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `folder` | string | `"INBOX"` | Folder or label to check |
| `hours_back` | number | `24` | How far back to look |

### `email_read`

Read a specific email by ID from the cache.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `message_id` | string | | Gmail message ID |
| `uid` | number | | IMAP UID (legacy) |
| `folder` | string | | Folder/label (default: INBOX) |

Provide either `message_id` (Gmail) or `uid` (IMAP).

### `email_search`

Search cached emails by query, sender, or date range.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `query` | string | | Text to match against subject and sender |
| `sender` | string | | Filter by sender address |
| `hours_back` | number | `24` | Limit search window |

### `email_flag`

Flag or unflag an email (star, mark read/unread).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `message_id` | string | | Gmail message ID |
| `uid` | number | | IMAP UID (legacy) |
| `folder` | string | | Folder (default: INBOX) |
| `flag` | string | yes | One of: `\Flagged`, `\Seen`, `\Answered` |
| `remove` | boolean | | If `true`, remove the flag instead of adding it |

## Background Polling

The skill polls for new emails on a configurable interval. If the scheduler skill is active, polling is registered as a cron task (`email.poll`) and can be managed via `/scheduler`. Otherwise, it falls back to a `setInterval` loop.

Urgent emails trigger alert events (`alert.email.urgent`) that are routed through the alert pipeline to Discord/Slack.
