import { describe, it, expect, vi, beforeEach } from "vitest";
import { DockerSandboxSkill } from "../../../../src/skills/docker-sandbox/skill.js";

// Mock execFile so we don't run real Docker in unit tests
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("node:util", () => ({
  promisify: vi.fn((fn: unknown) => {
    // Return a mock async version
    return async (...args: unknown[]) => {
      // The mock will be configured per-test via the execFile mock
      const { execFile } = await import("node:child_process");
      return new Promise((resolve, reject) => {
        (execFile as unknown as ReturnType<typeof vi.fn>).mock.calls;
        // Just return success by default
        resolve({ stdout: "mock-output", stderr: "" });
      });
    };
  }),
}));

describe("DockerSandboxSkill — prefix validation", () => {
  let skill: DockerSandboxSkill;

  beforeEach(() => {
    skill = new DockerSandboxSkill();
  });

  it("rejects docker_sandbox_build with non-prefixed tag", async () => {
    const result = JSON.parse(
      await skill.execute("docker_sandbox_build", {
        tag: "my-evil-image:latest",
        dockerfile_path: process.cwd() + "/Dockerfile",
        context_path: process.cwd(),
      })
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("agent-sandbox-");
  });

  it("rejects docker_sandbox_run with non-prefixed name", async () => {
    const result = JSON.parse(
      await skill.execute("docker_sandbox_run", {
        name: "my-container",
        image: "agent-sandbox-test:latest",
        host_port: 3099,
      })
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("agent-sandbox-");
  });

  it("rejects docker_sandbox_run with non-prefixed image", async () => {
    const result = JSON.parse(
      await skill.execute("docker_sandbox_run", {
        name: "agent-sandbox-test",
        image: "ubuntu:latest",
        host_port: 3099,
      })
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("agent-sandbox-");
  });

  it("rejects docker_sandbox_logs with non-prefixed name", async () => {
    const result = JSON.parse(
      await skill.execute("docker_sandbox_logs", {
        name: "some-other-container",
      })
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("agent-sandbox-");
  });

  it("rejects docker_sandbox_stop with non-prefixed name", async () => {
    const result = JSON.parse(
      await skill.execute("docker_sandbox_stop", {
        name: "production-container",
      })
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("agent-sandbox-");
  });

  it("rejects docker_sandbox_remove with non-prefixed name", async () => {
    const result = JSON.parse(
      await skill.execute("docker_sandbox_remove", {
        name: "production-db",
      })
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("agent-sandbox-");
  });

  it("accepts correctly-prefixed names (validation only — no real docker call)", async () => {
    // This will fail at the docker exec stage (no real docker), but should NOT fail at validation
    const result = JSON.parse(
      await skill.execute("docker_sandbox_stop", {
        name: "agent-sandbox-test-container",
      })
    );
    // Will error (docker not available in test), but error should be from docker, not from prefix check
    if (!result.success) {
      expect(result.error).not.toContain("Security violation");
    }
  });
});

describe("DockerSandboxSkill — path validation", () => {
  let skill: DockerSandboxSkill;

  beforeEach(() => {
    skill = new DockerSandboxSkill();
  });

  it("rejects context_path outside working directory (path traversal)", async () => {
    const result = JSON.parse(
      await skill.execute("docker_sandbox_build", {
        tag: "agent-sandbox-test:latest",
        dockerfile_path: "/etc/passwd",
        context_path: "/etc",
      })
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("Security violation");
    expect(result.error).toContain("context_path");
  });

  it("rejects path traversal via ..", async () => {
    const result = JSON.parse(
      await skill.execute("docker_sandbox_build", {
        tag: "agent-sandbox-test:latest",
        dockerfile_path: process.cwd() + "/../../etc/Dockerfile",
        context_path: process.cwd() + "/../..",
      })
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("Security violation");
  });
});

describe("DockerSandboxSkill — tool list", () => {
  it("exposes exactly 6 tools", () => {
    const skill = new DockerSandboxSkill();
    expect(skill.getTools()).toHaveLength(6);
  });

  it("has correct permission tiers", () => {
    const skill = new DockerSandboxSkill();
    const tools = skill.getTools();
    const tierMap = Object.fromEntries(tools.map((t) => [t.name, t.permissionTier]));

    expect(tierMap.docker_sandbox_build).toBe(3);
    expect(tierMap.docker_sandbox_run).toBe(3);
    expect(tierMap.docker_sandbox_logs).toBe(0);
    expect(tierMap.docker_sandbox_stop).toBe(2);
    expect(tierMap.docker_sandbox_remove).toBe(2);
    expect(tierMap.docker_sandbox_healthcheck).toBe(0);
  });
});
