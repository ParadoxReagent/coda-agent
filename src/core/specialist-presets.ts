/**
 * Specialist agent presets: domain-focused sub-agent configurations.
 * Each preset defines a system prompt, allowed tools, and resource limits.
 */
import type { SpecialistsConfig } from "../utils/config.js";

export interface SpecialistPreset {
  name: string;
  description: string;
  systemPrompt: string;
  allowedTools: string[];
  blockedTools: string[];
  defaultModel?: string;
  defaultProvider?: string;
  maxToolCalls?: number;
  tokenBudget?: number;
}

const BUILT_IN_PRESETS: Record<string, SpecialistPreset> = {
  home: {
    name: "home",
    description: "Household management: reminders, notes, weather, and personal organisation",
    systemPrompt: `You are a household management specialist. Your focus is on personal organisation, reminders, notes, and home-related information.

Priorities:
- Set and manage reminders for household tasks, appointments, and events
- Save and retrieve personal notes and information
- Provide weather information relevant to outdoor plans
- Keep responses practical and actionable for day-to-day life

Be concise and friendly. Always confirm what you've done after completing each action.`,
    allowedTools: [
      "reminder_create",
      "reminder_list",
      "reminder_delete",
      "note_save",
      "note_search",
      "note_list",
      "note_get",
      "memory_save",
      "memory_search",
      "weather_current",
      "weather_forecast",
    ],
    blockedTools: [],
    tokenBudget: 30000,
  },

  research: {
    name: "research",
    description: "Web research and synthesis: scraping, searching, and summarising information",
    systemPrompt: `You are a research specialist. Your focus is on gathering, synthesising, and organising information from the web.

Priorities:
- Search the web for accurate, up-to-date information
- Scrape and extract key content from web pages
- Synthesise findings into clear, structured summaries
- Save important discoveries to notes for future reference
- Cite sources clearly

Be thorough. Cross-reference multiple sources before drawing conclusions. Flag information that appears outdated or conflicting.`,
    allowedTools: [
      "firecrawl_scrape",
      "firecrawl_search",
      "firecrawl_map",
      "note_save",
      "note_search",
      "note_list",
      "memory_save",
      "memory_search",
    ],
    blockedTools: [],
    tokenBudget: 80000,
  },

  lab: {
    name: "lab",
    description: "Development and coding: code execution, debugging, and technical research",
    systemPrompt: `You are a development and coding specialist. Your focus is on writing, executing, and debugging code.

Priorities:
- Execute code in sandboxed containers using code_execute
- Research technical documentation and examples via web tools
- Save useful code snippets and findings to notes
- Debug errors systematically — always read error output before retrying
- Write output files to /workspace/output/ when generating artifacts

Rules:
- NEVER paste code for the user to run manually — always execute it yourself
- Install dependencies inline: "pip install <pkg> && python script.py"
- For complex scripts, write to a file first, then execute the file`,
    allowedTools: [
      "code_execute",
      "note_save",
      "note_search",
      "note_list",
      "memory_save",
      "memory_search",
      "firecrawl_scrape",
      "firecrawl_search",
    ],
    blockedTools: [],
    tokenBudget: 100000,
  },

  planner: {
    name: "planner",
    description: "Task planning and breakdown: organising work into actionable steps",
    systemPrompt: `You are a task planning specialist. Your focus is on breaking down complex goals into structured, actionable plans.

Priorities:
- Decompose complex requests into clear, ordered steps
- Create persistent tasks for multi-day work when appropriate
- Set reminders for deadlines and follow-ups
- Save plans and decisions to notes for reference
- Consider dependencies, risks, and edge cases in your planning

Output plans in a structured format with clear action items, owners (if applicable), and timelines.`,
    allowedTools: [
      "task_create",
      "task_status",
      "task_advance",
      "task_list",
      "note_save",
      "note_search",
      "note_list",
      "memory_save",
      "memory_search",
      "reminder_create",
      "reminder_list",
    ],
    blockedTools: [],
    tokenBudget: 40000,
  },
};

/**
 * Resolve a preset by name, applying any config overrides.
 * Throws if the preset name is not found.
 */
export function resolvePreset(
  name: string,
  configOverrides?: SpecialistsConfig
): SpecialistPreset {
  const base = BUILT_IN_PRESETS[name];
  if (!base) {
    throw new Error(`Unknown specialist preset: '${name}'`);
  }

  const override = configOverrides?.[name];
  if (!override) {
    return { ...base };
  }

  // Merge override into base
  return {
    ...base,
    systemPrompt: override.system_prompt ?? base.systemPrompt,
    allowedTools: override.allowed_tools ?? base.allowedTools,
    blockedTools: override.blocked_tools ?? base.blockedTools,
    defaultModel: override.default_model ?? base.defaultModel,
    defaultProvider: override.default_provider ?? base.defaultProvider,
  };
}

/** Get all available preset names (built-in + config-enabled overrides). */
export function getPresetNames(): string[] {
  return Object.keys(BUILT_IN_PRESETS);
}
