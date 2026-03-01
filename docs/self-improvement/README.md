# Agent Self-Improvement Implementation Plan

## Objective

Extend the agent's existing capability set to allow it to:
1. Read its own weekly deficiency report from memory
2. Identify the relevant TypeScript source files responsible for each deficiency
3. Propose and apply code changes on a git branch
4. Validate changes via TypeScript compilation, unit tests, a Docker build, and a shadow container smoke test
5. Promote passing changes as a GitHub PR or report failures with full context
6. Deliver a morning summary report via webhook to n8n

This plan is intended to be parsed and executed by the agent itself. Each phase should be worked on sequentially. Where implementation decisions are required, prefer the conservative/safer option unless noted otherwise.

---

## Assumptions

- The agent is composed of multiple TypeScript Docker containers with a defined orchestration container that handles tool execution
- The agent already has a memory system and produces a weekly deficiency/reflection report stored in memory
- Git and Docker CLI are available or can be made available inside the orchestration container
- A GitHub MCP server can be added to the agent's tool registry or GitHub skill with api key
- The Docker socket can be mounted into the orchestration container with scoped restrictions
- n8n receives a webhook payload at a known internal URL for the morning report delivery
- CI/CD (e.g. CircleCI) may optionally be triggered but is not required — local build and test is preferred for overnight runs
- The agent supports spawning subagents, both hardcoded (persistent identity defined by `soul.md` and `tools.md` files) and ephemeral (spun up for a single task then torn down)

---

## Subagent Architecture for Self-Improvement

### Background

The agent's existing subagent system uses two definition files per hardcoded subagent:

- **`soul.md`** — defines the subagent's identity, personality, purpose, areas of expertise, behavioral constraints, and which LLM model it should use
- **`tools.md`** — defines which tools the subagent has access to, and any constraints on how those tools may be used

The self-improvement workflow is a good candidate for hardcoded subagents rather than ephemeral ones because the same roles recur on every overnight run. Ephemeral subagents are better suited for one-off tasks like "research this topic" or "summarize these ten documents." The structured, recurring nature of code review, test analysis, and change generation benefits from stable identities with consistent behavior across runs.

The orchestration module (Phase 3) should spawn these subagents via the existing subagent spawning interface rather than calling LLM completions directly. This keeps model routing, tool access, and behavioral constraints out of the orchestration logic and inside the subagent definitions where they belong.

---

### Recommended Hardcoded Subagents

Four hardcoded subagents are recommended for this workflow. Each needs a `soul.md` and `tools.md` created before Phase 3 implementation begins.

---

#### Subagent 1: `code-archaeologist`

**Purpose:** Reads and understands the existing codebase. Responsible for Phase 0 inventory, blast radius analysis, and providing source context to other subagents. Does not write code.

**soul.md contents should establish:**
- Identity as a careful, methodical code reader whose job is understanding, not changing
- Strong emphasis on accuracy over speed — it should never guess at what code does
- Explicit instruction that it does not propose fixes or make judgments about quality; it only maps and describes
- Instruction to always output structured JSON when summarizing file relationships or capabilities
- Model: **Haiku** — this is almost entirely read and parse work, no deep reasoning needed

**tools.md should include:**
- GitHub MCP: `get_file_contents`, `list_directory`, `search_code` (read-only operations only)
- Memory read (to check existing capability maps before re-scanning)
- Memory write (to store the capability map and blast radius results)
- No Docker tools, no shell exec, no write operations to GitHub

**Used in workflow at:** Phase 0 inventory, blast radius analysis before every run, and whenever the code-surgeon needs source context for a file it hasn't read yet.

---

#### Subagent 2: `code-surgeon`

**Purpose:** The only subagent that proposes and writes code changes. Takes a deficiency description plus source file contents from the code-archaeologist and produces a concrete, targeted diff or replacement file. Does not run tests or make judgments about whether the change worked.

