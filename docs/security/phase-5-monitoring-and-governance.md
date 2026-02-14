# Phase 5: Security Monitoring & Governance

**Priority:** Ongoing
**Findings:** 1 LOW + governance framework
**Estimated effort:** 2-3 days initial, then ongoing

---

## Finding 28: No Prompt Injection Detection

**Severity:** LOW (defense-in-depth)

### Vulnerability

There are no heuristic checks to detect prompt injection attempts in incoming content before it reaches the LLM. While the sanitizer wraps external content with warnings, no monitoring exists to detect and alert on actual injection attempts.

### Fix

### 1. Injection Detection Heuristics

Create `src/core/injection-detector.ts`:

```typescript
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /you\s+are\s+now\s+/i,
  /new\s+(system\s+)?instructions?:/i,
  /\bsystem\s*:\s*/i,
  /pretend\s+(you\s+are|to\s+be)/i,
  /override\s+(all\s+)?(rules|instructions|guidelines)/i,
  /IMPORTANT\s*:?\s*(ignore|override|forget)/i,
  /do\s+not\s+follow\s+(the\s+)?(above|previous)/i,
  /\[SYSTEM\]/i,
  /\[ADMIN\]/i,
  /jailbreak/i,
  /DAN\s+mode/i,
];

export class InjectionDetector {
  static scan(content: string): { detected: boolean; patterns: string[] } {
    const matches: string[] = [];
    for (const pattern of INJECTION_PATTERNS) {
      if (pattern.test(content)) {
        matches.push(pattern.source);
      }
    }
    return { detected: matches.length > 0, patterns: matches };
  }
}
```

Integrate into:
- `ContentSanitizer.sanitizeEmail()` — scan before wrapping
- `ContentSanitizer.sanitizeApiResponse()` — scan Firecrawl results
- Tool result processing in `orchestrator.ts` — scan tool outputs

When detected:
- Log at WARN level with event details
- Publish `alert.security.injection_attempt` event
- Optionally strip the detected content or add extra warnings to the LLM

### Files to Modify

- `src/core/injection-detector.ts` (new)
- `src/core/sanitizer.ts` (integrate detection)
- `src/core/orchestrator.ts` (scan tool results)

---

## Governance Framework

### 2. Dependency Auditing Pipeline

Add to CI/CD:

```yaml
# .github/workflows/security.yml
name: Security Audit
on:
  push:
    branches: [main]
  schedule:
    - cron: '0 6 * * 1'  # Weekly Monday 6am

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npm audit --audit-level=high
      - run: npx better-npm-audit audit
```

### 3. Security-Focused Structured Logging

Add structured security events to existing Pino logger:

```typescript
// Security event categories
const SECURITY_EVENTS = {
  TOOL_CALL: "security.tool_call",
  EXTERNAL_CONTENT: "security.external_content_ingested",
  AUTH_EVENT: "security.auth",
  INJECTION_DETECTED: "security.injection_detected",
  RATE_LIMIT_HIT: "security.rate_limit",
  ABUSE_DETECTED: "security.abuse",
  CONFIG_CHANGE: "security.config_change",
};
```

Log format:
```json
{
  "event": "security.tool_call",
  "userId": "123",
  "tool": "email_read",
  "sensitive": true,
  "externalContentPresent": true,
  "timestamp": "2025-01-15T10:30:00Z",
  "correlationId": "abc123"
}
```

### 4. Incident Response Playbook

Document procedures for:

1. **Suspected prompt injection**
   - Review recent tool call logs
   - Check for unusual data access patterns
   - Temporarily disable affected integrations
   - Rotate any potentially compromised credentials

2. **API key compromise**
   - Rotate affected keys immediately
   - Review usage logs for unauthorized access
   - Check for unexpected LLM API charges
   - Update all affected config/env vars

3. **Database breach**
   - Rotate encryption keys
   - Invalidate all OAuth tokens
   - Force re-authentication
   - Audit data access logs

4. **Malicious external skill**
   - Remove the skill directory
   - Review skill execution logs
   - Check for data exfiltration
   - Revoke any permissions the skill may have used

### 5. Regular Security Review Schedule

| Task | Frequency | Owner |
|------|-----------|-------|
| `npm audit` review | Weekly | Automated CI |
| Dependency updates | Monthly | Developer |
| Security log review | Weekly | Developer |
| Prompt injection pattern updates | Quarterly | Developer |
| Full security audit | Annually | External/Developer |
| OAuth token rotation | Quarterly | Automated task |
| Encryption key rotation | Annually | Developer |

### 6. Security Configuration Checklist

For deployment, verify:

- [ ] `ENCRYPTION_KEY` is set (32+ hex chars)
- [ ] `API_KEY` is set for REST API
- [ ] Database credentials are not defaults
- [ ] Redis has authentication enabled
- [ ] IMAP credentials are in env vars, not config file
- [ ] Discord `allowed_user_ids` is configured
- [ ] External skill policy is set to `strict` in production
- [ ] `daily_spend_hard_limit` is configured
- [ ] Server binds to `127.0.0.1` (or behind reverse proxy)
- [ ] OAuth `state` parameter validation is active
- [ ] Conversation retention policy is configured
- [ ] Firecrawl URL allowlist is configured (if applicable)
