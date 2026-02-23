/**
 * Integration tests for the browser skill against https://books.toscrape.com
 *
 * These tests run in "host" mode — Chromium is launched directly on the host.
 * Requires: npx playwright install chromium
 *
 * Tests are skipped automatically when Chromium is not installed.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { BrowserService } from "../../src/skills/browser/service.js";
import { BrowserSkill } from "../../src/skills/browser/skill.js";
import { createMockLogger, createMockSkillContext } from "../helpers/mocks.js";
import type { BrowserConfig } from "../../src/utils/config.js";

// ─── Chromium availability check ─────────────────────────────────────────────

let canRun = false;
try {
  const { chromium } = await import("playwright");
  const b = await chromium.launch({ headless: true });
  await b.close();
  canRun = true;
} catch {
  // Playwright or Chromium not installed — tests will be skipped
}

const describeIf = canRun ? describe : describe.skip;

// ─── Test config ─────────────────────────────────────────────────────────────

const TARGET_URL = "https://books.toscrape.com";

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

// ─── BrowserService integration tests ────────────────────────────────────────

describeIf("BrowserService integration (books.toscrape.com)", () => {
  let service: BrowserService;
  let sessionId: string;

  beforeAll(async () => {
    service = new BrowserService(createTestBrowserConfig(), createMockLogger());
  });

  afterAll(async () => {
    if (sessionId && service.hasSession(sessionId)) {
      await service.destroySession(sessionId);
    }
    await service.stop();
  });

  it("createSession() returns a session ID", async () => {
    const result = await service.createSession();
    sessionId = result.sessionId;
    expect(sessionId).toMatch(/^[0-9a-f]{16}$/);
    expect(service.hasSession(sessionId)).toBe(true);
  }, 30000);

  it("navigate() loads books.toscrape.com without error", async () => {
    await expect(service.navigate(sessionId, TARGET_URL)).resolves.not.toThrow();
  }, 30000);

  it("getContent() returns page title, URL, and link entries", async () => {
    const content = await service.getContent(sessionId);
    expect(content).toContain("URL:");
    expect(content).toContain("Page:");
    // The site has book links
    expect(content).toContain("[link]");
    expect(content).toContain("a:has-text(");
  }, 30000);

  it("getContent() returns locators the LLM can use", async () => {
    const content = await service.getContent(sessionId);
    // Locators should use → separator
    expect(content).toContain("→");
  }, 30000);

  it("click() navigates to a book detail page", async () => {
    const content = await service.getContent(sessionId);

    // Extract the first book link locator
    const linkMatch = content.match(/\[link\] "([^"]+)" → (a:has-text\("[^"]+"\))/);
    expect(linkMatch, "Expected at least one book link in content").toBeTruthy();

    if (linkMatch) {
      const locator = linkMatch[2];
      await expect(service.click(sessionId, locator!)).resolves.not.toThrow();

      // Should now be on a detail page (URL changed)
      const newContent = await service.getContent(sessionId);
      expect(newContent).toContain("URL:");
    }
  }, 30000);

  it("screenshot() returns a .png path that exists on disk", async () => {
    const filePath = await service.screenshot(sessionId, false);
    expect(filePath).toMatch(/\.png$/);
    expect(existsSync(filePath)).toBe(true);
  }, 30000);

  it("screenshot(fullPage=true) returns a full-page .png that exists", async () => {
    const filePath = await service.screenshot(sessionId, true);
    expect(filePath).toMatch(/\.png$/);
    expect(existsSync(filePath)).toBe(true);
  }, 30000);

  it("destroySession() removes the session", async () => {
    await service.destroySession(sessionId);
    expect(service.hasSession(sessionId)).toBe(false);
  }, 30000);

  it("navigate throws for invalid session after destroy", async () => {
    await expect(service.navigate(sessionId, TARGET_URL)).rejects.toThrow("not found");
  }, 30000);

  it("getContent throws for invalid session after destroy", async () => {
    await expect(service.getContent(sessionId)).rejects.toThrow("not found");
  }, 30000);
});

// ─── BrowserSkill end-to-end integration tests ───────────────────────────────

describeIf("BrowserSkill end-to-end (books.toscrape.com)", () => {
  let skill: BrowserSkill;
  let skillSessionId: string;

  beforeAll(async () => {
    skill = new BrowserSkill(createTestBrowserConfig(), createMockLogger());
    await skill.startup(createMockSkillContext("browser"));
  });

  afterAll(async () => {
    if (skillSessionId) {
      // Attempt cleanup (may already be closed)
      await skill.execute("browser_close", { session_id: skillSessionId }).catch(() => {});
    }
    await skill.shutdown();
  });

  it("browser_open navigates to books.toscrape.com and returns session_id", async () => {
    const result = JSON.parse(
      await skill.execute("browser_open", { url: TARGET_URL })
    );
    expect(result.success).toBe(true);
    expect(result.session_id).toMatch(/^[0-9a-f]{16}$/);
    skillSessionId = result.session_id as string;
  }, 30000);

  it("browser_get_content returns content with book links", async () => {
    const result = JSON.parse(
      await skill.execute("browser_get_content", { session_id: skillSessionId })
    );
    expect(result.success).toBe(true);
    expect(result.content).toContain("[link]");
    expect(result.content).toContain("a:has-text(");
  }, 30000);

  it("browser_close destroys the session and returns success", async () => {
    const result = JSON.parse(
      await skill.execute("browser_close", { session_id: skillSessionId })
    );
    expect(result.success).toBe(true);
  }, 30000);
});
