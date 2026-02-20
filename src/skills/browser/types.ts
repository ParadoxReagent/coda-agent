/**
 * Browser skill types.
 * BrowserConfig is defined via Zod schema in config.ts and re-exported here.
 */
export type { BrowserConfig } from "../../utils/config.js";

/** Public session info returned to callers (no internal MCP client references). */
export interface BrowserSessionInfo {
  id: string;
  createdAt: number;
  lastActivityAt: number;
  userId?: string;
}
