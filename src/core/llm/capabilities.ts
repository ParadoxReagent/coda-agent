import type { ProviderCapabilities } from "./provider.js";
import type { ProviderCapabilitiesConfig } from "../../utils/config.js";

export const DEFAULT_ANTHROPIC_CAPABILITIES: ProviderCapabilities = {
  tools: true,
  parallelToolCalls: true,
  usageMetrics: true,
  jsonMode: true,
  streaming: true,
};

export const DEFAULT_GOOGLE_CAPABILITIES: ProviderCapabilities = {
  tools: true,
  parallelToolCalls: false,
  usageMetrics: true,
  jsonMode: true,
  streaming: true,
};

export const DEFAULT_OPENAI_COMPAT_CAPABILITIES: ProviderCapabilities = {
  tools: true,
  parallelToolCalls: true,
  usageMetrics: true,
  jsonMode: true,
  streaming: true,
};

/** Merge config-driven capability overrides into default capabilities. */
export function mergeCapabilities(
  defaults: ProviderCapabilities,
  overrides?: ProviderCapabilitiesConfig
): ProviderCapabilities {
  if (!overrides) return { ...defaults };
  return {
    tools: overrides.tools ?? defaults.tools,
    parallelToolCalls: overrides.parallel_tool_calls ?? defaults.parallelToolCalls,
    usageMetrics: overrides.usage_metrics ?? defaults.usageMetrics,
    jsonMode: overrides.json_mode ?? defaults.jsonMode,
    streaming: overrides.streaming ?? defaults.streaming,
  };
}
