# File Processing Pipeline: Attachment Intake + Docker Execution + File Delivery

## Context

Agent skills (like PDF) contain Python scripts and instructions that tell the LLM _how_ to process files — but coda-agent has **no code execution tool**, **no attachment intake**, and **no file delivery**. The LLM can read scripts as reference text but can't run them. This plan adds the full pipeline so agent skills become actionable, not just informational.

---

## Architecture Overview

```
User uploads file in Discord/Slack
  → Interface downloads attachment to temp dir
    → Orchestrator receives message + attachment metadata
      → LLM activates agent skill, calls `code_execute`
        → Ephemeral Docker container spins up
          → Mounts temp dir as /workspace
          → Runs command, writes output to /workspace/output/
        → Container destroyed
      → LLM receives stdout/stderr + output file paths
    → Orchestrator returns OrchestratorResponse { text, files }
  → Interface sends text + attaches files in same channel/thread
  → Temp dir cleaned up
```

---

## Implementation Steps

### Step 1: Core types — `src/core/types.ts` (new file)

Define shared types used across the pipeline:
- `InboundAttachment` — `{ name, localPath, mimeType?, sizeBytes }`
- `OutboundFile` — `{ name, path, mimeType? }`
- `OrchestratorResponse` — `{ text: string; files?: OutboundFile[] }`

### Step 2: Temp directory utility — `src/core/temp-dir.ts` (new file)

Simple utility: `TempDirManager.create(prefix)` → returns path, `TempDirManager.cleanup(path)` → removes recursively. Uses `node:fs/promises` `mkdtemp` and `rm`.

### Step 3: Orchestrator signature change — `src/core/orchestrator.ts`

- `handleMessage()` and `handleMessageInner()`: add optional `attachments?: InboundAttachment[]` param, return `Promise<OrchestratorResponse>` instead of `Promise<string>`
- When attachments present, prepend metadata to user message so LLM knows files are available and where they are
- Add `collectOutputFiles()` helper that parses tool results for `output_files` arrays (from `code_execute` JSON responses)
- Accumulate output files across all tool calls, include in final `OrchestratorResponse`
- All existing `return someString` → `return { text: someString }`

### Step 4: Discord attachment intake + file delivery — `src/interfaces/discord-bot.ts`

**Inbound:**
- In `handleMessage()`, read `message.attachments` collection
- Create per-request temp dir via `TempDirManager`
- Download each attachment via `fetch(attachment.url)`, write to temp dir
- Build `InboundAttachment[]`, pass to orchestrator
- Enforce 25 MB per-file limit (Discord default)

**Outbound:**
- Handle `OrchestratorResponse` instead of string
- When `response.files` present, use `channel.send({ content, files })` (discord.js supports `{ attachment: filePath, name }`)
- Sanitize and chunk text as before

**Cleanup:** `TempDirManager.cleanup()` in `finally` block after response sent

### Step 5: Slack attachment intake + file delivery — `src/interfaces/slack-bot.ts`

**Inbound:**
- Don't skip `subtype === "file_share"` messages
- Read `msg.files` array, download via `fetch(url_private_download)` with `Authorization: Bearer <botToken>` header
- Same temp dir pattern as Discord

**Outbound:**
- Use `app.client.files.uploadV2({ channel_id, thread_ts, file, filename })` for each output file
- Requires `files:write` OAuth scope (document this)

**Cleanup:** Same `finally` pattern

### Step 6: Execution config — `src/utils/config.ts`

New `ExecutionConfigSchema` (Zod):
```yaml
execution:
  enabled: false                    # Must be explicitly enabled
  docker_socket: /var/run/docker.sock
  default_image: python:3.12-slim
  timeout: 60                       # seconds, max 300
  max_memory: 512m
  network_enabled: false
  max_output_size: 52428800         # 50 MB
  allowed_images: [python:*, node:*, ubuntu:*, alpine:*]
```

Add to `AppConfigSchema` as optional. Add env var overrides for `EXECUTION_ENABLED` and `EXECUTION_DEFAULT_IMAGE`.

### Step 7: Config example — `config/config.example.yaml`

Add commented-out `execution:` section with all options and descriptions.

