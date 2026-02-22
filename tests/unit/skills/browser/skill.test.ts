import { describe, it, expect, vi, beforeEach } from "vitest";
import { BrowserSkill } from "../../../../src/skills/browser/skill.js";
import { createMockLogger, createMockSkillContext } from "../../../helpers/mocks.js";
import type { BrowserConfig } from "../../../../src/utils/config.js";

// ─── Mock BrowserService ──────────────────────────────────────────────────────

const mockCreateSession = vi.fn();
const mockNavigate = vi.fn();
const mockGetContent = vi.fn();
const mockClick = vi.fn();
const mockFill = vi.fn();
const mockSelect = vi.fn();
const mockScreenshot = vi.fn();
const mockDestroySession = vi.fn();
const mockStart = vi.fn();
const mockStop = vi.fn();

const mockServiceInstance = {
  createSession: mockCreateSession,
  navigate: mockNavigate,
  getContent: mockGetContent,
  click: mockClick,
  fill: mockFill,
  select: mockSelect,
  screenshot: mockScreenshot,
  destroySession: mockDestroySession,
  start: mockStart,
  stop: mockStop,
};

vi.mock("../../../../src/skills/browser/service.js", () => ({
  BrowserService: vi.fn().mockImplementation(() => mockServiceInstance),
}));

// ─── Test helpers ─────────────────────────────────────────────────────────────

