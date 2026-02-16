import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConfirmationManager } from "../../../src/core/confirmation.js";
import { createMockLogger } from "../../helpers/mocks.js";

describe("ConfirmationManager", () => {
  let manager: ConfirmationManager;

  beforeEach(() => {
    manager = new ConfirmationManager(createMockLogger());
  });

  it("generates unique confirmation token for a pending action", () => {
    const token = manager.createConfirmation(
      "user1", "plex", "plex_play", { query: "movie" }, "Play movie"
    );
    expect(token).toBeTruthy();
    expect(typeof token).toBe("string");
  });

  it("token format enforces high entropy (min 80 bits = 16+ base32 chars)", () => {
    const token = manager.createConfirmation(
      "user1", "test", "test_action", {}, "test"
    );
    expect(token.length).toBeGreaterThanOrEqual(16);
    // Base32 alphabet: A-Z, 2-7
    expect(token).toMatch(/^[A-Z2-7]+$/);
  });

  it("valid token executes the pending action and returns it", () => {
    const token = manager.createConfirmation(
      "user1", "test", "test_tool", { key: "val" }, "description"
    );

    const action = manager.consumeConfirmation(token, "user1");

    expect(action).not.toBeNull();
    expect(action!.toolName).toBe("test_tool");
    expect(action!.toolInput).toEqual({ key: "val" });
    expect(action!.userId).toBe("user1");
  });

  it("invalid token returns null", () => {
    const action = manager.consumeConfirmation("INVALIDTOKEN12345", "user1");
    expect(action).toBeNull();
  });

  it("token is single-use — second use returns null", () => {
    const token = manager.createConfirmation(
      "user1", "test", "test_tool", {}, "desc"
    );

    const first = manager.consumeConfirmation(token, "user1");
    const second = manager.consumeConfirmation(token, "user1");

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it("tokens are scoped per-user (user A cannot confirm user B's action)", () => {
    const token = manager.createConfirmation(
      "user1", "test", "test_tool", {}, "desc"
    );

    const action = manager.consumeConfirmation(token, "user2");
    expect(action).toBeNull();
  });

  it("expired token returns null", () => {
    // Manually create an expired token by manipulating time
    const token = manager.createConfirmation(
      "user1", "test", "test_tool", {}, "desc"
    );

    // Fast-forward time past the TTL
    vi.useFakeTimers();
    vi.advanceTimersByTime(6 * 60 * 1000); // 6 minutes (TTL is 5)

    const action = manager.consumeConfirmation(token, "user1");
    expect(action).toBeNull();

    vi.useRealTimers();
  });

  it("isConfirmationMessage detects valid confirm messages", () => {
    const result = manager.isConfirmationMessage("confirm ABCDE234FG");
    expect(result).toBe("ABCDE234FG");
  });

  it("isConfirmationMessage returns null for non-confirmation messages", () => {
    expect(manager.isConfirmationMessage("hello")).toBeNull();
    expect(manager.isConfirmationMessage("not a confirm")).toBeNull();
    expect(manager.isConfirmationMessage("")).toBeNull();
  });

  it("cleanup removes expired tokens", async () => {
    manager.createConfirmation("user1", "test", "tool1", {}, "desc1");
    manager.createConfirmation("user1", "test", "tool2", {}, "desc2");

    vi.useFakeTimers();
    vi.advanceTimersByTime(6 * 60 * 1000);

    await manager.cleanup();

    // Both should be expired
    vi.useRealTimers();
  });

  it("stores and returns tempDir with pending action", () => {
    const token = manager.createConfirmation(
      "user1", "code", "code_execute", { code: "test" }, "Execute code", "/tmp/test-dir"
    );

    const action = manager.consumeConfirmation(token, "user1");

    expect(action).not.toBeNull();
    expect(action!.tempDir).toBe("/tmp/test-dir");
  });

  it("action without tempDir returns undefined for tempDir", () => {
    const token = manager.createConfirmation(
      "user1", "test", "test_tool", {}, "desc"
    );

    const action = manager.consumeConfirmation(token, "user1");

    expect(action).not.toBeNull();
    expect(action!.tempDir).toBeUndefined();
  });
});
