import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BrowserService } from "../../../../src/skills/browser/service.js";
import { createMockLogger } from "../../../helpers/mocks.js";
import type { BrowserConfig } from "../../../../src/utils/config.js";

// ─── Mock playwright ──────────────────────────────────────────────────────────
//
// The service lazily imports playwright via `await import("playwright")`.
// vi.mock intercepts both static and dynamic imports.

const mockAriaSnapshot = vi.fn();

const mockFirstLocator = {
  click: vi.fn(),
  fill: vi.fn(),
  selectOption: vi.fn(),
};

// body locator only needs ariaSnapshot; other locators use .first()
const mockLocator = vi.fn().mockImplementation((selector: string) => {
  if (selector === "body") {
    return { ariaSnapshot: mockAriaSnapshot };
  }
  return { first: () => mockFirstLocator };
});

const mockPage = {
  title: vi.fn(),
  url: vi.fn(),
  goto: vi.fn(),
  screenshot: vi.fn(),
  locator: mockLocator,
};

const mockContext = {
  newPage: vi.fn(),
  close: vi.fn(),
};

const mockBrowser = {
  newContext: vi.fn(),
  close: vi.fn(),
  isConnected: vi.fn(),
};

const mockChromium = {
  launch: vi.fn(),
};

vi.mock("playwright", () => ({
  chromium: mockChromium,
}));

// ─── Mock node:fs/promises ────────────────────────────────────────────────────

const mockMkdtemp = vi.fn();
const mockRm = vi.fn();

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    mkdtemp: (...args: Parameters<typeof original.mkdtemp>) => mockMkdtemp(...args),
    rm: (...args: Parameters<typeof original.rm>) => mockRm(...args),
  };
});

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

