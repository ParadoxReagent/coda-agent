import { describe, it, expect } from "vitest";
import { parseNaturalTime } from "../../../../src/skills/reminders/time-parser.js";

// Frozen reference: Wednesday, January 15, 2025 at 10:00 AM
const REF_DATE = new Date("2025-01-15T10:00:00.000Z");
const TIMEZONE = "UTC";

describe("parseNaturalTime", () => {
  describe("relative time", () => {
    it("parses 'in 2 hours'", () => {
      const result = parseNaturalTime("in 2 hours", TIMEZONE, REF_DATE);
      expect(result).not.toBeNull();
      expect(result!.date.getTime()).toBeCloseTo(
        REF_DATE.getTime() + 2 * 3600_000,
        -3 // within 1 second
      );
      expect(result!.isRecurring).toBe(false);
      expect(result!.text).toContain("2 hour");
    });

    it("parses 'in 30 minutes'", () => {
      const result = parseNaturalTime("in 30 minutes", TIMEZONE, REF_DATE);
      expect(result).not.toBeNull();
      expect(result!.date.getTime()).toBeCloseTo(
        REF_DATE.getTime() + 30 * 60_000,
        -3
      );
      expect(result!.isRecurring).toBe(false);
    });

    it("parses 'in 1 hour'", () => {
      const result = parseNaturalTime("in 1 hour", TIMEZONE, REF_DATE);
      expect(result).not.toBeNull();
      expect(result!.date.getTime()).toBeCloseTo(
        REF_DATE.getTime() + 3600_000,
        -3
      );
    });
  });

  describe("absolute time", () => {
    it("parses 'tomorrow at 3pm'", () => {
      const result = parseNaturalTime("tomorrow at 3pm", TIMEZONE, REF_DATE);
      expect(result).not.toBeNull();
      expect(result!.date.getUTCDate()).toBe(16);
      expect(result!.date.getUTCHours()).toBe(15);
      expect(result!.isRecurring).toBe(false);
      expect(result!.text).toContain("tomorrow");
    });

    it("parses 'Friday at 3pm'", () => {
      // Jan 15 is Wednesday, so Friday is Jan 17
      const result = parseNaturalTime("Friday at 3pm", TIMEZONE, REF_DATE);
      expect(result).not.toBeNull();
      expect(result!.date.getUTCDay()).toBe(5); // Friday
      expect(result!.date.getUTCHours()).toBe(15);
      expect(result!.isRecurring).toBe(false);
    });

    it("parses 'January 20 at 9am'", () => {
      const result = parseNaturalTime("January 20 at 9am", TIMEZONE, REF_DATE);
      expect(result).not.toBeNull();
      expect(result!.date.getUTCDate()).toBe(20);
      expect(result!.date.getUTCHours()).toBe(9);
    });
  });

  describe("recurring time", () => {
    it("parses 'every day at 9am'", () => {
      const result = parseNaturalTime("every day at 9am", TIMEZONE, REF_DATE);
      expect(result).not.toBeNull();
      expect(result!.isRecurring).toBe(true);
      expect(result!.cronExpression).toBe("0 9 * * *");
      expect(result!.text).toContain("daily");
      expect(result!.text).toContain("9:00 AM");
    });

    it("parses 'every day at 2:30pm'", () => {
      const result = parseNaturalTime(
        "every day at 2:30pm",
        TIMEZONE,
        REF_DATE
      );
      expect(result).not.toBeNull();
      expect(result!.isRecurring).toBe(true);
      expect(result!.cronExpression).toBe("30 14 * * *");
      expect(result!.text).toContain("daily");
    });

    it("parses 'every Monday at 9am'", () => {
      const result = parseNaturalTime(
        "every Monday at 9am",
        TIMEZONE,
        REF_DATE
      );
      expect(result).not.toBeNull();
      expect(result!.isRecurring).toBe(true);
      expect(result!.cronExpression).toBe("0 9 * * 1");
      expect(result!.text).toContain("every monday");
      expect(result!.date.getDay()).toBe(1); // Monday
    });

    it("parses 'every Friday at 5pm'", () => {
      const result = parseNaturalTime(
        "every Friday at 5pm",
        TIMEZONE,
        REF_DATE
      );
      expect(result).not.toBeNull();
      expect(result!.isRecurring).toBe(true);
      expect(result!.cronExpression).toBe("0 17 * * 5");
    });

    it("parses 'every 2 hours'", () => {
      const result = parseNaturalTime("every 2 hours", TIMEZONE, REF_DATE);
      expect(result).not.toBeNull();
      expect(result!.isRecurring).toBe(true);
      expect(result!.cronExpression).toBe("0 */2 * * *");
      expect(result!.text).toContain("every 2 hours");
    });

    it("parses 'every 30 minutes'", () => {
      const result = parseNaturalTime("every 30 minutes", TIMEZONE, REF_DATE);
      expect(result).not.toBeNull();
      expect(result!.isRecurring).toBe(true);
      expect(result!.cronExpression).toBe("*/30 * * * *");
      expect(result!.text).toContain("every 30 minutes");
    });
  });

  describe("edge cases", () => {
    it("returns null for unparseable input", () => {
      const result = parseNaturalTime("not a time", TIMEZONE, REF_DATE);
      expect(result).toBeNull();
    });

    it("returns null for empty string", () => {
      const result = parseNaturalTime("", TIMEZONE, REF_DATE);
      expect(result).toBeNull();
    });

    it("daily recurring sets next day if time has passed", () => {
      // Use a reference date well into the day in local time
      const localRef = new Date(2025, 0, 15, 14, 0, 0); // 2pm local Jan 15
      const result = parseNaturalTime("every day at 8am", TIMEZONE, localRef);
      expect(result).not.toBeNull();
      expect(result!.date.getDate()).toBe(16); // tomorrow local
      expect(result!.date.getHours()).toBe(8);
    });

    it("uses default ref date when not provided", () => {
      const result = parseNaturalTime("in 1 hour", TIMEZONE);
      expect(result).not.toBeNull();
      expect(result!.date.getTime()).toBeGreaterThan(Date.now());
    });
  });
});
