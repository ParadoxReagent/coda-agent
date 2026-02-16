import { ContentSanitizer } from "../../core/sanitizer.js";

/**
 * Sanitize MCP response content by wrapping it with ContentSanitizer.
 * MCP responses are treated as untrusted external data.
 */
export function sanitizeMcpResponse(content: string): string {
  return ContentSanitizer.sanitizeApiResponse(content);
}

/**
 * Truncate MCP response to enforced max size.
 * Returns truncated content and a flag indicating whether truncation occurred.
 */
export function truncateMcpResponse(
  content: string,
  maxSize: number
): { content: string; truncated: boolean } {
  if (content.length <= maxSize) {
    return { content, truncated: false };
  }

  return {
    content: content.slice(0, maxSize),
    truncated: true,
  };
}