**soul.md contents should establish:**
- Identity as a precise, conservative TypeScript developer
- Strong instruction to make the minimum viable change that addresses the deficiency — no refactoring, no style changes, no scope creep
- Instruction to always explain the change in a structured format: what was changed, why, and what could break
- Instruction to flag if the requested change seems too broad or risky, and suggest a narrower scope instead
- Explicit instruction that it does not self-approve its own changes — it hands off to the test-runner for validation
- Model: **Sonnet** — this is the most reasoning-intensive step in the entire workflow and warrants it

**tools.md should include:**
- GitHub MCP: `get_file_contents`, `create_branch`, `create_or_update_file` (write allowed, scoped to `agent/self-improvement/*` branches only)
- Memory read (to access the deficiency report and capability map)
- Memory write (to log the proposed change summary)
- No Docker tools, no shell exec

**Used in workflow at:** Phase 3 generate-fix step, and optionally for a second attempt if the test-runner reports a fixable compile or logic error.

---

#### Subagent 3: `test-runner`

**Purpose:** Executes the validation pipeline — compile check, unit tests, Docker build, shadow container lifecycle, and smoke tests. Reports structured pass/fail results. Does not interpret results or propose fixes.

**soul.md contents should establish:**
- Identity as a methodical QA engineer focused on objective pass/fail outcomes
- Instruction to always capture full output from failed steps, never truncate logs
- Instruction to clean up after itself — shadow containers must always be stopped and removed before the subagent exits, even on failure
- Instruction to never retry a failed step on its own — it reports failure and hands back to the orchestrator
- Model: **Haiku** — this subagent is mostly executing tools and formatting results, not reasoning

**tools.md should include:**
- Docker sandbox tool: all operations (`build`, `run`, `logs`, `stop`, `remove`, `healthcheck`), scoped to `agent-sandbox-*` only
- Shell exec tool: scoped to `tsc --noEmit`, `npm test`, and the smoke test runner only — no arbitrary commands
- Memory write (to log step results as they complete, so a crash mid-run has partial output preserved)
- GitHub MCP: read-only (to check out the branch being tested)
- No write operations to GitHub

**Used in workflow at:** The entire validation pipeline in Phase 3 (compile → unit tests → Docker build → shadow container → smoke tests).

---

#### Subagent 4: `improvement-reporter`

**Purpose:** Synthesizes the completed run into human-readable artifacts — the PR body and the morning webhook report. Runs once at the very end of a successful or failed cycle.

**soul.md contents should establish:**
- Identity as a technical writer who communicates clearly to a human developer reviewing work in the morning
- Instruction to always be honest about failures — if something failed, say clearly what failed and why, don't soften it
- Instruction to keep the morning narrative brief (3-5 sentences max) and the PR body thorough
- Instruction that it has no ability to modify code or re-run tests — its only job is documentation and reporting
- Model: **Haiku** for the morning narrative (simple templating), **Sonnet** for the PR body (needs coherent technical prose). The soul.md should specify Sonnet as the default model since PR body quality matters more, and note that Haiku can be used for the webhook narrative specifically.

**tools.md should include:**
- GitHub MCP: `create_pull_request` only
- Webhook tool: scoped to the n8n self-improvement report URL only
- Memory read (to access the full run report and deficiency description)
- No Docker tools, no shell exec, no code write operations

**Used in workflow at:** Final step of Phase 3 `finalize()`, regardless of pass/fail outcome.

---

### Subagent Interaction Flow

```
Orchestrator
  │
  ├─► code-archaeologist  (Phase 0: inventory + blast radius)
  │       └─► writes capability map and blast radius to memory
  │
  ├─► code-archaeologist  (read source files for target)
  │       └─► returns source file contents to orchestrator
  │
  ├─► code-surgeon        (generate fix)
  │       └─► reads source from memory/GitHub, writes branch + changed files
  │
  ├─► test-runner         (full validation pipeline)
  │       └─► writes step results to memory as it goes
  │
  └─► improvement-reporter (finalize)
          └─► creates PR (if pass) + sends webhook to n8n
```

The orchestrator itself holds no LLM model assignment — it is pure workflow coordination logic. All reasoning, generation, and summarization is delegated to the appropriate subagent. This keeps the orchestrator cheap to run and easy to reason about.

