# Fix: Agent still dumps code instead of calling code_execute

## Context

The previous round implemented system prompt guidance, temp dir creation, and output file propagation through BaseAgent/SubagentManager. Despite those changes, the agent still writes Python code inline when asked "create a hello world PDF". The root causes are:

1. **`skill_activate` floods context with code examples but no execution instruction** — The PDF skill's SKILL.md is a reference doc full of Python snippets. When `skill_activate` returns this content, the LLM copies/adapts the code into its response text rather than wrapping it in a `code_execute` tool call. The `skill_activate` response already includes `docker_image` metadata but nothing tells the agent to use it with `code_execute`.

2. **Sub-agent system prompt has zero code execution guidance** — When the main agent delegates to a sub-agent with `code_execute` in `tools_needed`, the sub-agent's system prompt (`subagent-manager.ts:234`) is just the safety preamble + generic worker instructions. No mention of `code_execute`, `/workspace/output/`, or "don't paste code."

3. **Working directory appended even when `code_execute` is unavailable** — The orchestrator always appends `[Working directory for code execution: /tmp/...]` to the user message, even when Docker execution is disabled. This misleads the LLM into writing code that references that path.

## Changes

### 1. Add execution instruction to `skill_activate` response (`src/skills/agent-skills/skill.ts`)

**File**: `src/skills/agent-skills/skill.ts` — `activateSkill()` method (line 102)

When the activated skill has a `docker_image` in its metadata, append an execution instruction to the response. The `AgentSkillsSkill` needs to know whether `code_execute` is available — pass this as a constructor flag or check via the skill registry.

**Approach**: Add a `hasCodeExecution: boolean` flag to `AgentSkillsSkill`'s constructor (set from `main.ts` based on `config.execution?.enabled`). Use it in `activateSkill()`:

```typescript
// In activateSkill(), add to the returned JSON:
execution_note: this.hasCodeExecution && metadata?.docker_image
  ? `IMPORTANT: Use the code_execute tool to run the code from these instructions. Use image="${metadata.docker_image}" and the working_dir from the message context. Write output files to /workspace/output/. Do NOT paste code for the user to run manually.`
  : undefined,
```

This puts the execution instruction right next to the skill content, where it has maximum influence on the LLM's behavior.

### 2. Add code execution guidance to sub-agent system prompts (`src/core/subagent-manager.ts`)

**File**: `src/core/subagent-manager.ts` — `delegateSync()` (line 232) and `executeAsyncRun()` (line 476)

After building the base system prompt, if the agent's tools include `code_execute`, append code execution guidance:

```typescript
// After line 236 (const systemPrompt = ...)
const hasCodeExecute = options.toolsNeeded.includes("code_execute");
const codeExecGuidance = hasCodeExecute
  ? `\n\nCode execution rules:\n- Use the code_execute tool to run code. NEVER paste code as text.\n- Write output files to /workspace/output/ so they are returned to the user.\n- Install dependencies inline: "pip install <pkg> && python script.py"`
  : "";
const systemPrompt = SUBAGENT_SAFETY_PREAMBLE + baseOrCustomInstructions + codeExecGuidance;
```

Same pattern for `executeAsyncRun()` — check if `record.allowedTools` includes `code_execute`.

### 3. Only append working directory when `code_execute` is available (`src/core/orchestrator.ts`)

**File**: `src/core/orchestrator.ts` — message augmentation (line ~97)

Currently unconditionally appends the working dir. Change to only append when `code_execute` is in the tool list:

```typescript
const hasCodeExecute = tools?.some(t => t.name === "code_execute");
if (workingDir && hasCodeExecute) {
  augmentedMessage += `\n\n[Working directory for code execution: ${workingDir}]`;
}
```

This prevents the LLM from seeing a working directory path and being tempted to write code to it when it can't actually execute anything.

### 4. Pass `hasCodeExecution` flag through to AgentSkillsSkill

**File**: `src/skills/agent-skills/skill.ts` — constructor
- Add `hasCodeExecution?: boolean` parameter, default `false`

**File**: `src/main.ts` — where `AgentSkillsSkill` is constructed
- Pass `config.execution?.enabled ?? false` as the flag

**File**: `src/skills/agent-skill-discovery.ts` — no changes needed (already passes `docker_image` through metadata)

## Files to modify

| File | Change |
|------|--------|
| `src/skills/agent-skills/skill.ts` | Add `hasCodeExecution` flag; include `execution_note` in `skill_activate` response |
| `src/core/subagent-manager.ts` | Append code execution guidance to sub-agent system prompts when `code_execute` is in tools |
| `src/core/orchestrator.ts` | Only append working directory when `code_execute` is available |
| `src/main.ts` | Pass `execution.enabled` flag when constructing `AgentSkillsSkill` |

## Verification

1. **With execution enabled**: "create a hello world PDF" → agent calls `skill_activate("pdf")` → response includes `execution_note` → agent calls `code_execute` with the code → PDF returned as attachment
2. **Sub-agent path**: "make me a PDF with jokes" → main agent delegates to sub-agent with `["skill_activate", "skill_read_resource", "code_execute"]` → sub-agent's system prompt includes code execution rules → sub-agent runs code via `code_execute` → files flow back
3. **With execution disabled**: "create a hello world PDF" → no working directory in message, no `execution_note` in skill response → agent explains code execution isn't available, no code dump
4. Build: `npm run build` must pass with no errors
