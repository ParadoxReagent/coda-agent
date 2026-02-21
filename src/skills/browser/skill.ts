import type { Skill, SkillToolDefinition } from "../base.js";
import type { SkillContext } from "../context.js";
import type { Logger } from "../../utils/logger.js";
import type { BrowserConfig } from "../../utils/config.js";
import { BrowserService } from "./service.js";

/**
 * Private IP / loopback ranges blocked by SSRF protection.
 * Covers IPv4 private space, link-local, and IPv6 loopback/ULA.
 */
const PRIVATE_IP_RANGES = [
  /^127\./,                       // 127.0.0.0/8 — loopback
  /^10\./,                        // 10.0.0.0/8 — private
  /^192\.168\./,                  // 192.168.0.0/16 — private
  /^169\.254\./,                  // 169.254.0.0/16 — link-local
  /^172\.(1[6-9]|2\d|3[01])\./,  // 172.16.0.0/12 — private
  /^::1$/,                        // IPv6 loopback
  /^fc[0-9a-f]{2}:/i,            // IPv6 ULA fc00::/7
  /^fd[0-9a-f]{2}:/i,            // IPv6 ULA fd00::/8
];

/**
 * Common internal service hostnames blocked by default.
 * Prevents the browser from reaching coda's own infrastructure.
 */
const INTERNAL_HOSTNAME_REGEX =
  /^(localhost|.*\.local|.*\.internal|.*\.lan|redis|postgres|db|coda[-_].*)$/i;

/**
 * BrowserSkill — secure browser automation via Playwright MCP in ephemeral Docker containers.
 *
 * Each browser_open call spawns a new isolated container on the `coda-browser-sandbox`
 * network (internet-only, no access to coda-internal services). All containers are
 * automatically destroyed when sessions are closed or when they idle past the timeout.
 *
 * Permission tiers:
 *   browser_close        tier 0  (read-only / cleanup)
 *   browser_screenshot   tier 1  (writes temp file, non-destructive)
 *   browser_get_content  tier 1
 *   browser_open         tier 2
 *   browser_navigate     tier 2  + requiresCritique
 *   browser_click        tier 2
 *   browser_type         tier 2  + sensitive (may contain credentials)
 *   browser_evaluate     tier 3  (confirmation required — arbitrary JS execution)
 */
export class BrowserSkill implements Skill {
  readonly name = "browser";
  readonly description =
    "Secure browser automation via Playwright in ephemeral Docker containers. " +
    "Supports navigation, form filling, screenshots, and page content extraction. " +
    "Containers are network-isolated from internal services and destroyed after use.";
  readonly kind = "integration" as const;

  private logger: Logger;
  private config: BrowserConfig;
  private service!: BrowserService;
  private urlAllowlist: string[];
  private urlBlocklist: string[];

  constructor(config: BrowserConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
    this.urlAllowlist = config.url_allowlist;
    this.urlBlocklist = config.url_blocklist;
  }