### Ephemeral Subagent Use

One situation warrants an ephemeral subagent: if the code-surgeon flags that a fix requires understanding a dependency or library it doesn't have context on (e.g., a third-party MCP server's API), the orchestrator can spin up an ephemeral research subagent with Tavily and Firecrawl access to pull the relevant documentation, then pass that context back to the code-surgeon before it writes the fix. This is an optional enhancement, not required for initial implementation.

---

## Phase 0: Preparation and Scoping (Agent should complete this first)

Before writing any code, the agent must:

1. **Inventory the codebase** — List all TypeScript source files grouped by module. Identify which modules map to which capabilities (memory, tool execution, query building, reflection, etc.). Output this as a JSON map stored in memory: `{ "capability": ["src/path/file.ts"] }`.

2. **Read the most recent deficiency report** — Pull the latest weekly reflection from memory. Parse it into structured deficiencies: `{ "deficiency": string, "affected_capability": string, "severity": "low|medium|high" }`. If no report exists yet, halt and log that self-improvement cannot run without a prior reflection cycle.

3. **Select a target** — Choose one deficiency to address per overnight run. Prefer `medium` severity targeting a non-critical module (avoid memory schema files, core orchestration loops, or anything that would make the agent unable to start). Store the selected target in memory as `self_improvement.current_target`.

4. **Define blast radius** — Using the capability map from step 1, identify all files that import or are imported by the target file. If the blast radius exceeds 5 files, flag this as high-risk and downgrade to a simpler target. Log the blast radius analysis.

5. **Confirm tools are available** — Verify the following are accessible before proceeding:
   - GitHub MCP (branch creation, file read/write, PR creation)
   - Docker socket tool (build, run, logs, stop) — scoped to `agent-sandbox-*` tagged images only
   - Shell exec tool (for running `tsc`, `npm test`, `docker build`)
   - Webhook tool (for morning report delivery)

---

## Phase 1: Docker Socket Tool

### Goal
Create a new tool in the agent's tool registry that wraps Docker operations needed for the self-improvement loop. This tool must be strictly scoped.

### Implementation

Create `src/tools/dockerSandbox.ts` with the following operations:

```typescript
// Allowed operations only — this tool should NEVER expose arbitrary docker commands
type DockerSandboxOperation =
  | { op: "build"; contextPath: string; tag: string }         // tag must start with "agent-sandbox-"
  | { op: "run"; tag: string; name: string; port?: number }   // name must start with "agent-sandbox-"
  | { op: "logs"; name: string }
  | { op: "stop"; name: string }
  | { op: "remove"; name: string }
  | { op: "healthcheck"; name: string; endpoint: string };    // HTTP GET against the container
```

**Constraints to enforce in the implementation:**
- `tag` must always be prefixed with `agent-sandbox-` — throw if not
- `name` must always be prefixed with `agent-sandbox-` — throw if not
- `build` must only accept a `contextPath` within the agent's working directory, not arbitrary paths
- `healthcheck` must only make requests to `localhost` or `127.0.0.1` — no external URLs
- All operations should have a configurable timeout (default: 120s for build, 30s for everything else)
- Log all operations with timestamps to the agent's standard logger

**Docker socket mounting** — Add to the orchestration container's `docker-compose.yml`:
```yaml
volumes:
  - /var/run/docker.sock:/var/run/docker.sock
```
Note: This should be considered carefully. If preferred, a Docker-in-Docker sidecar (using `docker:dind` image) is a safer alternative that fully isolates the socket. Recommend DinD for production, direct socket mount is fine for initial development.

### Tests to write
- Unit test: tag validation rejects non-prefixed tags
- Unit test: contextPath validation rejects paths outside working directory
- Integration test (optional, manual): build a trivial TypeScript hello-world image and verify run/logs/stop cycle works

---

## Phase 2: GitHub MCP Integration (or skill/integration)

### Goal
Add GitHub MCP to the agent's tool registry for branch management and PR creation.

### MCP Server
Use `@modelcontextprotocol/server-github` or equivalent. Add to the agent's MCP configuration.

