import { describe, it, expect, beforeEach, vi } from "vitest";
import { PreferencesManager } from "../../../src/core/preferences.js";
import { createMockLogger, createMockDatabase } from "../../helpers/mocks.js";

describe("PreferencesManager", () => {
  let manager: PreferencesManager;
  let mockDb: ReturnType<typeof createMockDatabase>;

  beforeEach(() => {
    mockDb = createMockDatabase();
    manager = new PreferencesManager(
      mockDb as unknown as Parameters<typeof PreferencesManager.prototype["getPreferences"]> extends never[] ? never : any,
      createMockLogger()
    );
  });

  describe("getPreferences", () => {
    it("returns defaults for unknown user", async () => {
      mockDb._setResults([]);
      const prefs = await manager.getPreferences("user1");
      expect(prefs.userId).toBe("user1");
      expect(prefs.dndEnabled).toBe(false);
      expect(prefs.alertsOnly).toBe(false);
      expect(prefs.quietHoursStart).toBeNull();
      expect(prefs.quietHoursEnd).toBeNull();
      expect(prefs.timezone).toBe("America/New_York");
    });

    it("returns stored preferences", async () => {
      mockDb._setResults([
        {
          userId: "user1",
          dndEnabled: true,
          alertsOnly: false,
          quietHoursStart: "22:00",
          quietHoursEnd: "07:00",
          timezone: "America/Chicago",
        },
      ]);

      const prefs = await manager.getPreferences("user1");
      expect(prefs.dndEnabled).toBe(true);
      expect(prefs.quietHoursStart).toBe("22:00");
      expect(prefs.quietHoursEnd).toBe("07:00");
      expect(prefs.timezone).toBe("America/Chicago");
    });
  });

  describe("shouldSuppressAlert", () => {
    it("suppresses non-system alerts when DND enabled", async () => {
      // Populate cache directly since our mock DB is complex
      mockDb._setResults([
        {
          userId: "user1",
          dndEnabled: true,
          alertsOnly: false,
          quietHoursStart: null,
          quietHoursEnd: null,
          timezone: "America/New_York",
        },
      ]);

      // First call populates cache
      await manager.getPreferences("user1");

      expect(await manager.shouldSuppressAlert("user1", "high")).toBe(true);
      expect(await manager.shouldSuppressAlert("user1", "medium")).toBe(true);
      expect(await manager.shouldSuppressAlert("user1", "low")).toBe(true);
    });

    it("does not suppress system alerts even with DND", async () => {
      mockDb._setResults([
        {
          userId: "user1",
          dndEnabled: true,
          alertsOnly: false,
          quietHoursStart: null,
          quietHoursEnd: null,
          timezone: "America/New_York",
        },
      ]);

      await manager.getPreferences("user1");
      expect(await manager.shouldSuppressAlert("user1", "system")).toBe(false);
    });

    it("does not suppress when DND disabled", async () => {
      mockDb._setResults([
        {
          userId: "user1",
          dndEnabled: false,
          alertsOnly: false,
          quietHoursStart: null,
          quietHoursEnd: null,
          timezone: "America/New_York",
        },
      ]);

      await manager.getPreferences("user1");
      expect(await manager.shouldSuppressAlert("user1", "high")).toBe(false);
    });
  });
});
