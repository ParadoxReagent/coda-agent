/**
 * AgentLoader: modular directory-based specialist agent system.
 * Each agent lives in src/agents/{name}/ with soul.md, tools.md, config.yaml,
 * and an optional references/ directory of supplementary context docs.
 *
 * Replaces specialist-presets.ts with a file-system-driven approach that
 * allows agents to be added, edited, and extended without touching TypeScript.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { z } from "zod";
import type { Logger } from "../utils/logger.js";
import type { SpecialistsConfig } from "../utils/config.js";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface AgentDefinition {
  name: string;
  description: string;
  systemPrompt: string;
  allowedTools: string[];
  blockedTools: string[];
  defaultModel?: string;
  defaultProvider?: string;
  maxToolCalls?: number;
  tokenBudget?: number;
  /** Absolute path to the agent's directory */
  dirPath: string;
}

// ---------------------------------------------------------------------------
// Zod schema for config.yaml
// ---------------------------------------------------------------------------

const AgentConfigSchema = z.object({
  description: z.string(),
  enabled: z.boolean().default(true),
  default_model: z.string().nullable().default(null),
  default_provider: z.string().nullable().default(null),
  token_budget: z.number().nullable().default(null),
  max_tool_calls: z.number().nullable().default(null),
});

type AgentConfig = z.infer<typeof AgentConfigSchema>;

// ---------------------------------------------------------------------------
// Name pattern: lowercase letter, then lowercase alphanumerics and hyphens
// ---------------------------------------------------------------------------

const AGENT_NAME_RE = /^[a-z][a-z0-9-]*$/;

// ---------------------------------------------------------------------------
// AgentLoader class
// ---------------------------------------------------------------------------

export class AgentLoader {
  private agents: Map<string, AgentDefinition> = new Map();
  private agentsDir: string;
  private logger: Logger;

  constructor(agentsDir: string, logger: Logger) {
    this.agentsDir = agentsDir;
    this.logger = logger;
  }

  /** Scan the agents directory and load all valid agent definitions. */
  async scan(): Promise<void> {
    const freshAgents: Map<string, AgentDefinition> = new Map();

    let entries: string[];
    try {
      entries = await readdir(this.agentsDir);
    } catch (err) {
      this.logger.warn({ error: err, dir: this.agentsDir }, "AgentLoader: agents directory not found or unreadable");
      this.agents = freshAgents;
      return;
    }

    for (const entry of entries) {
      const agentDir = join(this.agentsDir, entry);

      // Must be a directory
      try {
        const s = await stat(agentDir);
        if (!s.isDirectory()) continue;
      } catch {
        continue;
      }

      // Validate name pattern
      if (!AGENT_NAME_RE.test(entry)) {
        this.logger.warn({ name: entry }, "AgentLoader: skipping directory with invalid agent name");
        continue;
      }

      try {
        const definition = await this.loadAgent(entry, agentDir);
        if (definition) {
          freshAgents.set(entry, definition);
          this.logger.debug({ name: entry }, "AgentLoader: loaded agent");
        }
      } catch (err) {
        this.logger.warn({ name: entry, error: err }, "AgentLoader: error loading agent, skipping");
      }
    }

    this.agents = freshAgents;
    this.logger.info(
      { count: freshAgents.size, names: [...freshAgents.keys()] },
      "Specialist agents loaded"
    );
  }

  /** Reload agents from disk (same as scan). */
  async rescan(): Promise<void> {
    return this.scan();
  }

  /** Get a loaded agent definition by name. */
  getAgent(name: string): AgentDefinition | undefined {
    return this.agents.get(name);
  }

  /** Get all loaded agent names. */
  getAgentNames(): string[] {
    return [...this.agents.keys()];
  }