Required environment variables:
```
GITHUB_TOKEN=<personal access token with repo scope>
GITHUB_REPO_OWNER=<owner>
GITHUB_REPO_NAME=<repo>
```

### Operations needed
The self-improvement workflow requires only these GitHub operations — do not expose more than necessary:

- `github_get_file_contents` — read a source file from the default branch
- `github_create_branch` — create a branch named `agent/self-improvement/<timestamp>`
- `github_create_or_update_file` — write modified file contents to the branch
- `github_create_pull_request` — open a PR from the branch to main/master
- `github_list_commits` — optional, used to verify branch was created

### Branch naming convention
All branches created by the agent must follow: `agent/self-improvement/YYYYMMDD-HHMMSS`

### PR template
The agent should use the following structure when creating PRs:

```markdown
## Agent Self-Improvement PR

**Deficiency addressed:** <description from reflection report>
**Target file(s):** <list of modified files>
**Change summary:** <Sonnet-generated explanation of what was changed and why>

## Test Results
- TypeScript compilation: PASS/FAIL
- Unit tests: PASS/FAIL/SKIPPED
- Docker build: PASS/FAIL
- Shadow container health check: PASS/FAIL
- Shadow container smoke tests: PASS/FAIL

## Blast radius
<list of files that import the modified module>

## Notes
<any caveats, things to manually verify, or known limitations of this change>
```

---

## Phase 3: Self-Improvement Orchestration Module

### Goal
Create the main orchestration module that runs overnight and coordinates all phases of the self-improvement loop.

### File
Create `src/workflows/selfImprovement.ts`

### Full workflow pseudocode

```
async function runSelfImprovementCycle():

  // --- SETUP ---
  target = memory.get("self_improvement.current_target")
  if not target: halt("No target selected. Run Phase 0 first.")
  
  report = { target, steps: [], outcome: null, timestamp: now() }

  // --- READ SOURCE ---
  sourceFiles = githubTool.getFileContents(target.files)
  report.steps.push({ step: "read_source", status: "ok", files: target.files })

  // --- GENERATE FIX ---
  // Use Sonnet for this step — complexity warrants it
  proposedChanges = sonnet.complete(prompt: buildFixPrompt(target.deficiency, sourceFiles))
  // proposedChanges should be structured as: { file: string, newContents: string }[]
  report.steps.push({ step: "generate_fix", status: "ok", summary: proposedChanges.summary })

  // --- BRANCH ---
  branchName = `agent/self-improvement/${timestamp()}`
  githubTool.createBranch(branchName)
  for change in proposedChanges.files:
    githubTool.createOrUpdateFile(branchName, change.file, change.newContents)
  report.steps.push({ step: "create_branch", status: "ok", branch: branchName })

  // --- COMPILE CHECK ---
  cloneToWorkdir(branchName)
  compileResult = shell.exec("tsc --noEmit")
  if compileResult.exitCode != 0:
    report.steps.push({ step: "compile", status: "fail", output: compileResult.stderr })
    return finalize(report, "FAIL: compile error")
  report.steps.push({ step: "compile", status: "pass" })

  // --- UNIT TESTS ---
  testResult = shell.exec("npm test")
  if testResult.exitCode != 0:
    // Use Haiku to summarize test failures cheaply
    failureSummary = haiku.complete(prompt: summarizeTestFailures(testResult.output))
    report.steps.push({ step: "unit_tests", status: "fail", summary: failureSummary })
    return finalize(report, "FAIL: unit tests")
  report.steps.push({ step: "unit_tests", status: "pass" })

  // --- DOCKER BUILD ---
  imageTag = `agent-sandbox-${timestamp()}`
  buildResult = dockerTool.build(contextPath: workdir, tag: imageTag)
  if buildResult.exitCode != 0:
    report.steps.push({ step: "docker_build", status: "fail", output: buildResult.stderr })
    return finalize(report, "FAIL: docker build")
  report.steps.push({ step: "docker_build", status: "pass" })

  // --- SHADOW CONTAINER ---
  containerName = `agent-sandbox-shadow-${timestamp()}`
  dockerTool.run(tag: imageTag, name: containerName, port: 3099)
  sleep(5s)  // give it time to start

  healthResult = dockerTool.healthcheck(containerName, "/health")
  if healthResult != 200:
    logs = dockerTool.logs(containerName)
    report.steps.push({ step: "shadow_health", status: "fail", logs: logs })
    dockerTool.stop(containerName)
    dockerTool.remove(containerName)
    return finalize(report, "FAIL: shadow container unhealthy")
  report.steps.push({ step: "shadow_health", status: "pass" })

  // --- SMOKE TESTS ---
  smokeResult = runSmokeTests(port: 3099)
  dockerTool.stop(containerName)
  dockerTool.remove(containerName)
  if smokeResult.failed > 0:
    report.steps.push({ step: "smoke_tests", status: "fail", results: smokeResult })
    return finalize(report, "FAIL: smoke tests")
  report.steps.push({ step: "smoke_tests", status: "pass" })

  // --- PROMOTE ---
  pr = githubTool.createPullRequest(
    branch: branchName,
    title: `[Agent] Fix: ${target.deficiency}`,
    body: buildPRBody(report, proposedChanges)
  )
  report.outcome = "PASS"
  report.prUrl = pr.url
  return finalize(report, "PASS")


async function finalize(report, outcome):
  report.outcome = outcome
  memory.set("self_improvement.last_run", report)
  webhookTool.send(n8nWebhookUrl, buildMorningReport(report))
```