  getTools(): SkillToolDefinition[] {
    return [
      {
        name: "browser_open",
        description:
          "Open a new isolated browser session in a sandboxed Docker container. " +
          "Returns a session_id required for all subsequent browser tools. " +
          "Always call browser_close when done to release container resources.",
        input_schema: {
          type: "object",
          properties: {},
          required: [],
        },
        permissionTier: 2,
      },
      {
        name: "browser_navigate",
        description:
          "Navigate the browser to a URL. Only http/https URLs to public internet are allowed — " +
          "private IPs, loopback addresses, and internal hostnames are blocked.",
        input_schema: {
          type: "object",
          properties: {
            session_id: {
              type: "string",
              description: "Browser session ID returned by browser_open",
            },
            url: {
              type: "string",
              description: "URL to navigate to (must be http or https)",
            },
          },
          required: ["session_id", "url"],
        },
        permissionTier: 2,
        requiresCritique: true,
      },
      {
        name: "browser_screenshot",
        description:
          "Take a screenshot of the current page. Returns a file path to the saved PNG image.",
        input_schema: {
          type: "object",
          properties: {
            session_id: {
              type: "string",
              description: "Browser session ID",
            },
            full_page: {
              type: "boolean",
              description: "Capture the full scrollable page height (default: false)",
            },
          },
          required: ["session_id"],
        },
        permissionTier: 1,
      },
      {
        name: "browser_get_content",
        description:
          "Get an accessibility snapshot of the current page — a structured text representation " +
          "of all interactive elements with their ref IDs. Use this to see page content and " +
          "identify element refs needed for browser_click and browser_type.",
        input_schema: {
          type: "object",
          properties: {
            session_id: {
              type: "string",
              description: "Browser session ID",
            },
          },
          required: ["session_id"],
        },
        permissionTier: 1,
      },
      {
        name: "browser_click",
        description:
          "Click an element on the page. First call browser_get_content to obtain the " +
          "accessibility snapshot with element refs (e.g. ref='e12'). " +
          "Provide the element description and ref from the snapshot.",
        input_schema: {
          type: "object",
          properties: {
            session_id: {
              type: "string",
              description: "Browser session ID",
            },
            element: {
              type: "string",
              description: "Human-readable description of the element (from accessibility snapshot)",
            },
            ref: {
              type: "string",
              description: "Element ref ID from browser_get_content snapshot (e.g. 'e12')",
            },
          },
          required: ["session_id", "element", "ref"],
        },
        permissionTier: 2,
      },
      {
        name: "browser_type",
        description:
          "Type text into a form field. First call browser_get_content to identify the input's ref. " +
          "May contain credentials — logged as sensitive.",
        input_schema: {
          type: "object",
          properties: {
            session_id: {
              type: "string",
              description: "Browser session ID",
            },
            element: {
              type: "string",
              description: "Human-readable description of the input field",
            },
            ref: {
              type: "string",
              description: "Element ref ID from browser_get_content snapshot",
            },
            text: {
              type: "string",
              description: "Text to type into the field",
            },
          },
          required: ["session_id", "element", "ref", "text"],
        },
        permissionTier: 2,
        sensitive: true,
      },
      {
        name: "browser_evaluate",
        description:
          "Execute JavaScript in the browser page context. Use only when other browser tools " +
          "are insufficient. Requires user confirmation.",
        input_schema: {
          type: "object",
          properties: {
            session_id: {
              type: "string",
              description: "Browser session ID",
            },
            script: {
              type: "string",
              description: "JavaScript expression to evaluate in the browser context",
            },
          },
          required: ["session_id", "script"],
        },
        permissionTier: 3,
      },
      {
        name: "browser_close",
        description:
          "Close the browser session and destroy the sandboxed container. " +
          "Always call this when you are done with the browser.",
        input_schema: {
          type: "object",
          properties: {
            session_id: {
              type: "string",
              description: "Browser session ID to close",
            },
          },
          required: ["session_id"],
        },
        permissionTier: 0,
      },
    ];
  }

  async execute(toolName: string, input: Record<string, unknown>): Promise<string> {
    switch (toolName) {
      case "browser_open":      return this.openSession();
      case "browser_navigate":  return this.navigate(input);
      case "browser_screenshot": return this.screenshot(input);
      case "browser_get_content": return this.getContent(input);
      case "browser_click":     return this.click(input);
      case "browser_type":      return this.type(input);
      case "browser_evaluate":  return this.evaluate(input);
      case "browser_close":     return this.closeSession(input);
      default:
        return JSON.stringify({ success: false, error: `Unknown tool: ${toolName}` });
    }
  }

  getRequiredConfig(): string[] {
    return [];
  }

  async startup(ctx: SkillContext): Promise<void> {
    this.logger = ctx.logger;
    this.service = new BrowserService(this.config, this.logger);
    this.service.start();
    this.logger.info(
      {
        image: this.config.image,
        network: this.config.sandbox_network,
        maxSessions: this.config.max_sessions,
        sessionTimeoutSeconds: this.config.session_timeout_seconds,
      },
      "Browser automation skill started"
    );
  }

  async shutdown(): Promise<void> {
    await this.service?.stop();
    this.logger?.info("Browser automation skill stopped");
  }

  // ─── Tool implementations ─────────────────────────────────────────────────