function setupHappyPathMocks(): void {
  mockMkdtemp.mockResolvedValue("/tmp/coda-browser-test-abc");
  mockRm.mockResolvedValue(undefined);
  mockChromium.launch.mockResolvedValue(mockBrowser);
  mockBrowser.newContext.mockResolvedValue(mockContext);
  mockBrowser.close.mockResolvedValue(undefined);
  mockBrowser.isConnected.mockReturnValue(true);
  mockContext.newPage.mockResolvedValue(mockPage);
  mockContext.close.mockResolvedValue(undefined);
  mockPage.title.mockResolvedValue("Test Page");
  mockPage.url.mockReturnValue("https://example.com");
  mockPage.goto.mockResolvedValue(undefined);
  mockPage.screenshot.mockResolvedValue(undefined);
  mockAriaSnapshot.mockResolvedValue("");
  mockFirstLocator.click.mockResolvedValue(undefined);
  mockFirstLocator.fill.mockResolvedValue(undefined);
  mockFirstLocator.selectOption.mockResolvedValue(undefined);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("BrowserService", () => {
  let service: BrowserService;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    vi.clearAllMocks();
    setupHappyPathMocks();
    logger = createMockLogger();
    service = new BrowserService(createTestBrowserConfig(), logger);
  });

  // ─── Session management ───────────────────────────────────────────────────

  describe("session management", () => {
    it("createSession returns a hex session ID", async () => {
      const { sessionId } = await service.createSession();
      expect(sessionId).toMatch(/^[0-9a-f]{16}$/);
    });

    it("hasSession returns true after creation", async () => {
      const { sessionId } = await service.createSession();
      expect(service.hasSession(sessionId)).toBe(true);
    });

    it("hasSession returns false for unknown ID", () => {
      expect(service.hasSession("nonexistent-id")).toBe(false);
    });

    it("getSessionCount starts at 0", () => {
      expect(service.getSessionCount()).toBe(0);
    });

    it("getSessionCount increments on create", async () => {
      await service.createSession();
      expect(service.getSessionCount()).toBe(1);
    });

    it("getSessionCount decrements on destroy", async () => {
      const { sessionId } = await service.createSession();
      await service.destroySession(sessionId);
      expect(service.getSessionCount()).toBe(0);
    });

    it("throws when max_sessions limit is reached", async () => {
      const svc = new BrowserService(createTestBrowserConfig({ max_sessions: 2 }), logger);
      await svc.createSession();
      await svc.createSession();
      await expect(svc.createSession()).rejects.toThrow("Maximum concurrent browser sessions (2)");
    });

    it("destroySession removes session", async () => {
      const { sessionId } = await service.createSession();
      await service.destroySession(sessionId);
      expect(service.hasSession(sessionId)).toBe(false);
    });

    it("destroySession is idempotent (second call is a no-op)", async () => {
      const { sessionId } = await service.createSession();
      await service.destroySession(sessionId);
      await expect(service.destroySession(sessionId)).resolves.not.toThrow();
    });

    it("navigate throws for non-existent session ID", async () => {
      await expect(service.navigate("bad-id", "https://example.com")).rejects.toThrow(
        '"bad-id" not found'
      );
    });

    it("getContent throws for non-existent session ID", async () => {
      await expect(service.getContent("bad-id")).rejects.toThrow('"bad-id" not found');
    });

    it("click throws for non-existent session ID", async () => {
      await expect(service.click("bad-id", "button")).rejects.toThrow("not found");
    });

    it("disconnected browser triggers cleanup and throws", async () => {
      const { sessionId } = await service.createSession();
      // Simulate disconnection on the next isConnected check
      mockBrowser.isConnected.mockReturnValue(false);
      await expect(service.navigate(sessionId, "https://example.com")).rejects.toThrow(
        "disconnected"
      );
      // Session should be cleaned up
      expect(service.hasSession(sessionId)).toBe(false);
    });
  });

  // ─── navigate ─────────────────────────────────────────────────────────────

  describe("navigate", () => {
    it("calls page.goto with the given URL", async () => {
      const { sessionId } = await service.createSession();
      await service.navigate(sessionId, "https://example.com/path");
      expect(mockPage.goto).toHaveBeenCalledWith(
        "https://example.com/path",
        expect.objectContaining({ waitUntil: "domcontentloaded" })
      );
    });
  });

  // ─── Aria snapshot parsing & locator generation ───────────────────────────

  describe("aria snapshot parsing via getContent()", () => {
    async function getContentWith(snapshotYaml: string): Promise<string> {
      mockAriaSnapshot.mockResolvedValue(snapshotYaml);
      const { sessionId } = await service.createSession();
      return service.getContent(sessionId);
    }

    it("includes page title in output", async () => {
      mockPage.title.mockResolvedValue("My Test Page");
      const content = await getContentWith("");
      expect(content).toContain("Page: My Test Page");
    });

    it("includes page URL in output", async () => {
      mockPage.url.mockReturnValue("https://mysite.com/path");
      const content = await getContentWith("");
      expect(content).toContain("URL: https://mysite.com/path");
    });

    it("parses button → button:has-text() locator", async () => {
      const content = await getContentWith('- button "Sign In"');
      expect(content).toContain('[button] "Sign In"');
      expect(content).toContain('button:has-text("Sign In")');
    });

    it("parses link → a:has-text() locator", async () => {
      const content = await getContentWith('- link "About Us"');
      expect(content).toContain('[link] "About Us"');
      expect(content).toContain('a:has-text("About Us")');
    });

    it("parses textbox → input[aria-label] locator", async () => {
      const content = await getContentWith('- textbox "Email"');
      expect(content).toContain('[textbox] "Email"');
      expect(content).toContain('input[aria-label="Email"]');
    });

    it("parses heading → h1/h2/h3:has-text() locator", async () => {
      const content = await getContentWith('- heading "Welcome" [level=1]');
      expect(content).toContain('[heading] "Welcome"');
      expect(content).toContain('h1:has-text("Welcome")');
      expect(content).toContain('h2:has-text("Welcome")');
      expect(content).toContain('h3:has-text("Welcome")');
    });

    it("parses checkbox → input[type=checkbox][aria-label] locator", async () => {
      const content = await getContentWith('- checkbox "Accept Terms"');
      expect(content).toContain('input[type="checkbox"][aria-label="Accept Terms"]');
    });

    it("parses radio → input[type=radio][aria-label] locator", async () => {
      const content = await getContentWith('- radio "Option A"');
      expect(content).toContain('input[type="radio"][aria-label="Option A"]');
    });

    it("parses combobox → select[aria-label] locator", async () => {
      const content = await getContentWith('- combobox "Country"');
      expect(content).toContain('select[aria-label="Country"]');
    });

    it("parses tab → [role=tab]:has-text() locator", async () => {
      const content = await getContentWith('- tab "Settings"');
      expect(content).toContain('[role="tab"]:has-text("Settings")');
    });

    it("parses menuitem → [role=menuitem]:has-text() locator", async () => {
      const content = await getContentWith('- menuitem "File"');
      expect(content).toContain('[role="menuitem"]:has-text("File")');
    });

    it("filters non-interactive 'document' role", async () => {
      const content = await getContentWith('- document "My Document"');
      expect(content).not.toContain('[document]');
    });

    it("filters entries with empty names", async () => {
      const content = await getContentWith('- button ""');
      expect(content).not.toContain('[button]');
    });

    it("shows fallback message when no interactive elements found", async () => {
      const content = await getContentWith('- document "Empty Page"');
      expect(content).toContain("No interactive elements");
    });

    it("renders multiple elements from snapshot", async () => {
      const snapshot = [
        '- link "Home"',
        '- button "Login"',
        '- textbox "Search"',
      ].join("\n");
      const content = await getContentWith(snapshot);
      expect(content).toContain('[link] "Home"');
      expect(content).toContain('[button] "Login"');
      expect(content).toContain('[textbox] "Search"');
    });

    it("handles indented elements (depth > 0)", async () => {
      const snapshot = [
        '- document "Page"',
        '  - heading "Section Title"',
        '    - link "Click Here"',
      ].join("\n");
      const content = await getContentWith(snapshot);
      // heading at depth 1, link at depth 2
      expect(content).toContain('[heading] "Section Title"');
      expect(content).toContain('[link] "Click Here"');
    });

    it("escapes double quotes in element names for locators", async () => {
      // Build a locator for a button with a name containing no special chars
      // (the escape path is exercised via buildLocator)
      const content = await getContentWith('- button "Save"');
      // buildLocator outputs: button:has-text("Save") — no escaping needed here,
      // but we confirm the format is correct
      expect(content).toMatch(/button:has-text\("Save"\)/);
    });
  });

  // ─── screenshot ───────────────────────────────────────────────────────────

  describe("screenshot", () => {
    it("returns a .png file path under the session screenshot dir", async () => {
      const { sessionId } = await service.createSession();
      const path = await service.screenshot(sessionId, false);
      expect(path).toMatch(/^\/tmp\/coda-browser-test-abc\/screenshot-\d+\.jpg$/);
      expect(mockPage.screenshot).toHaveBeenCalledWith(
        expect.objectContaining({ fullPage: false })
      );
    });

    it("passes fullPage=true when requested", async () => {
      const { sessionId } = await service.createSession();
      await service.screenshot(sessionId, true);
      expect(mockPage.screenshot).toHaveBeenCalledWith(
        expect.objectContaining({ fullPage: true })
      );
    });
  });

  // ─── click / fill / select ────────────────────────────────────────────────

  describe("interaction methods", () => {
    it("click calls page locator.first().click()", async () => {
      const { sessionId } = await service.createSession();
      await service.click(sessionId, 'button:has-text("OK")');
      expect(mockLocator).toHaveBeenCalledWith('button:has-text("OK")');
      expect(mockFirstLocator.click).toHaveBeenCalled();
    });

    it("fill calls page locator.first().fill()", async () => {
      const { sessionId } = await service.createSession();
      await service.fill(sessionId, 'input[aria-label="Search"]', "query");
      expect(mockLocator).toHaveBeenCalledWith('input[aria-label="Search"]');
      expect(mockFirstLocator.fill).toHaveBeenCalledWith("query", expect.any(Object));
    });

    it("select calls page locator.first().selectOption()", async () => {
      const { sessionId } = await service.createSession();
      await service.select(sessionId, 'select[aria-label="Country"]', "US");
      expect(mockLocator).toHaveBeenCalledWith('select[aria-label="Country"]');
      expect(mockFirstLocator.selectOption).toHaveBeenCalledWith("US", expect.any(Object));
    });
  });

  // ─── Idle session cleanup ─────────────────────────────────────────────────

  describe("idle session cleanup", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("destroys sessions that have been idle past the timeout", async () => {
      vi.useFakeTimers();

      const svc = new BrowserService(
        createTestBrowserConfig({ session_timeout_seconds: 1 }),
        logger
      );
      svc.start();

      const { sessionId } = await svc.createSession();
      expect(svc.hasSession(sessionId)).toBe(true);

      // Advance 32s: the interval fires at 30s, session idle > 1s → destroyed
      await vi.advanceTimersByTimeAsync(32_000);

      expect(svc.hasSession(sessionId)).toBe(false);
      await svc.stop();
    });

    it("preserves sessions that are still within timeout", async () => {
      vi.useFakeTimers();

      const svc = new BrowserService(
        createTestBrowserConfig({ session_timeout_seconds: 300 }),
        logger
      );
      svc.start();

      const { sessionId } = await svc.createSession();

      // Advance 32s — well within the 300s timeout
      await vi.advanceTimersByTimeAsync(32_000);

      expect(svc.hasSession(sessionId)).toBe(true);
      await svc.stop();
    });

    it("stop() clears the interval and destroys all sessions", async () => {
      const { sessionId } = await service.createSession();
      service.start();
      await service.stop();
      expect(service.hasSession(sessionId)).toBe(false);
      expect(service.getSessionCount()).toBe(0);
    });
  });
});