### Subagent routing
| Step | Subagent | Model | Reason |
|------|----------|-------|--------|
| Codebase inventory | code-archaeologist | Haiku | Read and parse, no reasoning needed |
| Blast radius analysis | code-archaeologist | Haiku | File import graph traversal |
| Read source files for target | code-archaeologist | Haiku | Pure file retrieval |
| Generate fix proposal | code-surgeon | Sonnet | Complex code understanding and generation |
| Compile + unit tests + Docker + shadow | test-runner | Haiku | Tool execution and result capture |
| Write PR body | improvement-reporter | Sonnet | Coherent technical prose |
| Morning webhook narrative | improvement-reporter | Haiku | Simple templating |

The orchestration module should invoke subagents via the existing subagent spawning interface, passing context through memory keys rather than inline in the spawn call where possible. This keeps individual subagent invocations lean and avoids ballooning context window costs.

---

## Phase 4: Smoke Test Harness

### Goal
Create a minimal smoke test suite that runs against the shadow container to verify basic agent functionality without needing a full integration environment.

### File
Create `src/workflows/smokeTests.ts`

### Tests to implement
These should be lightweight HTTP calls against the shadow container's API:

1. **Startup check** — Container responds on `/health` with 200
2. **Memory read** — Agent can retrieve a known test key from memory (seed a test fixture)
3. **Tool registry** — Agent returns a list of registered tools and the expected tools are present
4. **Basic prompt** — Send a trivial prompt and verify a non-error response is returned within 10s
5. **Reflection read** — Agent can read the most recent deficiency report from memory

Each test should return `{ name: string, passed: boolean, durationMs: number, error?: string }`.

The harness should have a configurable timeout per test (default 10s) and a total suite timeout (default 60s). If the suite times out, all untested items are marked as `{ passed: false, error: "timeout" }`.

---

## Phase 5: Morning Report Webhook Payload

### Goal
Define the payload structure the agent sends to n8n at the end of an overnight self-improvement run.

### Payload schema

```typescript
interface SelfImprovementReport {
  runDate: string;                  // ISO timestamp
  outcome: "PASS" | "FAIL" | "SKIPPED";
  deficiencyAddressed: string;      // Human readable description
  targetFiles: string[];
  branchName?: string;
  prUrl?: string;
  steps: {
    step: string;
    status: "pass" | "fail" | "skipped";
    summary?: string;
    durationMs?: number;
  }[];
  narrative: string;                // Haiku-generated 2-3 sentence plain English summary
  nextSuggestedTarget?: string;     // Optional: what the agent thinks should be addressed next run
}
```