### Step 8: Docker executor skill — `src/skills/docker-executor/skill.ts` + `types.ts` (new files)

Built-in skill providing one tool: `code_execute`

**Tool input schema:**
- `command` (required) — shell command passed to `sh -c` inside container
- `image` (optional) — Docker image, validated against `allowed_images` config
- `working_dir` (optional) — path to mount as `/workspace` (contains input files)
- `timeout_seconds` (optional) — max 300
- `network` (optional) — default false

**Tool flags:** `requiresConfirmation: true`, `sensitive: true`

**Container security:**
- `docker run --rm` — ephemeral, auto-removed
- `--memory 512m --cpus 1 --pids-limit 256` — resource limits
- `--read-only --tmpfs /tmp:rw,noexec,nosuid,size=100m` — read-only root FS
- `--network none` — no network by default
- `-v workingDir:/workspace:rw` — only the temp dir is accessible
- Uses `node:child_process.execFile("docker", args)` — no shell injection

**Output:** JSON with `{ success, stdout, stderr, output_files? }`. Files in `/workspace/output/` are collected as `OutboundFile[]`.

**Error handling:** Timeout kills container via `docker kill`. Image not in allowlist is rejected before execution. Docker not installed returns clear error.

### Step 9: SKILL.md frontmatter extension — `src/skills/agent-skill-discovery.ts`

- Add optional `docker_image` and `dependencies` fields to frontmatter parsing
- Add to `AgentSkillMetadata` interface
- PDF skill frontmatter gets: `docker_image: python:3.12-slim`

### Step 10: Expose docker_image on activation — `src/skills/agent-skills/skill.ts`

When `skill_activate` returns skill info, include `docker_image` from metadata so the LLM knows which image to pass to `code_execute`.

### Step 11: Registration — `src/main.ts`

Register `DockerExecutorSkill` conditionally when `config.execution?.enabled` is true.

### Step 12: Update PDF skill frontmatter — `src/skills/agent-skills/pdf/SKILL.md`

Add `docker_image: python:3.12-slim` to YAML frontmatter.

### Step 13: Documentation updates

- `skills_readme.md` — document `code_execute` tool and Docker executor skill
- `integrations_readme.md` — note file attachment support for Discord/Slack
- `config/config.example.yaml` — already handled in step 7
- `roadmap.md` — mark relevant items done

---

## Critical Files

| File | Action |
|------|--------|
| `src/core/types.ts` | Create — shared types |
| `src/core/temp-dir.ts` | Create — temp dir utility |
| `src/core/orchestrator.ts` | Modify — signature change, attachment augmentation, output file collection |
| `src/interfaces/discord-bot.ts` | Modify — attachment download, rich response |
| `src/interfaces/slack-bot.ts` | Modify — file_share handling, files.uploadV2 |
| `src/utils/config.ts` | Modify — add ExecutionConfigSchema |
| `config/config.example.yaml` | Modify — add execution section |
| `src/skills/docker-executor/skill.ts` | Create — Docker executor skill |
| `src/skills/docker-executor/types.ts` | Create — config types |
| `src/skills/agent-skill-discovery.ts` | Modify — docker_image frontmatter |
| `src/skills/agent-skills/skill.ts` | Modify — expose docker_image on activation |
| `src/main.ts` | Modify — register Docker executor |
| `src/skills/agent-skills/pdf/SKILL.md` | Modify — add docker_image to frontmatter |

---

## Verification

1. **Unit tests:** TempDirManager, DockerExecutorSkill (mock execFile), orchestrator response type changes
2. **Integration test:** Send a message with a file attachment in Discord → verify it's downloaded → verify `code_execute` is called with correct working_dir → verify output file is sent back
3. **Manual test:** Upload a PDF in Discord, ask "merge this with [another PDF]" or "extract text from this PDF" → verify the agent activates the PDF skill, runs Python in Docker, and returns the result as a file attachment
4. **Security test:** Verify `--network none`, `--read-only`, resource limits are applied. Verify image allowlist rejects unlisted images. Verify `requiresConfirmation` prompts the user.
5. **Edge cases:** File too large, Docker not installed, container timeout, no output files produced
