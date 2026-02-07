import type { LLMProvider } from "./provider.js";
import { AnthropicProvider } from "./anthropic.js";
import { GoogleProvider } from "./google.js";
import { OpenAICompatProvider } from "./openai-compat.js";
import type { ProviderConfig } from "../../utils/config.js";

/**
 * Create an LLM provider from config.
 * Maps config type to the appropriate adapter class.
 */
export function createProvider(
  name: string,
  config: ProviderConfig
): LLMProvider {
  switch (config.type) {
    case "anthropic":
      return new AnthropicProvider(config.api_key, config.capabilities);

    case "google":
      return new GoogleProvider(config.api_key, config.capabilities);

    case "openai_compat":
      return new OpenAICompatProvider({
        baseURL: config.base_url,
        apiKey: config.api_key,
        name,
        defaultHeaders: config.default_headers,
        capabilities: config.capabilities,
      });

    default:
      throw new Error(`Unknown provider type: ${config.type}`);
  }
}
