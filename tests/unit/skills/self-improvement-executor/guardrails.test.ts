import { describe, it, expect } from "vitest";
import {
  isPathAllowed,
  isBlastRadiusAcceptable,
  isChangeCountAcceptable,
  canAutoMerge,
  validateChangePaths,
} from "../../../../src/skills/self-improvement-executor/guardrails.js";

const ROOT = "/project";
const ALLOWED = ["src/skills", "src/integrations", "src/utils"];
const FORBIDDEN = ["src/core", "src/db/migrations", "src/main.ts"];

describe("isPathAllowed", () => {
  it("allows a file inside an allowed path", () => {
    expect(isPathAllowed("src/skills/foo/skill.ts", ALLOWED, FORBIDDEN, ROOT)).toBe(true);
  });

  it("allows a file directly matching an allowed path prefix", () => {
    expect(isPathAllowed("src/skills", ALLOWED, FORBIDDEN, ROOT)).toBe(true);
  });

  it("allows a nested file deep inside an allowed path", () => {
    expect(isPathAllowed("src/skills/foo/bar/baz.ts", ALLOWED, FORBIDDEN, ROOT)).toBe(true);
  });

  it("allows a file in a different allowed path", () => {
    expect(isPathAllowed("src/utils/helpers.ts", ALLOWED, FORBIDDEN, ROOT)).toBe(true);
  });

  it("denies a file inside a forbidden path", () => {
    expect(isPathAllowed("src/core/base-agent.ts", ALLOWED, FORBIDDEN, ROOT)).toBe(false);
  });

  it("denies a file that matches a forbidden path exactly", () => {
    expect(isPathAllowed("src/main.ts", ALLOWED, FORBIDDEN, ROOT)).toBe(false);
  });

  it("denies a file inside a forbidden subdirectory", () => {
    expect(isPathAllowed("src/db/migrations/0001_init.sql", ALLOWED, FORBIDDEN, ROOT)).toBe(false);
  });

  it("denies a file outside all allowed paths", () => {
    expect(isPathAllowed("src/db/schema.ts", ALLOWED, FORBIDDEN, ROOT)).toBe(false);
  });

  it("denies a file at the root level", () => {
    expect(isPathAllowed("package.json", ALLOWED, FORBIDDEN, ROOT)).toBe(false);
  });

  it("forbidden takes priority over allowed when paths overlap", () => {
    const overlappingAllowed = ["src"];
    const overlappingForbidden = ["src/core"];
    expect(isPathAllowed("src/core/base-agent.ts", overlappingAllowed, overlappingForbidden, ROOT)).toBe(false);
    expect(isPathAllowed("src/skills/foo.ts", overlappingAllowed, overlappingForbidden, ROOT)).toBe(true);
  });

  it("resolves path traversal attempts (.. sequences)", () => {
    // src/skills/../core/exploit.ts resolves to src/core/exploit.ts which is forbidden
    expect(isPathAllowed("src/skills/../core/exploit.ts", ALLOWED, FORBIDDEN, ROOT)).toBe(false);
  });

  it("denies absolute paths outside the project root", () => {
    expect(isPathAllowed("/etc/passwd", ALLOWED, FORBIDDEN, ROOT)).toBe(false);
  });

  it("denies path traversal that escapes project root", () => {
    expect(isPathAllowed("../../etc/passwd", ALLOWED, FORBIDDEN, ROOT)).toBe(false);
  });
});

describe("isBlastRadiusAcceptable", () => {
  it("returns true when file count is under the limit", () => {
    expect(isBlastRadiusAcceptable(3, 5)).toBe(true);
  });

  it("returns true when file count equals the limit (boundary)", () => {
    expect(isBlastRadiusAcceptable(5, 5)).toBe(true);
  });

  it("returns false when file count exceeds the limit by one", () => {
    expect(isBlastRadiusAcceptable(6, 5)).toBe(false);
  });

  it("returns false when file count greatly exceeds the limit", () => {
    expect(isBlastRadiusAcceptable(100, 5)).toBe(false);
  });

  it("returns true for 0 files (no blast radius)", () => {
    expect(isBlastRadiusAcceptable(0, 5)).toBe(true);
  });

  it("returns true when limit is 1 and count is 1", () => {
    expect(isBlastRadiusAcceptable(1, 1)).toBe(true);
  });
});

describe("isChangeCountAcceptable", () => {
  it("returns true when change count is under the limit", () => {
    expect(isChangeCountAcceptable(2, 3)).toBe(true);
  });

  it("returns true when change count equals the limit (boundary)", () => {
    expect(isChangeCountAcceptable(3, 3)).toBe(true);
  });

  it("returns false when change count exceeds the limit by one", () => {
    expect(isChangeCountAcceptable(4, 3)).toBe(false);
  });

  it("returns true for 0 changes", () => {
    expect(isChangeCountAcceptable(0, 3)).toBe(true);
  });
});

describe("canAutoMerge", () => {
  it("always returns false", () => {
    expect(canAutoMerge()).toBe(false);
  });

  it("returns a literal false (TypeScript type is false)", () => {
    const result = canAutoMerge();
    expect(result).toStrictEqual(false);
  });
});

describe("validateChangePaths", () => {
  it("returns empty array when all files are in allowed paths", () => {
    const files = ["src/skills/foo.ts", "src/utils/bar.ts"];
    expect(validateChangePaths(files, ALLOWED, FORBIDDEN, ROOT)).toHaveLength(0);
  });

  it("returns a violation for a single forbidden file", () => {
    const files = ["src/core/base-agent.ts"];
    const violations = validateChangePaths(files, ALLOWED, FORBIDDEN, ROOT);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("src/core/base-agent.ts");
  });

  it("returns a violation for a file outside all allowed paths", () => {
    const files = ["src/db/schema.ts"];
    const violations = validateChangePaths(files, ALLOWED, FORBIDDEN, ROOT);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("src/db/schema.ts");
  });

  it("returns mixed results for mixed allowed and forbidden files", () => {
    const files = ["src/skills/foo.ts", "src/core/base-agent.ts"];
    const violations = validateChangePaths(files, ALLOWED, FORBIDDEN, ROOT);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("src/core/base-agent.ts");
  });

  it("returns multiple violations for multiple bad files", () => {
    const files = [
      "src/core/base-agent.ts",
      "src/db/migrations/0001_init.sql",
      "src/main.ts",
    ];
    const violations = validateChangePaths(files, ALLOWED, FORBIDDEN, ROOT);
    expect(violations).toHaveLength(3);
  });

  it("returns empty array for an empty file list", () => {
    expect(validateChangePaths([], ALLOWED, FORBIDDEN, ROOT)).toHaveLength(0);
  });

  it("violation message contains the offending file path", () => {
    const violations = validateChangePaths(
      ["src/core/exploit.ts"],
      ALLOWED,
      FORBIDDEN,
      ROOT
    );
    expect(violations[0]).toContain("src/core/exploit.ts");
    expect(violations[0]).toMatch(/forbidden|allowed/i);
  });
});
