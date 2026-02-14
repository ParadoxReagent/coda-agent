  Feasibility: Highly feasible. Your architecture is remarkably well-positioned — the critical insight is that each connected node
  becomes a Skill (via NodeProxySkill), meaning zero changes to Orchestrator or BaseAgent. The existing SkillRegistry, health tracking,
  rate limiting, confirmation flow, and content sanitization all work unchanged.

  Protocol: WebSocket (wss://) — native iOS support, bidirectional, Fastify already in your stack.

  Security is the biggest concern since nodes have filesystem/system access. The plan addresses 10 specific threat categories with
  mitigations including dual-side validation, short-lived JWTs, capability scoping at enrollment, all node output treated as untrusted,
  and no direct node-to-node communication.

  4 implementation phases: Gateway foundation → Capability proxy → TypeScript node agent → iOS node client.

  The only meaningful change to existing code is adding unregister() to SkillRegistry. Everything else is additive.

────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 Ready to code?

 Here is Claude's plan:
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 Node/Gateway Architecture for coda-agent

 Context

 You want remote devices (other computers, an iOS app, headless servers) to connect back to your primary coda-agent instance and expose
  local capabilities (filesystem, camera, system commands, etc.). The primary server acts as a Gateway, and remote devices run
 lightweight Node agents that call back to it — similar to OpenClaw's gateway/node model. Your roadmap already sketches this concept
 under "Nodes."

 This plan evaluates feasibility, security, and architecture for implementing this system.

 ---
 Feasibility: Highly Feasible

 Your existing architecture is remarkably well-suited for this. The key insight is that each connected node becomes a Skill — a
 NodeProxySkill that implements the existing Skill interface. This means:

 - Zero changes to Orchestrator or BaseAgent — they just see more tools appear/disappear
 - SkillRegistry already handles dynamic registration, health tracking, rate limiting, tool routing
 - SkillHealthTracker already has degraded/unavailable states with recovery probes — maps perfectly to node connectivity
 - ResilientExecutor already handles timeouts and retries for tool calls
 - ContentSanitizer already wraps untrusted external content — node responses get the same treatment
 - Confirmation flow already exists for destructive operations — filesystem/system tools use it unchanged
 - EventBus (Redis Streams) can carry node lifecycle events
 - Doctor service can classify node-specific errors

 The only meaningful change to existing code: adding an unregister() method to SkillRegistry for when nodes disconnect.

 What's new: WebSocket server (via @fastify/websocket), node auth system, NodeManager, NodeProxySkill, node agent package, DB tables.

 ---
 Security Threat Model

 This is the critical consideration. Nodes have access to filesystems and system commands on remote machines.

 Threats and Mitigations

 Threat: Rogue node registration
 Impact: Critical
 Mitigation: Pre-shared enrollment tokens (one-time use, 24h TTL). Explicit allowlist of enrolled node IDs in DB. No anonymous
   connections.
 ────────────────────────────────────────
 Threat: Node impersonation
 Impact: Critical
 Mitigation: Per-node HMAC secret issued at enrollment. Short-lived JWT session tokens (15 min TTL). Node identity bound to secret
   stored in DB.
 ────────────────────────────────────────
 Threat: Man-in-the-middle
 Impact: Critical
 Mitigation: All connections use TLS 1.3 (wss://). For LAN-only: self-signed CA with pinned certs.
 ────────────────────────────────────────
 Threat: Command injection via tool inputs
 Impact: Critical
 Mitigation: Dual-side Zod validation (gateway AND node). Nodes enforce path allowlists and command allowlists. No eval()/exec() with
   raw input. Shell metacharacter escaping.
 ────────────────────────────────────────
 Threat: Privilege escalation
 Impact: High
 Mitigation: Capabilities scoped at enrollment. Tool calls validated against enrolled capability set on both sides.
 requiresConfirmation
   on dangerous ops (write, delete, run_command).
 ────────────────────────────────────────
 Threat: Prompt injection from node responses
 Impact: Medium
 Mitigation: All node output sanitized via ContentSanitizer (same as subagent output). Wrapped in <external_content> tags.
 ────────────────────────────────────────
 Threat: DoS from malicious node
 Impact: Medium
 Mitigation: Response size limits (1MB default). Per-tool timeouts via ResilientExecutor. Per-node rate limiting. Health tracking
   auto-degrades after repeated failures.
 ────────────────────────────────────────
 Threat: Replay attacks
 Impact: Medium
 Mitigation: Message nonces + timestamps. Reject messages >30s old or with seen nonces.
 ────────────────────────────────────────
 Threat: Node-to-node lateral movement
 Impact: High
 Mitigation: Impossible by design — nodes NEVER communicate directly. All traffic goes through gateway.
 ────────────────────────────────────────
 Threat: Stale credentials
 Impact: Medium
 Mitigation: 15-min JWT TTL. Heartbeat-based liveness (30s interval, 3 missed = disconnected). Explicit revocation endpoint with Redis
   denylist.

 Key Security Principles

 1. Defense in depth: Validate on both gateway AND node side
 2. All node output is untrusted: Same sanitization as external content
 3. Least privilege: Nodes only get capabilities explicitly enrolled for
 4. No direct node-to-node communication: Gateway mediates everything
 5. Short-lived credentials: 15-min JWTs, heartbeat monitoring

 ---
 Protocol: WebSocket (wss://)

 Why WebSocket over gRPC or HTTP long-poll:
 - Fastify already in the stack — @fastify/websocket is trivial to add
 - Native iOS support via URLSessionWebSocketTask (no third-party deps)
 - Bidirectional: gateway sends tool calls, node sends results + heartbeats
 - Lower latency than HTTP long-poll
 - No protobuf compilation step for Swift/Kotlin clients

 Message envelope:
 interface NodeMessage {
   type: "tool_call" | "tool_result" | "heartbeat" | "capability_update" | "error" | "ping" | "pong";
   id: string;          // UUID
   nodeId: string;
   timestamp: number;   // Unix ms
   nonce: string;       // replay prevention
   payload: unknown;    // type-specific
 }

 ---
 Architecture

     Discord/Slack (existing)
            |
       Orchestrator (unchanged)
            |
       SkillRegistry  <-- NodeProxySkill instances auto-registered here
            |
     +------+------+
     |             |
  Local Skills   NodeProxySkill  (one per connected node, implements Skill interface)
  (unchanged)      |
               NodeManager  (new — manages WS connections, enrollment, heartbeats)
                   |
             WebSocket Server  (Fastify, wss://)
                   |
         +---------+---------+
         |         |         |
     Node: Mac  Node: iOS  Node: RPi

 NodeProxySkill (the critical piece)

 Each connected node becomes a Skill. Tools are prefixed to avoid collisions:
 - Pattern: node_{slug}_{tool_name}
 - Example: node_macbook_read_file, node_iphone_take_photo
 - LLM sees: node_macbook_read_file: [node:macbook] Read a file from the remote filesystem

 When the LLM calls node_macbook_read_file, the NodeProxySkill.execute() method forwards the call over WebSocket to the Mac node, waits
  for the response (with timeout), sanitizes it, and returns it.

 Node Lifecycle

 1. Enrollment: Admin creates enrollment token via POST /api/nodes/enroll. Node connects with token, receives permanent node ID + HMAC
 secret.
 2. Connection: Node connects to wss://gateway:3000/ws/node with JWT. Gateway creates NodeProxySkill, registers it with SkillRegistry.
 3. Heartbeat: Gateway pings every 30s. 3 missed pongs = disconnected. Node reconnects with exponential backoff (1s → 30s max).
 4. Disconnection: NodeProxySkill unregistered from SkillRegistry. SkillHealthTracker marks unavailable.
 5. Revocation: DELETE /api/nodes/:nodeId — node added to Redis denylist, credentials invalidated.

 ---
 Standard Capability Libraries

 Pre-built modules nodes can include:

 ┌───────────────┬──────────────────────────────────────────────────────────┬───────────────────────┐
 │   Category    │                          Tools                           │ Confirmation Required │
 ├───────────────┼──────────────────────────────────────────────────────────┼───────────────────────┤
 │ filesystem    │ read_file, write_file, list_dir, file_info, search_files │ write/delete: yes     │
 ├───────────────┼──────────────────────────────────────────────────────────┼───────────────────────┤
 │ system        │ run_command, system_info, process_list, screenshot       │ run_command: yes      │
 ├───────────────┼──────────────────────────────────────────────────────────┼───────────────────────┤
 │ camera        │ take_photo, list_cameras                                 │ no                    │
 ├───────────────┼──────────────────────────────────────────────────────────┼───────────────────────┤
 │ clipboard     │ get_clipboard, set_clipboard                             │ set: yes              │
 ├───────────────┼──────────────────────────────────────────────────────────┼───────────────────────┤
 │ notifications │ send_notification                                        │ no                    │
 └───────────────┴──────────────────────────────────────────────────────────┴───────────────────────┘

 ---
 iOS-Specific Considerations

 - Background execution: iOS kills background WebSocket after ~30s. Use BGTaskScheduler for periodic reconnection. For urgent tool
 calls when backgrounded: APNs silent push → wake app → reconnect → receive call.
 - Sandboxing: iOS nodes can only access app sandbox filesystem. Camera/Photos require explicit user permission.
 - Client library: Pure Swift using URLSessionWebSocketTask (no third-party deps). Credentials stored in Keychain.
 - Latency: iOS nodes should be marked as "best-effort" in capability metadata. Gateway can prefer non-iOS nodes for time-sensitive
 operations.
 - Architecture: Swift package (CodaNodeKit) with Connection/, Auth/, Capabilities/, Security/ modules — embeddable in a larger iOS
 app.

 ---
 Implementation Phases

 Phase 1: Gateway Foundation

 - WebSocket server via @fastify/websocket on existing Fastify instance
 - Node enrollment, JWT auth, heartbeat protocol
 - NodeManager service
 - DB tables: nodes, node_capabilities, node_audit_log
 - Config section with Zod validation
 - Files: new src/core/nodes/ directory, expand src/interfaces/rest-api.ts, new migration, expand src/utils/config.ts

 Phase 2: Capability Proxy

 - NodeProxySkill implementing Skill interface
 - Dynamic registration/unregistration with SkillRegistry
 - Tool call forwarding over WebSocket with timeout
 - Response sanitization via ContentSanitizer
 - Capability manifest validation
 - Files: new src/skills/node-proxy/, minor change to src/skills/registry.ts (add unregister()), expand src/core/sanitizer.ts

 Phase 3: TypeScript Node Agent

 - Separate package (packages/node-agent/ or standalone repo)
 - WebSocket client with reconnection
 - Filesystem and system capability modules with sandboxing
 - Input validation on node side
 - CLI for enrollment and running
 - Lightweight: no LLM, no Redis, no PostgreSQL

 Phase 4: iOS Node Client

 - Swift package (CodaNodeKit)
 - URLSessionWebSocketTask connectivity
 - Camera, Photos, Clipboard, Notifications capabilities
 - Keychain credential storage
 - APNs silent push bridge for backgrounded tool calls

 ---
 Key Risks

 Risk: Gateway is single point of failure
 Mitigation: Docker restart policy + health checks. Future: multi-instance with Redis-backed state.
 ────────────────────────────────────────
 Risk: WebSocket instability
 Mitigation: Exponential backoff reconnection. SkillHealthTracker auto-degrades. ResilientExecutor retries.
 ────────────────────────────────────────
 Risk: LLM generates harmful commands
 Mitigation: requiresConfirmation on all dangerous tools. Existing confirmation flow handles this unchanged.
 ────────────────────────────────────────
 Risk: iOS background limits
 Mitigation: APNs bridge + "best-effort" node marking. Clear UX expectation.
 ────────────────────────────────────────
 Risk: Credential theft from node device
 Mitigation: Short-lived JWTs. OS keychain storage. Revocation endpoint.

 ---
 Critical Files to Modify

 ┌────────────────────────────┬────────────────────────────────────────────────────────────────┐
 │            File            │                             Change                             │
 ├────────────────────────────┼────────────────────────────────────────────────────────────────┤
 │ src/skills/registry.ts     │ Add unregister() method for runtime skill removal              │
 ├────────────────────────────┼────────────────────────────────────────────────────────────────┤
 │ src/skills/base.ts         │ Potentially extend Skill interface with optional node metadata │
 ├────────────────────────────┼────────────────────────────────────────────────────────────────┤
 │ src/interfaces/rest-api.ts │ Add WebSocket upgrade, node management REST endpoints          │
 ├────────────────────────────┼────────────────────────────────────────────────────────────────┤
 │ src/core/sanitizer.ts      │ Add sanitizeNodeOutput() method                                │
 ├────────────────────────────┼────────────────────────────────────────────────────────────────┤
 │ src/utils/config.ts        │ Add nodes config section with Zod schema                       │
 ├────────────────────────────┼────────────────────────────────────────────────────────────────┤
 │ src/main.ts                │ Initialize NodeManager if nodes enabled                        │
 └────────────────────────────┴────────────────────────────────────────────────────────────────┘

 New Files

 ┌────────────────────────────────────────┬─────────────────────────────────────────────────┐
 │                  File                  │                     Purpose                     │
 ├────────────────────────────────────────┼─────────────────────────────────────────────────┤
 │ src/core/nodes/node-manager.ts         │ Manages WS connections, enrollment, heartbeats  │
 ├────────────────────────────────────────┼─────────────────────────────────────────────────┤
 │ src/core/nodes/node-connection.ts      │ Single node WebSocket connection                │
 ├────────────────────────────────────────┼─────────────────────────────────────────────────┤
 │ src/core/nodes/node-auth.ts            │ JWT issuance, validation, HMAC enrollment       │
 ├────────────────────────────────────────┼─────────────────────────────────────────────────┤
 │ src/core/nodes/types.ts                │ All node-related interfaces                     │
 ├────────────────────────────────────────┼─────────────────────────────────────────────────┤
 │ src/skills/node-proxy/skill.ts         │ NodeProxySkill implementing Skill interface     │
 ├────────────────────────────────────────┼─────────────────────────────────────────────────┤
 │ src/core/nodes/capability-validator.ts │ Validate capability manifests                   │
 ├────────────────────────────────────────┼─────────────────────────────────────────────────┤
 │ DB migration                           │ nodes, node_capabilities, node_audit_log tables │
 └────────────────────────────────────────┴─────────────────────────────────────────────────┘

 ---
 Verification

 1. Unit tests: NodeManager enrollment/auth flow, NodeProxySkill tool routing, capability validation, message protocol serialization
 2. Integration tests: WebSocket connection lifecycle (connect → capability update → tool call → disconnect), reconnection after
 failure, concurrent node connections
 3. Security tests: Reject invalid JWT, reject unenrolled node, reject tool call outside allowed capabilities, validate input
 sanitization, replay attack prevention
 4. Manual E2E: Run gateway + one TypeScript node agent on another machine, issue filesystem commands via Discord, verify confirmation
 flow works for destructive ops