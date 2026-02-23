/**
 * Browser skill types.
 * BrowserConfig is defined via Zod schema in config.ts and re-exported here.
 */
export type { BrowserConfig } from "../../utils/config.js";

/** Browser connection mode. */
export type BrowserMode = "docker" | "host";

/** Actions supported by browser_interact. */
export type InteractionAction = "click" | "type" | "select";

/** Public session info returned to callers (no internal Playwright references). */
export interface BrowserSessionInfo {
  id: string;
  createdAt: number;
  lastActivityAt: number;
  userId?: string;
}
