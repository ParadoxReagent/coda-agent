import { describe, it, expect, vi, beforeEach } from "vitest";
import { SelfImprovementExecutorSkill } from "../../../../src/skills/self-improvement-executor/skill.js";
import {
  createMockSubagentManager,
  createMockDatabase,
  createMockLogger,
} from "../../../helpers/mocks.js";

// Mock Docker calls from cleanupSandboxContainers (called in every runCycle finally block)
vi.mock("node:child_process", () => ({
  execFile: vi.fn((_cmd: string, _args: string[], cb: (err: null, res: { stdout: string; stderr: string }) => void) =>
    cb(null, { stdout: "", stderr: "" })
  ),
}));

vi.mock("node:util", () => ({
  promisify: vi.fn(
    () =>
      async (..._args: unknown[]) => ({ stdout: "", stderr: "" })
  ),
}));

// ── Fixture helpers ──────────────────────────────────────────────────────────

function makeProposal(overrides: Record<string, unknown> = {}) {
  return {
    id: "proposal-001",
    title: "Test Proposal",
    category: "capability_gap",
    description: "Test description for a capability gap",
    priority: 5,
    status: "approved",
    createdAt: new Date("2025-01-01"),
    updatedAt: new Date("2025-01-01"),
    appliedAt: null,
    ...overrides,
  };
}

function makeBlastRadiusJson(affectedFiles: string[] = ["src/skills/foo.ts"]) {
  return JSON.stringify({
    affected_files: affectedFiles,
    import_chain_depth: 1,
    risk_level: "low",
    risk_factors: [],
    protected_path_violations: [],
    summary: "Low risk change",
  });
}

function makeSurgeonOutputJson(file = "src/skills/foo/bar.ts") {
  return JSON.stringify({
    changes: [
      {
        file,
        newContents: "export const foo = 'bar';",
        explanation: "Added foo export",
        risk: "low",
      },
    ],
    summary: "Added foo export",
    out_of_scope: false,
    out_of_scope_reason: null,
  });
}

// ── Metadata tests ───────────────────────────────────────────────────────────

describe("SelfImprovementExecutorSkill — metadata", () => {
  it("exposes exactly 3 tools", () => {
    const skill = new SelfImprovementExecutorSkill();
    expect(skill.getTools()).toHaveLength(3);
  });

  it("has the correct tool names", () => {
    const skill = new SelfImprovementExecutorSkill();
    const names = skill.getTools().map((t) => t.name);
    expect(names).toContain("self_improvement_run");
    expect(names).toContain("self_improvement_status");
    expect(names).toContain("self_improvement_history");
  });

  it("has correct permission tiers", () => {
    const skill = new SelfImprovementExecutorSkill();
    const tiers = Object.fromEntries(skill.getTools().map((t) => [t.name, t.permissionTier]));
    expect(tiers["self_improvement_run"]).toBe(3);
    expect(tiers["self_improvement_status"]).toBe(0);
    expect(tiers["self_improvement_history"]).toBe(0);
  });

  it("marks all tools as mainAgentOnly", () => {
    const skill = new SelfImprovementExecutorSkill();
    const allMainOnly = skill.getTools().every((t) => t.mainAgentOnly === true);
    expect(allMainOnly).toBe(true);
  });
});

// ── triggerRun tests ─────────────────────────────────────────────────────────

describe("SelfImprovementExecutorSkill — triggerRun (self_improvement_run)", () => {
  let skill: SelfImprovementExecutorSkill;

  beforeEach(async () => {
    skill = new SelfImprovementExecutorSkill({ executor_enabled: true });
    const mockDb = createMockDatabase();
    mockDb._setResults([]);
    const ctx = {
      config: {},
      logger: createMockLogger(),
      redis: {
        async get(_key: string) { return null; },
        async set(_key: string, _value: string) {},
        async del(_key: string) {},
      },
      eventBus: { publish: vi.fn(), subscribe: vi.fn() },
      db: mockDb as unknown as Parameters<typeof skill.startup>[0]["db"],
      messageSender: { send: vi.fn(), broadcast: vi.fn() },
    };
    await skill.startup(ctx as Parameters<typeof skill.startup>[0]);
  });

  it("returns runId and success immediately without waiting for cycle", async () => {
    const result = JSON.parse(
      await skill.execute("self_improvement_run", {})
    );
    expect(result.success).toBe(true);
    expect(typeof result.runId).toBe("string");
    expect(result.runId.length).toBeGreaterThan(0);
    expect(result.message).toContain("started");
  });

  it("rejects a second run if one is already in progress", async () => {
    // First call sets status to "running" synchronously before any await
    void skill.execute("self_improvement_run", {});

    // Second call sees status = "running" and rejects
    const result = JSON.parse(
      await skill.execute("self_improvement_run", {})
    );
    expect(result.error).toContain("already in progress");
    expect(result.runId).toBeDefined();
  });
});

// ── runCycle completion paths ────────────────────────────────────────────────

