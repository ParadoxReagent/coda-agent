import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerConfig, McpTransport } from "../../utils/config.js";
import type { McpToolCallResult } from "./types.js";

export class McpClientWrapper {
  private client: Client;
  private transport?: Transport;
  private config: McpServerConfig;

  constructor(_serverName: string, config: McpServerConfig) {
    this.config = config;
    this.client = new Client(
      {
        name: "coda-agent",
        version: "1.0.0",
      },
      {
        capabilities: {},
      }
    );
  }

  /** Create transport based on config type. */
  private createTransport(transportConfig: McpTransport): Transport {
    switch (transportConfig.type) {
      case "stdio":
        return new StdioClientTransport({
          command: transportConfig.command,
          args: transportConfig.args,
          env: transportConfig.env,
          stderr: "pipe",
        });

      case "http":
        return new StreamableHTTPClientTransport(
          new URL(transportConfig.url),
          {
            requestInit: {
              headers: transportConfig.headers,
            },
          }
        );
    }
  }

  /** Connect to MCP server with timeout. */
  async connect(): Promise<void> {
    const abortController = new AbortController();
    const timeout = setTimeout(() => {
      abortController.abort();
    }, this.config.timeout_ms);

    try {
      this.transport = this.createTransport(this.config.transport);
      await this.client.connect(this.transport);
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Disconnect and cleanup. */
  async disconnect(): Promise<void> {
    try {
      await this.client.close();

      // Explicitly close transport
      if (this.transport) {
        await this.transport.close();
      }
    } catch (err) {
      // Ignore disconnect errors
    }
  }

  /** List available tools from the MCP server. */
  async listTools(): Promise<Tool[]> {
    const response = await this.client.listTools();
    return response.tools;
  }

  /** Call an MCP tool with timeout. */
  async callTool(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<McpToolCallResult> {
    const abortController = new AbortController();
    const timeout = setTimeout(() => {
      abortController.abort();
    }, this.config.tool_timeout_ms);

    try {
      const result = await this.client.callTool({
        name: toolName,
        arguments: args,
      });

      const content = this.serializeContent(result.content as any);
      return {
        content,
        isError: (result.isError as boolean | undefined) ?? false,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Serialize MCP content blocks to a string.
   * Handles text, image (as description), and embedded resources.
   */
  private serializeContent(content: any[]): string {
    if (!Array.isArray(content)) {
      return String(content);
    }

    const parts: string[] = [];

    for (const block of content) {
      if (block.type === "text") {
        parts.push(block.text);
      } else if (block.type === "image") {
        parts.push(`[Image: ${block.data}]`);
      } else if (block.type === "resource") {
        if ("text" in block.resource) {
          parts.push(block.resource.text);
        } else if ("blob" in block.resource) {
          parts.push(`[Binary resource: ${block.resource.mimeType ?? "unknown"}]`);
        }
      }
    }

    return parts.join("\n");
  }
}
