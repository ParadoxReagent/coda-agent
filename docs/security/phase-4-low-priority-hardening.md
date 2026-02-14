# Phase 4: Low-Priority Security Hardening

**Priority:** Within 2-3 months
**Findings:** 5 LOW
**Estimated effort:** 1-2 days

---

## Finding 23: No Rate Limiting on REST API

**Severity:** LOW

### Vulnerability

The REST API health endpoint has no rate limiting, allowing potential abuse or DoS.

### File

`src/interfaces/rest-api.ts`

### Fix

Add `@fastify/rate-limit`:

```bash
npm install @fastify/rate-limit
```

```typescript
import rateLimit from "@fastify/rate-limit";

// In constructor
await this.app.register(rateLimit, {
  max: 60,
  timeWindow: "1 minute",
});
```

### Files to Modify

- `src/interfaces/rest-api.ts`
- `package.json`

---

## Finding 24: No Security Headers on REST API

**Severity:** LOW

### Vulnerability

No CORS, CSP, X-Frame-Options, or other security headers on REST API responses.

### File

`src/interfaces/rest-api.ts`

### Fix

Add `@fastify/helmet`:

```bash
npm install @fastify/helmet
```

```typescript
import helmet from "@fastify/helmet";

await this.app.register(helmet, {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
    },
  },
});
```

### Files to Modify

- `src/interfaces/rest-api.ts`
- `package.json`

---

## Finding 25: Confirmation Token Entropy Could Be Higher

**Severity:** LOW

### Vulnerability

Confirmation tokens use 10 random bytes (80 bits of entropy). While adequate for the current use case (5-minute expiry, single use), 128 bits is the industry standard for security tokens.

### File

`src/utils/crypto.ts:8`

### Fix

```typescript
const bytes = randomBytes(16); // 128 bits of entropy (was 10/80 bits)
```

### Files to Modify

- `src/utils/crypto.ts`

---

## Finding 26: No Audit Log for Configuration Changes

**Severity:** LOW

### Vulnerability

Provider switching via `/model set`, DND toggling, and quiet hours changes are not logged to a persistent audit trail. If the bot's behavior changes unexpectedly, there's no way to trace back configuration changes.

### File

`src/interfaces/discord-bot.ts:282-295`

### Fix

Option A: Log to structured logger with a specific audit category:
```typescript
this.logger.info(
  { event: "config_change", userId: interaction.user.id, action: "model_set", provider, model },
  "User changed LLM provider"
);
```

Option B: Create an `audit_log` database table for persistent tracking.

### Files to Modify

- `src/interfaces/discord-bot.ts`
- Optionally `src/db/schema.ts` (new table)

---

## Finding 27: IMAP Credentials in Config File

**Severity:** LOW

### Vulnerability

IMAP username and password can be specified directly in `config.yaml`, which may be committed to version control or readable by other processes.

### File

`src/utils/config.ts:76-78`

### Fix

1. Document that IMAP credentials should use env vars (`IMAP_USER`, `IMAP_PASS`)
2. Add a startup warning if IMAP credentials appear in the YAML file rather than env vars:
   ```typescript
   if (config.email?.imap_pass && !process.env.IMAP_PASS) {
     logger.warn("IMAP password found in config file. Use IMAP_PASS env var for better security.");
   }
   ```

### Files to Modify

- `src/main.ts` (add warning)
- `config/config.example.yaml` (add documentation comment)
