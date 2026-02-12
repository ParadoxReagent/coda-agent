# Subagents

Sub-agents let you run background tasks without blocking the main conversation. When you spawn a sub-agent, it runs in its own isolated session, does its work, and announces the result back to the chat when finished.
Use cases:
Research a topic while the main agent continues answering questions
Run multiple long tasks in parallel (web scraping, code analysis, file processing)
Delegate tasks to specialized agents in a multi-agent setup
​
Quick Start

The simplest way to use sub-agents is to ask your agent naturally:
“Spawn a sub-agent to research the latest Node.js release notes”
The agent will call the sessions_spawn tool behind the scenes. When the sub-agent finishes, it announces its findings back into your chat.
You can also be explicit about options:
“Spawn a sub-agent to analyze the server logs from today. Use gpt-5.2 and set a 5-minute timeout.”
​
How It Works

1. Main agent spawns

The main agent calls sessions_spawn with a task description. The call is non-blocking — the main agent gets back { status: "accepted", runId, childSessionKey } immediately.

2. Sub-agent runs in the background

A new isolated session is created (agent:<agentId>:subagent:<uuid>) on the dedicated subagent queue lane.

3. Result is announced

When the sub-agent finishes, it announces its findings back to the requester chat. The main agent posts a natural-language summary.

4. Session is archived

The sub-agent session is auto-archived after 60 minutes (configurable). Transcripts are preserved.

Slash Command:

/subagents list|stop|log|info|send (inspect, stop, log, or message sub-agent runs for the current session)
----------------

# Skills

https://github.com/anthropics/skills/tree/main/skills

https://agentskills.io/home

Per-agent vs shared skills

In multi-agent setups, each agent has its own workspace. That means:
Per-agent skills live in <workspace>/skills for that agent only.
Shared skills live in ~/.openclaw/skills (managed/local) and are visible to all agents on the same machine.
Shared folders can also be added via skills.load.extraDirs (lowest precedence) if you want a common skills pack used by multiple agents.
If the same skill name exists in more than one place, the usual precedence applies: workspace wins, then managed/local, then bundled.

Session snapshot (performance)

OpenClaw snapshots the eligible skills when a session starts and reuses that list for subsequent turns in the same session. Changes to skills or config take effect on the next new session.
Skills can also refresh mid-session when the skills watcher is enabled or when a new eligible remote node appears (see below). Think of this as a hot reload: the refreshed list is picked up on the next agent turn.
--------------

# Nodes - iOS APP???

A node is a companion device (macOS/iOS/Android/headless) that connects to the Gateway WebSocket (same port as operators) with role: "node" and exposes a command surface (e.g. canvas.*, camera.*, system.*) via node.invoke. Protocol details: Gateway protocol.
Legacy transport: Bridge protocol (TCP JSONL; deprecated/removed for current nodes).
macOS can also run in node mode: the menubar app connects to the Gateway’s WS server and exposes its local canvas/camera commands as a node (so openclaw nodes … works against this Mac).
Notes:
Nodes are peripherals, not gateways. They don’t run the gateway service.
Telegram/WhatsApp/etc. messages land on the gateway, not on nodes.
Troubleshooting runbook: /nodes/troubleshooting

---------------
#Tools

https://docs.openclaw.ai/tools/lobster

----------------

# Apple Intelligence model for iOS app?


------------------

# Memory improvements?

Lifecycle

Reset policy: sessions are reused until they expire, and expiry is evaluated on the next inbound message.
Daily reset: defaults to 4:00 AM local time on the gateway host. A session is stale once its last update is earlier than the most recent daily reset time.
Idle reset (optional): idleMinutes adds a sliding idle window. When both daily and idle resets are configured, whichever expires first forces a new session.
Legacy idle-only: if you set session.idleMinutes without any session.reset/resetByType config, OpenClaw stays in idle-only mode for backward compatibility.
Per-type overrides (optional): resetByType lets you override the policy for direct, group, and thread sessions (thread = Slack/Discord threads, Telegram topics, Matrix threads when provided by the connector).
Per-channel overrides (optional): resetByChannel overrides the reset policy for a channel (applies to all session types for that channel and takes precedence over reset/resetByType).
Reset triggers: exact /new or /reset (plus any extras in resetTriggers) start a fresh session id and pass the remainder of the message through. /new <model> accepts a model alias, provider/model, or provider name (fuzzy match) to set the new session model. If /new or /reset is sent alone, OpenClaw runs a short “hello” greeting turn to confirm the reset.
Manual reset: delete specific keys from the store or remove the JSONL transcript; the next message recreates them.
Isolated cron jobs always mint a fresh sessionId per run (no idle reuse).

 
## Automatic memory flush (pre-compaction ping)

When a session is close to auto-compaction, OpenClaw triggers a silent, agentic turn that reminds the model to write durable memory before the context is compacted. The default prompts explicitly say the model may reply, but usually NO_REPLY is the correct response so the user never sees this turn.
This is controlled by agents.defaults.compaction.memoryFlush:
{
  agents: {
    defaults: {
      compaction: {
        reserveTokensFloor: 20000,
        memoryFlush: {
          enabled: true,
          softThresholdTokens: 4000,
          systemPrompt: "Session nearing compaction. Store durable memories now.",
          prompt: "Write any lasting notes to memory/YYYY-MM-DD.md; reply with NO_REPLY if nothing to store.",
        },
      },
    },
  },
}
Details:
Soft threshold: flush triggers when the session token estimate crosses contextWindow - reserveTokensFloor - softThresholdTokens.
Silent by default: prompts include NO_REPLY so nothing is delivered.
Two prompts: a user prompt plus a system prompt append the reminder.
One flush per compaction cycle (tracked in sessions.json).
Workspace must be writable: if the session runs sandboxed with workspaceAccess: "ro" or "none", the flush is skipped.

---------------

# ClawSec?
https://prompt.security/clawsec



------------------

stock checker?
self-repair/doctor?
self improving?
ask user what LLM in cli while starting
ask for apis
ask for discord things?
slack things?

Clean way for users to enable skills without modifying config and rebuilding

CHECK FOR SECURTIY !!!!!!
https://genai.owasp.org/llm-top-10/

--------