  private async openSession(): Promise<string> {
    try {
      const result = await this.service.createSession();
      return JSON.stringify({
        success: true,
        session_id: result.sessionId,
        message:
          `Browser session started (id: ${result.sessionId}). ` +
          `Use this session_id for subsequent browser tools. ` +
          `Call browser_close when done.`,
      });
    } catch (err) {
      this.logger.error({ error: err }, "browser_open failed");
      return JSON.stringify({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async navigate(input: Record<string, unknown>): Promise<string> {
    const sessionId = input.session_id as string;
    const url = input.url as string;

    const blocked = this.validateUrl(url);
    if (blocked) {
      this.logger.warn({ url, reason: blocked }, "browser_navigate blocked");
      return JSON.stringify({ success: false, error: blocked });
    }

    try {
      const result = await this.service.callTool(sessionId, "browser_navigate", { url });
      return JSON.stringify({ success: !result.isError, result: result.content });
    } catch (err) {
      return JSON.stringify({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async screenshot(input: Record<string, unknown>): Promise<string> {
    const sessionId = input.session_id as string;
    const fullPage = (input.full_page as boolean) ?? false;

    try {
      const raw = await this.service.callToolRaw(sessionId, "browser_take_screenshot", { type: "png", fullPage });

      // Extract image block if present and save to a temp file
      for (const block of raw.content) {
        if (block.type === "image" && typeof block.data === "string") {
          const mimeType = typeof block.mimeType === "string" ? block.mimeType : "image/png";
          const filePath = await this.service.saveScreenshot(sessionId, block.data, mimeType);
          return JSON.stringify({
            success: true,
            file_path: filePath,
            message: `Screenshot saved to ${filePath}`,
          });
        }
      }

      // Fallback: return serialized text content
      const text = raw.content
        .filter((b) => b.type === "text")
        .map((b) => b.text as string)
        .join("\n");

      return JSON.stringify({
        success: !raw.isError,
        result: text || "Screenshot taken (no image data returned)",
      });
    } catch (err) {
      return JSON.stringify({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async getContent(input: Record<string, unknown>): Promise<string> {
    const sessionId = input.session_id as string;

    try {
      const result = await this.service.callTool(sessionId, "browser_snapshot", {});
      return JSON.stringify({ success: !result.isError, content: result.content });
    } catch (err) {
      return JSON.stringify({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async click(input: Record<string, unknown>): Promise<string> {
    const sessionId = input.session_id as string;
    const element = input.element as string;
    const ref = input.ref as string;

    try {
      const result = await this.service.callTool(sessionId, "browser_click", { element, ref });
      return JSON.stringify({ success: !result.isError, result: result.content });
    } catch (err) {
      return JSON.stringify({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async type(input: Record<string, unknown>): Promise<string> {
    const sessionId = input.session_id as string;
    const element = input.element as string;
    const ref = input.ref as string;
    const text = input.text as string;

    try {
      // browser_fill clears + types; browser_type just types
      const result = await this.service.callTool(sessionId, "browser_type", {
        element,
        ref,
        text,
      });
      return JSON.stringify({ success: !result.isError, result: result.content });
    } catch (err) {
      return JSON.stringify({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async evaluate(input: Record<string, unknown>): Promise<string> {
    const sessionId = input.session_id as string;
    const script = input.script as string;

    try {
      const result = await this.service.callTool(sessionId, "browser_evaluate", {
        function: `() => { ${script} }`,
      });
      return JSON.stringify({ success: !result.isError, result: result.content });
    } catch (err) {
      return JSON.stringify({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async closeSession(input: Record<string, unknown>): Promise<string> {
    const sessionId = input.session_id as string;

    try {
      await this.service.destroySession(sessionId);
      return JSON.stringify({
        success: true,
        message: `Browser session "${sessionId}" closed and container destroyed.`,
      });
    } catch (err) {
      return JSON.stringify({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ─── URL validation (SSRF protection) ────────────────────────────────────

  /**
   * Validate a URL against SSRF protection rules and the configurable blocklist/allowlist.
   * Returns an error string if the URL should be blocked, or null if allowed.
   */
  private validateUrl(url: string): string | null {
    let urlObj: URL;
    try {
      urlObj = new URL(url);
    } catch {
      return `Invalid URL: "${url}"`;
    }

    // Only allow http(s)
    if (urlObj.protocol !== "http:" && urlObj.protocol !== "https:") {
      return (
        `URL protocol "${urlObj.protocol}" is not allowed. ` +
        `Only http and https are permitted.`
      );
    }

    const hostname = urlObj.hostname.toLowerCase();

    // Block private IP ranges (SSRF protection)
    for (const range of PRIVATE_IP_RANGES) {
      if (range.test(hostname)) {
        return (
          `URL blocked: "${hostname}" resolves to a private/loopback address. ` +
          `SSRF protection prevents access to internal networks.`
        );
      }
    }

    // Block internal service hostnames
    if (INTERNAL_HOSTNAME_REGEX.test(hostname)) {
      return (
        `URL blocked: "${hostname}" is an internal hostname. ` +
        `SSRF protection prevents access to internal services.`
      );
    }

    // Configurable blocklist
    for (const entry of this.urlBlocklist) {
      const b = entry.toLowerCase();
      if (hostname === b || hostname.endsWith(`.${b}`)) {
        return `URL blocked: "${hostname}" matches blocklist entry "${entry}"`;
      }
    }

    // Configurable allowlist (if non-empty, only listed domains are permitted)
    if (this.urlAllowlist.length > 0) {
      const allowed = this.urlAllowlist.some((entry) => {
        const a = entry.toLowerCase();
        return hostname === a || hostname.endsWith(`.${a}`);
      });
      if (!allowed) {
        return (
          `URL not in allowlist: "${hostname}". ` +
          `Allowed domains: ${this.urlAllowlist.join(", ")}`
        );
      }
    }

    return null;
  }
}