function createTestBrowserConfig(overrides: Partial<BrowserConfig> = {}): BrowserConfig {
  return {
    enabled: true,
    mode: "host",
    docker_socket: "/var/run/docker.sock",
    image: "coda-browser-sandbox",
    sandbox_network: "coda-browser-sandbox",
    max_sessions: 3,
    session_timeout_seconds: 300,
    tool_timeout_ms: 30000,
    connect_timeout_ms: 15000,
    connect_retries: 3,
    headless: true,
    url_allowlist: [],
    url_blocklist: [],
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("BrowserSkill", () => {
  let skill: BrowserSkill;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(async () => {
    vi.clearAllMocks();
    logger = createMockLogger();
    skill = new BrowserSkill(createTestBrowserConfig(), logger);
    await skill.startup(createMockSkillContext("browser"));
  });

  // ─── Metadata & tool registration ───────────────────────────────────────────

  describe("metadata", () => {
    it("has name 'browser'", () => {
      expect(skill.name).toBe("browser");
    });

    it("returns 6 tools", () => {
      expect(skill.getTools()).toHaveLength(6);
    });

    it("returns tools in expected order", () => {
      expect(skill.getTools().map((t) => t.name)).toEqual([
        "browser_open",
        "browser_navigate",
        "browser_get_content",
        "browser_interact",
        "browser_screenshot",
        "browser_close",
      ]);
    });

    it("browser_close is tier 0", () => {
      const tool = skill.getTools().find((t) => t.name === "browser_close");
      expect(tool?.permissionTier).toBe(0);
    });

    it("browser_screenshot is tier 1", () => {
      const tool = skill.getTools().find((t) => t.name === "browser_screenshot");
      expect(tool?.permissionTier).toBe(1);
    });

    it("browser_get_content is tier 1", () => {
      const tool = skill.getTools().find((t) => t.name === "browser_get_content");
      expect(tool?.permissionTier).toBe(1);
    });

    it("browser_open is tier 2", () => {
      const tool = skill.getTools().find((t) => t.name === "browser_open");
      expect(tool?.permissionTier).toBe(2);
    });

    it("browser_navigate is tier 2 with requiresCritique", () => {
      const tool = skill.getTools().find((t) => t.name === "browser_navigate");
      expect(tool?.permissionTier).toBe(2);
      expect(tool?.requiresCritique).toBe(true);
    });

    it("browser_interact is tier 2 and sensitive", () => {
      const tool = skill.getTools().find((t) => t.name === "browser_interact");
      expect(tool?.permissionTier).toBe(2);
      expect(tool?.sensitive).toBe(true);
    });

    it("getRequiredConfig returns empty array", () => {
      expect(skill.getRequiredConfig()).toEqual([]);
    });
  });

  // ─── Unknown tool ────────────────────────────────────────────────────────────

  describe("unknown tool", () => {
    it("returns error for unrecognised tool name", async () => {
      const result = JSON.parse(await skill.execute("browser_unknown", {}));
      expect(result.success).toBe(false);
      expect(result.error).toContain("Unknown tool");
    });
  });

  // ─── SSRF / URL validation via browser_navigate ───────────────────────────

  describe("URL validation (browser_navigate)", () => {
    async function assertBlocked(url: string): Promise<void> {
      vi.clearAllMocks();
      const result = JSON.parse(
        await skill.execute("browser_navigate", { session_id: "s1", url })
      );
      expect(result.success, `Expected "${url}" to be blocked`).toBe(false);
      expect(mockNavigate, `Service navigate should not be called for "${url}"`).not.toHaveBeenCalled();
    }

    // Private IP ranges
    it("blocks 127.0.0.1 loopback", () => assertBlocked("http://127.0.0.1/"));
    it("blocks 127.x.x.x range", () => assertBlocked("http://127.1.2.3/admin"));
    it("blocks 10.x private range", () => assertBlocked("http://10.0.0.1/"));
    it("blocks 192.168.x.x private range", () => assertBlocked("http://192.168.1.100/"));
    it("blocks 172.16.x private range", () => assertBlocked("http://172.16.0.1/"));
    it("blocks 172.31.x private range", () => assertBlocked("http://172.31.255.255/"));
    it("blocks 169.254.x link-local (IMDS)", () => assertBlocked("http://169.254.169.254/latest/meta-data/"));
    it("blocks IPv6 loopback ::1", () => assertBlocked("http://[::1]/"));
    it("blocks IPv6 ULA fc00::", () => assertBlocked("http://[fc00::1]/"));
    it("blocks IPv6 ULA fd00::", () => assertBlocked("http://[fd00::1]/"));

    // Internal hostnames
    it("blocks localhost", () => assertBlocked("http://localhost/"));
    it("blocks *.local domain", () => assertBlocked("http://mymachine.local/"));
    it("blocks *.internal domain", () => assertBlocked("http://api.internal/"));
    it("blocks redis hostname", () => assertBlocked("http://redis/"));
    it("blocks postgres hostname", () => assertBlocked("http://postgres/"));
    it("blocks coda- prefixed hostname", () => assertBlocked("http://coda-api/"));
    it("blocks coda_ prefixed hostname", () => assertBlocked("http://coda_service/"));

    // Disallowed protocols
    it("blocks ftp:// protocol", () => assertBlocked("ftp://example.com/file"));
    it("blocks file:// protocol", () => assertBlocked("file:///etc/passwd"));
    it("blocks javascript: protocol", () => assertBlocked("javascript:alert(1)"));

    // Malformed
    it("rejects malformed URL", () => assertBlocked("not-a-url"));
    it("rejects empty string URL", () => assertBlocked(""));

    // Should allow
    it("allows https://example.com", async () => {
      mockNavigate.mockResolvedValue(undefined);
      const result = JSON.parse(
        await skill.execute("browser_navigate", { session_id: "s1", url: "https://example.com" })
      );
      expect(result.success).toBe(true);
      expect(mockNavigate).toHaveBeenCalledWith("s1", "https://example.com");
    });

    it("allows http://example.com", async () => {
      mockNavigate.mockResolvedValue(undefined);
      const result = JSON.parse(
        await skill.execute("browser_navigate", { session_id: "s1", url: "http://example.com" })
      );
      expect(result.success).toBe(true);
    });
  });

  // ─── Configurable blocklist ───────────────────────────────────────────────

  describe("configurable blocklist", () => {
    let blockedSkill: BrowserSkill;

    beforeEach(async () => {
      blockedSkill = new BrowserSkill(
        createTestBrowserConfig({ url_blocklist: ["evil.com"] }),
        logger
      );
      await blockedSkill.startup(createMockSkillContext("browser"));
    });

    it("blocks exact domain match", async () => {
      const result = JSON.parse(
        await blockedSkill.execute("browser_navigate", { session_id: "s1", url: "https://evil.com/" })
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("blocklist");
    });

    it("blocks subdomain of blocked domain", async () => {
      const result = JSON.parse(
        await blockedSkill.execute("browser_navigate", { session_id: "s1", url: "https://sub.evil.com/" })
      );
      expect(result.success).toBe(false);
    });

    it("allows unblocked domains", async () => {
      mockNavigate.mockResolvedValue(undefined);
      const result = JSON.parse(
        await blockedSkill.execute("browser_navigate", { session_id: "s1", url: "https://good.com/" })
      );
      expect(result.success).toBe(true);
    });
  });

  // ─── Configurable allowlist ───────────────────────────────────────────────

  describe("configurable allowlist", () => {
    let allowedSkill: BrowserSkill;

    beforeEach(async () => {
      allowedSkill = new BrowserSkill(
        createTestBrowserConfig({ url_allowlist: ["allowed.com"] }),
        logger
      );
      await allowedSkill.startup(createMockSkillContext("browser"));
    });

    it("blocks domain not in allowlist", async () => {
      const result = JSON.parse(
        await allowedSkill.execute("browser_navigate", { session_id: "s1", url: "https://other.com/" })
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("allowlist");
    });

    it("allows listed domain", async () => {
      mockNavigate.mockResolvedValue(undefined);
      const result = JSON.parse(
        await allowedSkill.execute("browser_navigate", { session_id: "s1", url: "https://allowed.com/page" })
      );
      expect(result.success).toBe(true);
    });

    it("allows subdomain of listed domain", async () => {
      mockNavigate.mockResolvedValue(undefined);
      const result = JSON.parse(
        await allowedSkill.execute("browser_navigate", { session_id: "s1", url: "https://www.allowed.com/" })
      );
      expect(result.success).toBe(true);
    });
  });

  // ─── browser_open URL validation ──────────────────────────────────────────

  describe("browser_open with URL", () => {
    it("blocks private IP without creating session", async () => {
      const result = JSON.parse(
        await skill.execute("browser_open", { url: "http://192.168.1.1/" })
      );
      expect(result.success).toBe(false);
      expect(mockCreateSession).not.toHaveBeenCalled();
    });

    it("creates session and navigates for valid URL", async () => {
      mockCreateSession.mockResolvedValue({ sessionId: "sess-abc" });
      mockNavigate.mockResolvedValue(undefined);
      const result = JSON.parse(
        await skill.execute("browser_open", { url: "https://example.com" })
      );
      expect(result.success).toBe(true);
      expect(result.session_id).toBe("sess-abc");
      expect(mockNavigate).toHaveBeenCalledWith("sess-abc", "https://example.com");
    });

    it("creates session without URL (no navigate call)", async () => {
      mockCreateSession.mockResolvedValue({ sessionId: "sess-xyz" });
      const result = JSON.parse(await skill.execute("browser_open", {}));
      expect(result.success).toBe(true);
      expect(result.session_id).toBe("sess-xyz");
      expect(mockNavigate).not.toHaveBeenCalled();
    });
  });

  // ─── browser_interact input validation ────────────────────────────────────

  describe("browser_interact input validation", () => {
    it("returns error when action=type but no value", async () => {
      const result = JSON.parse(
        await skill.execute("browser_interact", {
          session_id: "s1",
          action: "type",
          selector: "input[name='q']",
        })
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("value");
    });

    it("returns error when action=select but no value", async () => {
      const result = JSON.parse(
        await skill.execute("browser_interact", {
          session_id: "s1",
          action: "select",
          selector: "select[name='country']",
        })
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("value");
    });

    it("returns error for unknown action", async () => {
      const result = JSON.parse(
        await skill.execute("browser_interact", {
          session_id: "s1",
          action: "hover",
          selector: "button",
        })
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("Unknown action");
    });

    it("delegates click to service.click", async () => {
      mockClick.mockResolvedValue(undefined);
      const result = JSON.parse(
        await skill.execute("browser_interact", {
          session_id: "s1",
          action: "click",
          selector: 'button:has-text("Submit")',
        })
      );
      expect(result.success).toBe(true);
      expect(mockClick).toHaveBeenCalledWith("s1", 'button:has-text("Submit")');
    });

    it("delegates type+value to service.fill", async () => {
      mockFill.mockResolvedValue(undefined);
      const result = JSON.parse(
        await skill.execute("browser_interact", {
          session_id: "s1",
          action: "type",
          selector: "input[name='q']",
          value: "hello world",
        })
      );
      expect(result.success).toBe(true);
      expect(mockFill).toHaveBeenCalledWith("s1", "input[name='q']", "hello world");
    });

    it("delegates select+value to service.select", async () => {
      mockSelect.mockResolvedValue(undefined);
      const result = JSON.parse(
        await skill.execute("browser_interact", {
          session_id: "s1",
          action: "select",
          selector: "select[name='country']",
          value: "US",
        })
      );
      expect(result.success).toBe(true);
      expect(mockSelect).toHaveBeenCalledWith("s1", "select[name='country']", "US");
    });
  });

  // ─── browser_close ────────────────────────────────────────────────────────

  describe("browser_close", () => {
    it("delegates to service.destroySession", async () => {
      mockDestroySession.mockResolvedValue(undefined);
      const result = JSON.parse(
        await skill.execute("browser_close", { session_id: "sess-1" })
      );
      expect(result.success).toBe(true);
      expect(mockDestroySession).toHaveBeenCalledWith("sess-1");
    });
  });

  // ─── browser_screenshot ───────────────────────────────────────────────────

  describe("browser_screenshot", () => {
    it("delegates to service.screenshot with full_page=false by default", async () => {
      mockScreenshot.mockResolvedValue("/tmp/screenshot-123.png");
      const result = JSON.parse(
        await skill.execute("browser_screenshot", { session_id: "sess-1" })
      );
      expect(result.success).toBe(true);
      expect(result.file_path).toBe("/tmp/screenshot-123.png");
      expect(mockScreenshot).toHaveBeenCalledWith("sess-1", false);
    });

    it("passes full_page=true when specified", async () => {
      mockScreenshot.mockResolvedValue("/tmp/screenshot-full.png");
      await skill.execute("browser_screenshot", { session_id: "sess-1", full_page: true });
      expect(mockScreenshot).toHaveBeenCalledWith("sess-1", true);
    });
  });

  // ─── browser_get_content ─────────────────────────────────────────────────

  describe("browser_get_content", () => {
    it("delegates to service.getContent", async () => {
      mockGetContent.mockResolvedValue("Page: Test\nURL: https://example.com");
      const result = JSON.parse(
        await skill.execute("browser_get_content", { session_id: "sess-1" })
      );
      expect(result.success).toBe(true);
      expect(result.content).toContain("Test");
      expect(mockGetContent).toHaveBeenCalledWith("sess-1");
    });
  });

  // ─── shutdown ─────────────────────────────────────────────────────────────

  describe("shutdown", () => {
    it("calls service.stop()", async () => {
      mockStop.mockResolvedValue(undefined);
      await skill.shutdown();
      expect(mockStop).toHaveBeenCalled();
    });
  });
});
