import { describe, it, expect } from "vitest";
import { generateEventId } from "../../../src/utils/id.js";

describe("generateEventId", () => {
  it("returns a string in the expected format (base36-hex)", () => {
    const id = generateEventId();
    expect(id).toMatch(/^[a-z0-9]+-[a-f0-9]{8}$/);
  });

  it("generates unique IDs", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      ids.add(generateEventId());
    }
    expect(ids.size).toBe(1000);
  });

  it("is time-sortable (IDs generated later sort after earlier ones)", () => {
    const id1 = generateEventId();
    const id2 = generateEventId();

    // Extract the time part (before the dash)
    const time1 = id1.split("-")[0]!;
    const time2 = id2.split("-")[0]!;

    // Same or later timestamp (generated sequentially, so should be equal or greater)
    expect(parseInt(time2, 36)).toBeGreaterThanOrEqual(parseInt(time1, 36));
  });

  it("has reasonable length", () => {
    const id = generateEventId();
    // base36 of Date.now() is ~8-9 chars + "-" + 8 hex chars = ~18 chars
    expect(id.length).toBeGreaterThan(10);
    expect(id.length).toBeLessThan(25);
  });
});