The `narrative` field should be generated by Haiku at the end of the run as a plain-English summary suitable for a morning Slack or email notification. Example: "Overnight run addressed a deficiency in query normalization. All tests passed and a PR has been opened for review. No issues with the shadow container."

---

## Phase 6: Scheduling

### Goal
Wire the self-improvement cycle into the agent's existing scheduling system so it runs automatically overnight.

### Implementation notes
- The cycle should be triggered on a cron schedule, e.g. `0 2 * * *` (2am daily, or weekly on Sunday night — your preference)
- It should only run if a deficiency report exists in memory from the current week's reflection cycle
- It should not run if a previous self-improvement run is already in progress (check a mutex/lock in memory)
- Maximum single run duration: 45 minutes. If exceeded, halt all subprocesses, clean up the shadow container if running, and send a "timed out" report via webhook

---

## Phase 7: Guardrails and Safety Configuration

The following should be configurable via environment variables so they can be adjusted without code changes:

```
SELF_IMPROVEMENT_ENABLED=true              # Master kill switch
SELF_IMPROVEMENT_MAX_FILES=3               # Max files modified per run
SELF_IMPROVEMENT_BLAST_RADIUS_LIMIT=5      # Halt if more than N files are in the import chain
SELF_IMPROVEMENT_MAX_ITERATIONS=1          # How many fix attempts per run (recommend 1 to start)
SELF_IMPROVEMENT_ALLOWED_PATHS=src/tools,src/workflows  # Comma-separated list of allowed directories
SELF_IMPROVEMENT_FORBIDDEN_PATHS=src/memory,src/core    # These files are never touched
SELF_IMPROVEMENT_AUTO_MERGE=false          # Never auto-merge to main — always require human review
SELF_IMPROVEMENT_SHADOW_PORT=3099          # Port for the shadow container
SELF_IMPROVEMENT_WEBHOOK_URL=http://n8n:5678/webhook/self-improvement-report
```

---

## Implementation Order

Work through phases in this order:

1. **Subagent definitions** — Create `soul.md` and `tools.md` for all four subagents before any code is written. The orchestration module depends on them existing.
2. **Phase 0** — Inventory and target selection (use the code-archaeologist subagent once it's defined)
3. **Phase 2** — GitHub MCP (required before any branch work)
4. **Phase 1** — Docker sandbox tool (required before shadow testing)
5. **Phase 4** — Smoke test harness (write this before the orchestrator so tests exist to call)
6. **Phase 3** — Orchestration module (ties everything together, delegates to subagents)
7. **Phase 5** — Morning report payload (finalize schema alongside Phase 3)
8. **Phase 6** — Scheduling integration
9. **Phase 7** — Guardrails config (can be woven in during Phase 3 but formalize last)

---

## Open Questions for the Agent to Resolve Before Starting

1. What is the path to the agent's working directory inside the orchestration container? This is needed for the Docker build context.
2. Does a `/health` endpoint already exist on the agent's HTTP interface? If not, it needs to be added as a prerequisite.
3. What test runner is currently used (`jest`, `vitest`, etc.)? The `npm test` command in Phase 3 assumes one exists.
4. Is there an existing tool registry pattern to follow when adding the `dockerSandbox` tool?
5. Should DinD (Docker-in-Docker) be used instead of direct socket mount? Recommended yes for safety, but requires adding a DinD sidecar service to docker-compose.
6. What is the n8n webhook URL for receiving the morning report?
7. What is the exact interface for spawning a hardcoded subagent — what parameters does it accept, and how does the orchestrator receive the subagent's output?
8. Where do subagent definition files (`soul.md`, `tools.md`) live in the repo? What naming convention do existing hardcoded subagents use for their directories?
9. Does the existing subagent spawning system support passing a memory key as context, or does it require inline context in the spawn call?

The agent should answer questions 7–9 by reading its own subagent spawning implementation before writing the orchestration module, to ensure the Phase 3 pseudocode is adapted to the actual interface rather than an assumed one.
