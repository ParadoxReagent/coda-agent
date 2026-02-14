# Security Audit & Phased Fix Plan — coda-agent

## Context

A comprehensive security audit of the coda-agent project evaluated against both the **OWASP Top 10 for LLM Applications (2025)** and traditional web application security risks. The audit identified 28 findings across all severity levels. Fixes are organized into 5 phased plans, each in its own file, to be tackled incrementally from most critical to least.

**Sources consulted:**
- [OWASP Top 10 for LLM Applications 2025](https://genai.owasp.org/resource/owasp-top-10-for-llm-applications-2025/)
- [OWASP Top 10 2025 Risks & Mitigations](https://www.confident-ai.com/blog/owasp-top-10-2025-for-llm-applications-risks-and-mitigation-techniques)

## Audit Summary

| Severity | Count | Phase |
|----------|-------|-------|
| CRITICAL | 4 | Phase 1 |
| HIGH | 8 | Phase 2 |
| MEDIUM | 10 | Phase 3 |
| LOW | 6 | Phases 4-5 |

## Phase Plans

| File | Description | Findings |
|------|-------------|----------|
| [phase-1-critical-fixes.md](phase-1-critical-fixes.md) | Critical vulnerabilities — immediate action | 4 CRITICAL |
| [phase-2-high-priority-fixes.md](phase-2-high-priority-fixes.md) | High-severity issues — prompt resolution | 8 HIGH |
| [phase-3-medium-priority-fixes.md](phase-3-medium-priority-fixes.md) | Medium-severity hardening | 10 MEDIUM |
| [phase-4-low-priority-hardening.md](phase-4-low-priority-hardening.md) | Low-severity best practices | 5 LOW |
| [phase-5-monitoring-and-governance.md](phase-5-monitoring-and-governance.md) | Ongoing security operations | 1 LOW + governance |

## OWASP LLM Top 10 Coverage

| OWASP ID | Name | Findings | Phases |
|----------|------|----------|--------|
| LLM01 | Prompt Injection | 3 | 1, 2, 3 |
| LLM02 | Sensitive Information Disclosure | 3 | 1, 2, 3 |
| LLM03 | Supply Chain | 2 | 2, 3 |
| LLM04 | Data Poisoning | 0 | N/A (RAG not user-writable) |
| LLM05 | Improper Output Handling | 2 | 3 |
| LLM06 | Excessive Agency | 3 | 1, 2, 3 |
| LLM07 | System Prompt Leakage | 1 | 3 |
| LLM08 | Vector and Embedding Weaknesses | 1 | 3 |
| LLM09 | Misinformation | 0 | N/A (tool-use agent) |
| LLM10 | Unbounded Consumption | 2 | 2, 3 |

## Verification Plan

After each phase:
1. Run `npm test` — all existing tests must pass
2. Add new security-specific tests for each fix
3. Manual testing of affected user flows
4. Run `npm audit` for dependency vulnerabilities

## Documentation Updates

After all phases:
- Update `integrations_readme.md` if integration behavior changes
- Update `config/config.example.yaml` with new security config sections
- Update `roadmap.md` to mark security hardening as complete