  /**
   * Resolve an agent by name, applying config overrides from the
   * specialists config section (same merge logic as old resolvePreset).
   * Throws if the agent is not found.
   */
  resolveAgent(name: string, configOverrides?: SpecialistsConfig): AgentDefinition {
    const base = this.agents.get(name);
    if (!base) {
      throw new Error(`Unknown specialist agent: '${name}'`);
    }

    const override = configOverrides?.[name];
    if (!override) {
      return { ...base };
    }

    return {
      ...base,
      systemPrompt: override.system_prompt ?? base.systemPrompt,
      allowedTools: override.allowed_tools ?? base.allowedTools,
      blockedTools: override.blocked_tools ?? base.blockedTools,
      defaultModel: override.default_model ?? base.defaultModel,
      defaultProvider: override.default_provider ?? base.defaultProvider,
      tokenBudget: override.token_budget ?? base.tokenBudget,
      maxToolCalls: override.max_tool_calls ?? base.maxToolCalls,
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async loadAgent(name: string, agentDir: string): Promise<AgentDefinition | null> {
    const soulPath = join(agentDir, "soul.md");
    const toolsPath = join(agentDir, "tools.md");
    const configPath = join(agentDir, "config.yaml");

    // Check required files exist
    for (const p of [soulPath, toolsPath, configPath]) {
      try {
        await stat(p);
      } catch {
        this.logger.warn({ name, missing: p }, "AgentLoader: required file missing, skipping agent");
        return null;
      }
    }

    // Parse config.yaml
    const configRaw = await readFile(configPath, "utf8");
    let agentConfig: AgentConfig;
    try {
      const parsed = await parseYaml(configRaw);
      agentConfig = AgentConfigSchema.parse(parsed);
    } catch (err) {
      this.logger.warn({ name, error: err }, "AgentLoader: invalid config.yaml, skipping agent");
      return null;
    }

    // Skip disabled agents
    if (!agentConfig.enabled) {
      this.logger.debug({ name }, "AgentLoader: agent disabled, skipping");
      return null;
    }

    // Read soul.md (system prompt body)
    const soulContent = (await readFile(soulPath, "utf8")).trim();

    // Parse tools.md
    const toolsContent = await readFile(toolsPath, "utf8");
    const allowedTools = toolsContent
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));

    // Build system prompt, appending references if present
    let systemPrompt = soulContent;
    const referencesDir = join(agentDir, "references");
    try {
      const refStat = await stat(referencesDir);
      if (refStat.isDirectory()) {
        const refFiles = (await readdir(referencesDir))
          .filter((f) => [".md", ".txt", ".json"].includes(extname(f)))
          .sort();

        for (const refFile of refFiles) {
          const refPath = join(referencesDir, refFile);
          const refContent = (await readFile(refPath, "utf8")).trim();
          const refName = basename(refFile, extname(refFile));
          systemPrompt += `\n\n---\n## Reference: ${refName}\n${refContent}`;
        }
      }
    } catch {
      // references/ doesn't exist or isn't readable — that's fine
    }

    return {
      name,
      description: agentConfig.description,
      systemPrompt,
      allowedTools,
      blockedTools: [],
      defaultModel: agentConfig.default_model ?? undefined,
      defaultProvider: agentConfig.default_provider ?? undefined,
      tokenBudget: agentConfig.token_budget ?? undefined,
      maxToolCalls: agentConfig.max_tool_calls ?? undefined,
      dirPath: agentDir,
    };
  }
}

// ---------------------------------------------------------------------------
// Minimal YAML parser (no dependencies — handles the simple flat config.yaml)
// Falls back to a proper YAML library if available.
// ---------------------------------------------------------------------------

async function parseYaml(content: string): Promise<Record<string, unknown>> {
  // Try to use js-yaml if available (it's already a dep via @anthropic-ai/sdk or drizzle tooling)
  try {
    const { load } = await import("js-yaml");
    return load(content) as Record<string, unknown>;
  } catch {
    // Fallback: parse simple flat YAML (key: value, no nesting needed for our schema)
    return parseFlatYaml(content);
  }
}

function parseFlatYaml(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const rawValue = trimmed.slice(colonIdx + 1).trim();

    if (rawValue === "null" || rawValue === "~" || rawValue === "") {
      result[key] = null;
    } else if (rawValue === "true") {
      result[key] = true;
    } else if (rawValue === "false") {
      result[key] = false;
    } else if (/^-?\d+(\.\d+)?$/.test(rawValue)) {
      result[key] = Number(rawValue);
    } else {
      // Strip surrounding quotes
      result[key] = rawValue.replace(/^["']|["']$/g, "");
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Module-level singleton and backward-compatible free functions
// ---------------------------------------------------------------------------

let _loader: AgentLoader | null = null;

/** Resolve the agents directory relative to this module's location. */
function resolveAgentsDir(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  // In both src/ and dist/, agents/ lives alongside core/
  return join(__dirname, "..", "agents");
}

/**
 * Initialize the global AgentLoader singleton.
 * Call this once at startup before using resolvePreset/getPresetNames.
 */
export async function initAgentLoader(logger: Logger): Promise<AgentLoader> {
  const agentsDir = resolveAgentsDir();
  _loader = new AgentLoader(agentsDir, logger);
  await _loader.scan();
  return _loader;
}

/** Get the global AgentLoader singleton (must call initAgentLoader first). */
export function getAgentLoader(): AgentLoader {
  if (!_loader) {
    throw new Error("AgentLoader not initialized — call initAgentLoader() first");
  }
  return _loader;
}

// ---------------------------------------------------------------------------
// Backward-compatible API (same function signatures as specialist-presets.ts)
// ---------------------------------------------------------------------------

/** @deprecated Use getAgentLoader().resolveAgent() instead. */
export function resolvePreset(
  name: string,
  configOverrides?: SpecialistsConfig
): AgentDefinition {
  return getAgentLoader().resolveAgent(name, configOverrides);
}

/** @deprecated Use getAgentLoader().getAgentNames() instead. */
export function getPresetNames(): string[] {
  return getAgentLoader().getAgentNames();
}
