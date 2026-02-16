import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/** MCP server connection state. */
export interface McpServerState {
  status: "connected" | "disconnected" | "error";
  cachedTools?: Tool[];
  lastError?: string;
  lastErrorTimestamp?: Date;
  errorCount: number;
}

/** Result from an MCP tool call. */
export interface McpToolCallResult {
  content: string;
  isError: boolean;
}
