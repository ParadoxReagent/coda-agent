# Email Skill

Check, read, search, and flag emails with automatic rules-based categorization. Supports Gmail API (OAuth2) and legacy IMAP.

## Tools

### `email_check`

Check for new emails. Returns a summary grouped by category.

| Parameter    | Type     | Required | Description                            |
|--------------|----------|----------|----------------------------------------|
| `folder`     | `string` | No       | Folder/label to check (default: INBOX) |
| `hours_back` | `number` | No       | Hours of email to check (default: 24)  |

Categories: `urgent`, `needs_response`, `informational`, `low_priority`

### `email_read`

Read a specific email by message ID or UID from the cache.

| Parameter    | Type     | Required | Description                            |
|--------------|----------|----------|----------------------------------------|
| `message_id` | `string` | No       | Gmail message ID                       |
| `uid`        | `number` | No       | IMAP UID                               |
| `folder`     | `string` | No       | Folder/label (default: INBOX)          |

Provide either `message_id` (Gmail) or `uid` (IMAP).

### `email_search`

Search cached emails by query, sender, or date range.

| Parameter    | Type     | Required | Description                            |
|--------------|----------|----------|----------------------------------------|
| `query`      | `string` | No       | Search text (matches subject and from) |
| `sender`     | `string` | No       | Filter by sender address               |
| `hours_back` | `number` | No       | Limit to last N hours (default: 24)    |

### `email_flag`

Flag or unflag an email (star, mark read/unread).

| Parameter    | Type      | Required | Description                                    |
|--------------|-----------|----------|------------------------------------------------|
| `message_id` | `string`  | No       | Gmail message ID                               |
| `uid`        | `number`  | No       | IMAP UID                                       |
| `folder`     | `string`  | No       | Folder (default: INBOX)                        |
| `flag`       | `string`  | Yes      | `"\\Flagged"`, `"\\Seen"`, or `"\\Answered"`   |
| `remove`     | `boolean` | No       | Remove the flag instead of adding (default: false) |

## Configuration

**Required.** The email skill only registers if email configuration is present. Two modes are supported:

### Gmail API with OAuth2 (Preferred)

```yaml
email:
  oauth:
    client_id: "your-client-id.apps.googleusercontent.com"
    client_secret: "your-client-secret"
    redirect_port: 3000
    scopes:
      - "https://www.googleapis.com/auth/gmail.readonly"
      - "https://www.googleapis.com/auth/gmail.modify"
  gmail_user: "your-email@gmail.com"
  labels:
    - "INBOX"
  poll_interval_seconds: 300
  categorization:
    urgent_senders:
      - "boss@company.com"
    urgent_keywords:
      - "urgent"
      - "asap"
    known_contacts:
      - "coworker@company.com"
```

Run `pnpm run setup:email-oauth` to complete the OAuth flow and store tokens.

### Legacy IMAP (Fallback)

```yaml
email:
  imap_host: "imap.gmail.com"
  imap_port: 993
  imap_user: "your-email@gmail.com"
  imap_pass: "your-app-password"
  imap_tls: true
  folders:
    - "INBOX"
  poll_interval_seconds: 300
  categorization:
    urgent_senders: []
    urgent_keywords: []
    known_contacts: []
```

### Environment Variable Overrides

| Variable                     | Description                |
|------------------------------|----------------------------|
| `GMAIL_OAUTH_CLIENT_ID`     | Gmail OAuth client ID      |
| `GMAIL_OAUTH_CLIENT_SECRET` | Gmail OAuth client secret  |
| `GMAIL_OAUTH_REDIRECT_PORT` | OAuth redirect port        |
| `GMAIL_USER`                 | Gmail user email           |
| `IMAP_HOST`                  | IMAP server hostname       |
| `IMAP_USER`                  | IMAP username              |
| `IMAP_PASS`                  | IMAP password              |

## Email Categorization

Emails are categorized automatically using rules (no LLM calls):

| Priority | Category          | Logic                                           |
|----------|-------------------|-------------------------------------------------|
| 1        | `urgent`          | Sender matches `urgent_senders` or subject/body matches `urgent_keywords` |
| 2        | `low_priority`    | Detected as mailing list (noreply, newsletter, large CC list)            |
| 3        | `needs_response`  | Sender matches `known_contacts`                 |
| 4        | `informational`   | Default for everything else                     |

## Background Behavior

The email skill polls for new emails on a configurable interval (via the task scheduler or `setInterval` fallback). Emails are cached in Redis with a 24-hour TTL.

## Events Published

| Event Type            | Severity | When                           |
|-----------------------|----------|--------------------------------|
| `alert.email.urgent`  | `high`   | An email is categorized as urgent |

## Example Conversations

```
User: "Check my email"
Assistant: [calls email_check]
  → "You have 12 emails: 1 urgent, 3 need response, 5 informational, 3 low priority."

User: "What's the urgent one about?"
Assistant: [calls email_read with the message_id]

User: "Any emails from Sarah?"
Assistant: [calls email_search with sender: "sarah"]

User: "Star that email"
Assistant: [calls email_flag with flag: "\\Flagged"]
```
