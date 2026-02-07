# Security Best Practices Report (Plan Re-Review)

Date: 2026-02-07  
Scope: `/Users/michaeloneil/Github/coda-agent` planning documents (`phase-*.md`, `personal-assistant-architecture.md`, `phased-plan-evaluation.md`)

## Executive Summary

The plan set is generally security-aware and already includes strong controls (confirmation tokens, prompt-injection testing, input validation, isolation, and rate limiting).  
This re-review found **5 remaining gaps**: **1 High**, **3 Medium**, **1 Low**.  
The highest risk is the external-skill trust boundary: signatures/trusted publishers are currently optional while external code is dynamically imported.

---

## High Severity

### [H-001] External skill trust chain is optional despite dynamic code loading

- **Location:**
  - `/Users/michaeloneil/Github/coda-agent/phase-1-foundation.md:459`
  - `/Users/michaeloneil/Github/coda-agent/phase-1-foundation.md:469`
  - `/Users/michaeloneil/Github/coda-agent/phase-1-foundation.md:480`
  - `/Users/michaeloneil/Github/coda-agent/phase-1-foundation.md:489`
  - `/Users/michaeloneil/Github/coda-agent/phase-1-foundation.md:492`
  - `/Users/michaeloneil/Github/coda-agent/phase-4-hardening.md:111`
- **Evidence:** `publisher.signature` is optional, trusted publisher/signature verification is optional, and external entries are dynamically imported.
- **Impact:** A malicious or tampered external skill can execute arbitrary code in the coda runtime.
- **Fix:**
  - Make signature verification mandatory for external skills in non-dev environments.
  - Default `skills.external_dirs` to empty; require explicit opt-in per directory.
  - Restrict allowed skill sources to a pinned trust store (publisher IDs and signing keys).
  - Fail closed on missing/invalid signature (not advisory mode).
- **Mitigation if immediate change is hard:** disable external skill loading by default and enable only for manually reviewed local skills.

---

## Medium Severity

### [M-002] `scheduler_toggle` can disable monitoring workflows without confirmation controls

- **Location:**
  - `/Users/michaeloneil/Github/coda-agent/phase-3-home-integration.md:135`
  - `/Users/michaeloneil/Github/coda-agent/phase-3-home-integration.md:137`
  - `/Users/michaeloneil/Github/coda-agent/phase-3-home-integration.md:237`
- **Evidence:** `scheduler_toggle` enables/disables scheduled tasks, but no `requiresConfirmation` or equivalent privileged confirmation is defined.
- **Impact:** Prompt-injection or accidental commands can silently disable health/security tasking (monitoring blind spots).
- **Fix:**
  - Mark `scheduler_toggle` as confirmation-required.
  - Add per-task sensitivity classes (e.g., security-critical tasks require stronger confirmation).
  - Emit immutable audit events for all schedule state changes.
- **False positive notes:** if strict out-of-band authorization exists elsewhere, document it in this phase.

### [M-003] Proxmox action model conflicts with least privilege and allows unconfirmed state-changing start

- **Location:**
  - `/Users/michaeloneil/Github/coda-agent/phase-6-infrastructure-skills.md:45`
  - `/Users/michaeloneil/Github/coda-agent/phase-6-infrastructure-skills.md:57`
  - `/Users/michaeloneil/Github/coda-agent/phase-6-infrastructure-skills.md:59`
  - `/Users/michaeloneil/Github/coda-agent/phase-6-infrastructure-skills.md:155`
- **Evidence:** integration says least-privilege `PVEAuditor` token, but includes VM state-change actions; test plan explicitly allows `start` without confirmation.
- **Impact:** implementation pressure may lead to over-privileged tokens, and unconfirmed state changes can be triggered unexpectedly.
- **Fix:**
  - Split read-only and action-capable credentials.
  - Require confirmation for all state-changing VM actions (including `start`) or enforce a strict safe allowlist for no-confirm actions.
  - Limit action scope to specific VM IDs/pools.
- **False positive notes:** if `start` is intentionally exempt for operational reasons, document that risk acceptance explicitly.

### [M-004] Access JWT lifetime (30 days) is too long for bearer tokens

- **Location:**
  - `/Users/michaeloneil/Github/coda-agent/phase-7-advanced-features.md:29`
- **Evidence:** JWT bearer token is defined with 30-day expiry.
- **Impact:** token theft creates a long replay window against all authenticated API operations.
- **Fix:**
  - Use short-lived access JWTs (for example 5-15 minutes) and keep long-lived refresh tokens server-tracked and revocable.
  - Bind refresh tokens to device/session metadata and rotate on every use.
  - Add reuse-detection for refresh token rotation failures.

---

## Low Severity

### [L-005] Log redaction paths are narrow and may miss auth artifacts

- **Location:**
  - `/Users/michaeloneil/Github/coda-agent/phase-1-foundation.md:287`
  - `/Users/michaeloneil/Github/coda-agent/phase-1-foundation.md:291`
- **Evidence:** redaction list covers some common fields but does not explicitly include common auth/logging keys such as authorization headers/cookies/session IDs.
- **Impact:** sensitive credentials may leak into structured logs through unlisted key paths.
- **Fix:**
  - Extend redaction keys to include common auth/header/cookie/session patterns.
  - Add security tests that intentionally log representative payloads and assert redaction.
  - Prefer defensive key-pattern redaction for known secret-bearing namespaces.

---

## Positive Controls Already Present

- Confirmation-token flow with entropy and TTL: `/Users/michaeloneil/Github/coda-agent/phase-1-foundation.md:508`
- Prompt-injection test requirements: `/Users/michaeloneil/Github/coda-agent/phase-4-hardening.md:29`
- Tool input schema validation: `/Users/michaeloneil/Github/coda-agent/phase-4-hardening.md:32`
- External skill process isolation direction: `/Users/michaeloneil/Github/coda-agent/phase-4-hardening.md:120`
- WebSocket auth hardening + origin allowlist: `/Users/michaeloneil/Github/coda-agent/phase-7-advanced-features.md:37`