describe("SelfImprovementExecutorSkill — runCycle completion paths", () => {
  let skill: SelfImprovementExecutorSkill;
  let mockDb: ReturnType<typeof createMockDatabase>;
  let redisStore: Map<string, string>;

  function createCtx() {
    return {
      config: {},
      logger: createMockLogger(),
      redis: {
        async get(key: string) { return redisStore.get(key) ?? null; },
        async set(key: string, value: string, _ttl?: number) { redisStore.set(key, value); },
        async del(key: string) { redisStore.delete(key); },
      },
      eventBus: { publish: vi.fn(), subscribe: vi.fn() },
      db: mockDb as unknown as Parameters<typeof skill.startup>[0]["db"],
      messageSender: { send: vi.fn(), broadcast: vi.fn() },
    };
  }

  beforeEach(async () => {
    redisStore = new Map();
    mockDb = createMockDatabase();
    skill = new SelfImprovementExecutorSkill({
      executor_enabled: true,
      executor_max_run_duration_minutes: 1,
      executor_allowed_paths: ["src/skills", "src/integrations", "src/utils"],
      executor_forbidden_paths: ["src/core", "src/db/migrations", "src/main.ts"],
      executor_blast_radius_limit: 5,
      executor_max_files: 3,
    });
    await skill.startup(createCtx() as Parameters<typeof skill.startup>[0]);
  });

  it("no lock available → status becomes complete, outcome SKIPPED", async () => {
    // Pre-populate the Redis lock key so acquireLock() returns false
    redisStore.set("self_improvement:lock", "locked");

    await skill.runCycle();

    const status = JSON.parse(await skill.execute("self_improvement_status", {}));
    expect(status.status).toBe("complete");
    expect(status.lastResult?.outcome).toBe("SKIPPED");
  });

  it("no eligible proposals → status becomes complete, outcome SKIPPED", async () => {
    // DB returns no proposals (pendingResults defaults to [])
    mockDb._setResults([]);

    await skill.runCycle();

    const status = JSON.parse(await skill.execute("self_improvement_status", {}));
    expect(status.status).toBe("complete");
    expect(status.lastResult?.outcome).toBe("SKIPPED");
  });

  it("blast radius analysis fails (no subagentManager) → status complete, step recorded", async () => {
    // DB returns a proposal so proposalId is set
    mockDb._setResults([makeProposal()]);
    // No subagentManager set → runBlastRadiusAnalysis returns a failed step

    await skill.runCycle();

    const status = JSON.parse(await skill.execute("self_improvement_status", {}));
    expect(status.status).toBe("complete");
    // At least the failed blast-radius step must be in the result
    expect(status.lastResult?.stepsCount).toBeGreaterThanOrEqual(1);
    // outcome stays FAIL (default) — not PASS or SKIPPED
    expect(status.lastResult?.outcome).toBe("FAIL");
  });

  it("blast radius too large → status becomes complete, error set", async () => {
    // Wire up subagentManager that returns a blast radius with too many files
    const sub = createMockSubagentManager();
    const manyFiles = Array.from({ length: 10 }, (_, i) => `src/skills/file${i}.ts`);
    (sub.delegateSync as ReturnType<typeof vi.fn>).mockResolvedValue(makeBlastRadiusJson(manyFiles));
    skill.setSubagentManager(sub as unknown as Parameters<typeof skill.setSubagentManager>[0]);

    mockDb._setResults([makeProposal()]);

    await skill.runCycle();

    const status = JSON.parse(await skill.execute("self_improvement_status", {}));
    expect(status.status).toBe("complete");
    expect(status.lastResult?.outcome).not.toBe("PASS");
    expect(status.lastResult?.outcome).not.toBe("SKIPPED");
  });

  it("code surgeon fails → status becomes complete, error set, DB record written", async () => {
    const sub = createMockSubagentManager();
    (sub.delegateSync as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(makeBlastRadiusJson(["src/skills/foo.ts"]))  // blast radius OK
      .mockRejectedValueOnce(new Error("code-surgeon-agent timed out"))   // surgeon fails
      .mockResolvedValue("narrative text");                               // reporter (in finally)
    skill.setSubagentManager(sub as unknown as Parameters<typeof skill.setSubagentManager>[0]);

    mockDb._setResults([makeProposal()]);

    await skill.runCycle();

    const status = JSON.parse(await skill.execute("self_improvement_status", {}));
    expect(status.status).toBe("complete");
    expect(status.lastResult?.outcome).not.toBe("PASS");
    // DB insert was attempted (insert mock was called)
    expect(mockDb.insert).toHaveBeenCalled();
  });

  it("path guardrail violation → status becomes complete, cycle recorded", async () => {
    const sub = createMockSubagentManager();
    (sub.delegateSync as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(makeBlastRadiusJson(["src/skills/foo.ts"]))  // blast radius OK
      .mockResolvedValueOnce(                                              // surgeon returns forbidden path
        JSON.stringify({
          changes: [
            {
              file: "src/core/base-agent.ts",
              newContents: "// modified",
              explanation: "Bad change",
              risk: "high",
            },
          ],
          summary: "Illegal change",
          out_of_scope: false,
          out_of_scope_reason: null,
        })
      )
      .mockResolvedValue("narrative");  // reporter
    skill.setSubagentManager(sub as unknown as Parameters<typeof skill.setSubagentManager>[0]);

    mockDb._setResults([makeProposal()]);

    await skill.runCycle();

    const status = JSON.parse(await skill.execute("self_improvement_status", {}));
    expect(status.status).toBe("complete");
    expect(status.lastResult).not.toBeNull();
    expect(status.lastResult?.outcome).not.toBe("PASS");
  });

  it("full successful cycle → status complete, outcome PASS", async () => {
    const sub = createMockSubagentManager();
    (sub.delegateSync as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(makeBlastRadiusJson(["src/skills/foo.ts"]))   // blast radius
      .mockResolvedValueOnce(makeSurgeonOutputJson("src/skills/foo.ts"))   // surgeon
      .mockResolvedValueOnce('"overall":"PASS"')                           // test-runner
      .mockResolvedValue("narrative text");                                // reporter
    skill.setSubagentManager(sub as unknown as Parameters<typeof skill.setSubagentManager>[0]);

    const registry = {
      executeToolCall: vi.fn().mockImplementation((name: string) => {
        if (name === "create_pull_request") {
          return Promise.resolve('{"html_url":"https://github.com/owner/repo/pull/1"}');
        }
        return Promise.resolve("ok");
      }),
    };
    skill.setSkillRegistry(registry as unknown as Parameters<typeof skill.setSkillRegistry>[0]);

    mockDb._setResults([makeProposal()]);

    await skill.runCycle();

    const status = JSON.parse(await skill.execute("self_improvement_status", {}));
    expect(status.status).toBe("complete");
    expect(status.lastResult?.outcome).toBe("PASS");
    expect(status.lastResult?.prUrl).toBe("https://github.com/owner/repo/pull/1");
  });
});

// ── Status tool tests ────────────────────────────────────────────────────────

describe("SelfImprovementExecutorSkill — status tool", () => {
  it("returns idle status when no run has occurred", async () => {
    const skill = new SelfImprovementExecutorSkill();
    const result = JSON.parse(await skill.execute("self_improvement_status", {}));
    expect(result.status).toBe("idle");
    expect(result.runId).toBeNull();
    expect(result.lastResult).toBeNull();
  });

  it("returns the runId of the most recent run", async () => {
    const skill = new SelfImprovementExecutorSkill({ executor_enabled: true });
    const mockDb = createMockDatabase();
    mockDb._setResults([]);
    const ctx = {
      config: {},
      logger: createMockLogger(),
      redis: {
        async get(_key: string) { return null; },
        async set(_key: string, _value: string) {},
        async del(_key: string) {},
      },
      eventBus: { publish: vi.fn(), subscribe: vi.fn() },
      db: mockDb as unknown as Parameters<typeof skill.startup>[0]["db"],
      messageSender: { send: vi.fn(), broadcast: vi.fn() },
    };
    await skill.startup(ctx as Parameters<typeof skill.startup>[0]);

    const runId = "test-run-abc-123";
    await skill.runCycle(undefined, runId);

    const status = JSON.parse(await skill.execute("self_improvement_status", {}));
    expect(status.runId).toBe(runId);
    expect(status.status).toBe("complete");
  });
});

// ── History tool tests ───────────────────────────────────────────────────────

describe("SelfImprovementExecutorSkill — history tool", () => {
  async function createStartedSkill() {
    const skill = new SelfImprovementExecutorSkill();
    const mockDb = createMockDatabase();
    mockDb._setResults([]);
    const ctx = {
      config: {},
      logger: createMockLogger(),
      redis: {
        async get(_key: string) { return null; },
        async set(_key: string, _value: string) {},
        async del(_key: string) {},
      },
      eventBus: { publish: vi.fn(), subscribe: vi.fn() },
      db: mockDb as unknown as Parameters<typeof skill.startup>[0]["db"],
    };
    await skill.startup(ctx as Parameters<typeof skill.startup>[0]);
    return { skill, mockDb };
  }

  it("returns runs array and total when DB returns no rows", async () => {
    const { skill } = await createStartedSkill();
    const result = JSON.parse(await skill.execute("self_improvement_history", {}));
    expect(Array.isArray(result.runs)).toBe(true);
    expect(result.total).toBe(0);
  });

  it("uses default limit of 10", async () => {
    const { skill, mockDb } = await createStartedSkill();
    await skill.execute("self_improvement_history", {});
    // orderBy was called (part of the query chain)
    expect(mockDb.select).toHaveBeenCalled();
  });

  it("caps limit at 50 even if a larger value is passed", async () => {
    const { skill } = await createStartedSkill();
    // Should not throw even with an out-of-range limit
    const result = JSON.parse(await skill.execute("self_improvement_history", { limit: 200 }));
    expect(Array.isArray(result.runs)).toBe(true);
  });

  it("returns error when DB is not initialized", async () => {
    const skill = new SelfImprovementExecutorSkill();
    // startup not called → db is undefined
    const result = JSON.parse(await skill.execute("self_improvement_history", {}));
    expect(result.error).toBeDefined();
    expect(result.error).toContain("not initialized");
  });
});
