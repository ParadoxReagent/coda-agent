import { basename } from "node:path";
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
 * BrowserSkill — secure browser automation via Playwright in ephemeral Docker containers.
 *
 * Each browser_open call spawns a new isolated container on the `coda-browser-sandbox`
 * network (internet-only, no access to coda-internal services). All containers are
 * automatically destroyed when sessions are closed or when they idle past the timeout.
 *
 * Permission tiers:
 *   browser_close        tier 0  (cleanup)
 *   browser_screenshot   tier 1  (writes temp file, non-destructive)
 *   browser_get_content  tier 1  (read-only)
 *   browser_open         tier 2
 *   browser_navigate     tier 2  + requiresCritique
 *   browser_interact     tier 2  + sensitive (may contain credentials when action=type)
 */
export class BrowserSkill implements Skill {
  readonly name = "browser";
  readonly description =
    "Secure browser automation via Playwright in ephemeral Docker containers. " +
    "Supports navigation, form interaction, screenshots, and page content extraction. " +
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
          "Optionally navigate to a starting URL in the same call. " +
          "Always call browser_close when done to release container resources.",
        input_schema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description:
                "Optional URL to navigate to immediately after opening the session. " +
                "Must be http or https. If omitted, session opens at a blank page.",
            },
          },
          required: [],
        },
        permissionTier: 2,
      },
      {
        name: "browser_navigate",
        description:
          "Navigate the browser to a URL. Only http/https URLs to the public internet are allowed — " +
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
        name: "browser_get_content",
        description:
          "Get an accessibility snapshot of the current page — a structured text representation " +
          "of all interactive elements with Playwright locator strings. " +
          "Use the locators in the '→' column as the selector for browser_interact.",
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
        name: "browser_interact",
        description:
          "Interact with an element on the page: click a button or link, type text into a field, " +
          "or select a dropdown option. Use browser_get_content first to get selectors. " +
          "Marked sensitive because type action may contain credentials.",
        input_schema: {
          type: "object",
          properties: {
            session_id: {
              type: "string",
              description: "Browser session ID",
            },
            action: {
              type: "string",
              enum: ["click", "type", "select"],
              description:
                "Action to perform: " +
                "'click' — click the element; " +
                "'type' — fill a text input (clears existing value first); " +
                "'select' — choose an option from a <select> dropdown",
            },
            selector: {
              type: "string",
              description:
                "Playwright selector for the element, e.g. from browser_get_content. " +
                "Examples: 'button:has-text(\"Sign In\")', 'input[placeholder=\"Email\"]', " +
                "'a:has-text(\"About Us\")', 'select[aria-label=\"Country\"]'",
            },
            value: {
              type: "string",
              description:
                "Text to type (action=type) or option value to select (action=select). " +
                "Not used for action=click.",
            },
          },
          required: ["session_id", "action", "selector"],
        },
        permissionTier: 2,
        sensitive: true,
      },
      {
        name: "browser_screenshot",
        description:
          "Take a screenshot of the current page. Returns a file path to the saved JPEG image.",
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
      case "browser_open":        return this.openSession(input);
      case "browser_navigate":   return this.navigate(input);
      case "browser_get_content": return this.getContent(input);
      case "browser_interact":   return this.interact(input);
      case "browser_screenshot": return this.screenshot(input);
      case "browser_close":      return this.closeSession(input);
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
        mode: this.config.mode,
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

  // ─── Tool implementations ────────────────────────────────────────────────────

  private async openSession(input: Record<string, unknown>): Promise<string> {
    const url = input.url as string | undefined;

    // Validate URL before creating the session if provided
    if (url) {
      const blocked = this.validateUrl(url);
      if (blocked) {
        this.logger.warn({ url, reason: blocked }, "browser_open navigate blocked");
        return JSON.stringify({ success: false, error: blocked });
      }
    }

    try {
      const result = await this.service.createSession();

      let message =
        `Browser session started (id: ${result.sessionId}). ` +
        `Use this session_id for subsequent browser tools. ` +
        `Call browser_close when done.`;

      if (url) {
        await this.service.navigate(result.sessionId, url);
        message += ` Navigated to: ${url}`;
      }

      return JSON.stringify({
        success: true,
        session_id: result.sessionId,
        message,
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
      await this.service.navigate(sessionId, url);
      return JSON.stringify({
        success: true,
        result: `Navigated to ${url}. Use browser_get_content to inspect the page.`,
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
      const content = await this.service.getContent(sessionId);
      return JSON.stringify({ success: true, content });
    } catch (err) {
      return JSON.stringify({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async interact(input: Record<string, unknown>): Promise<string> {
    const sessionId = input.session_id as string;
    const action = input.action as "click" | "type" | "select";
    const selector = input.selector as string;
    const value = input.value as string | undefined;

    try {
      switch (action) {
        case "click":
          await this.service.click(sessionId, selector);
          return JSON.stringify({
            success: true,
            result: `Clicked element: ${selector}`,
          });

        case "type":
          if (value === undefined) {
            return JSON.stringify({
              success: false,
              error: "browser_interact with action=type requires a value",
            });
          }
          await this.service.fill(sessionId, selector, value);
          return JSON.stringify({
            success: true,
            result: `Typed into: ${selector}`,
          });

        case "select":
          if (value === undefined) {
            return JSON.stringify({
              success: false,
              error: "browser_interact with action=select requires a value",
            });
          }
          await this.service.select(sessionId, selector, value);
          return JSON.stringify({
            success: true,
            result: `Selected option "${value}" in: ${selector}`,
          });

        default:
          return JSON.stringify({
            success: false,
            error: `Unknown action: ${action}. Must be one of: click, type, select`,
          });
      }
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
      const filePath = await this.service.screenshot(sessionId, fullPage);
      return JSON.stringify({
        success: true,
        file_path: filePath,
        message: `Screenshot saved to ${filePath}`,
        output_files: [{ name: basename(filePath), path: filePath, mimeType: "image/jpeg" }],
      });
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

  // ─── URL validation (SSRF protection) ────────────────────────────────────────

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

    // Strip IPv6 brackets so regexes can match bare addresses: [::1] → ::1
    const hostname = urlObj.hostname.toLowerCase().replace(/^\[(.+)\]$/, "$1");

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
