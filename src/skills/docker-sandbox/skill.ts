/**
 * DockerSandboxSkill: Provides sandboxed Docker operations for the self-improvement executor.
 *
 * Tools:
 *   - docker_sandbox_build  (tier 3) — build an image, tag must start "agent-sandbox-"
 *   - docker_sandbox_run    (tier 3) — run a named container
 *   - docker_sandbox_logs   (tier 0) — get container logs
 *   - docker_sandbox_stop   (tier 2) — stop a running container
 *   - docker_sandbox_remove (tier 2) — remove a container
 *   - docker_sandbox_healthcheck (tier 0) — HTTP GET localhost health check
 *
 * Security constraints:
 *   - Image tag/container name must start with "agent-sandbox-"
 *   - Context path must be within the agent working directory
 *   - Healthcheck URL limited to localhost / 127.0.0.1
 *   - Build timeout: 120s; all other timeouts: 30s
 *   - No shell injection: uses execFile (not exec)
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve as resolvePath } from "node:path";
import type { Skill, SkillToolDefinition } from "../base.js";
import type { SkillContext } from "../context.js";
import type { Logger } from "../../utils/logger.js";
import type {
  DockerSandboxBuildInput,
  DockerSandboxRunInput,
  DockerSandboxLogsInput,
  DockerSandboxStopInput,
  DockerSandboxRemoveInput,
  DockerSandboxHealthcheckInput,
  DockerSandboxResult,
} from "./types.js";

const execFileAsync = promisify(execFile);

const SANDBOX_PREFIX = "agent-sandbox-";
const BUILD_TIMEOUT_MS = 120_000;
const DEFAULT_TIMEOUT_MS = 30_000;

export class DockerSandboxSkill implements Skill {
  readonly name = "docker-sandbox";
  readonly description = "Sandboxed Docker operations for self-improvement validation";
  readonly kind = "skill" as const;

  private logger?: Logger;
  /** Working directory used as root for path validation. */
  private workingDir: string = process.cwd();

  getRequiredConfig(): string[] {
    return [];
  }

  getTools(): SkillToolDefinition[] {
    return [
      {
        name: "docker_sandbox_build",
        description:
          "Build a Docker image from a Dockerfile. Tag must start with 'agent-sandbox-'. " +
          "Context path must be within the agent working directory. Build timeout: 120s.",
        input_schema: {
          type: "object" as const,
          properties: {
            tag: {
              type: "string",
              description: "Image tag (must start with 'agent-sandbox-')",
            },
            dockerfile_path: {
              type: "string",
              description: "Path to Dockerfile (absolute or relative to cwd)",
            },
            context_path: {
              type: "string",
              description: "Build context directory path",
            },
            build_args: {
              type: "object",
              description: "Optional build args as {KEY: VALUE}",
              additionalProperties: { type: "string" },
            },
          },
          required: ["tag", "dockerfile_path", "context_path"],
        },
        permissionTier: 3,
        requiresConfirmation: true,
        mainAgentOnly: false,
      },
      {
        name: "docker_sandbox_run",
        description:
          "Run a Docker container in detached mode. Name must start with 'agent-sandbox-'. " +
          "Image must start with 'agent-sandbox-'. Maps container port 3000 to host_port.",
        input_schema: {
          type: "object" as const,
          properties: {
            name: {
              type: "string",
              description: "Container name (must start with 'agent-sandbox-')",
            },
            image: {
              type: "string",
              description: "Image tag to run (must start with 'agent-sandbox-')",
            },
            host_port: {
              type: "number",
              description: "Host port to bind container port 3000 to",
            },
            env: {
              type: "object",
              description: "Optional environment variables as {KEY: VALUE}",
              additionalProperties: { type: "string" },
            },
            memory: {
              type: "string",
              description: "Memory limit (e.g., '512m'). Default: '512m'",
            },
          },
          required: ["name", "image", "host_port"],
        },
        permissionTier: 3,
        requiresConfirmation: true,
        mainAgentOnly: false,
      },
      {
        name: "docker_sandbox_logs",
        description: "Get logs from a sandbox container. Name must start with 'agent-sandbox-'.",
        input_schema: {
          type: "object" as const,
          properties: {
            name: {
              type: "string",
              description: "Container name (must start with 'agent-sandbox-')",
            },
            tail: {
              type: "number",
              description: "Number of lines to tail. Default: 100.",
            },
          },
          required: ["name"],
        },
        permissionTier: 0,
        mainAgentOnly: false,
      },
      {
        name: "docker_sandbox_stop",
        description: "Stop a running sandbox container. Name must start with 'agent-sandbox-'.",
        input_schema: {
          type: "object" as const,
          properties: {
            name: {
              type: "string",
              description: "Container name (must start with 'agent-sandbox-')",
            },
          },
          required: ["name"],
        },
        permissionTier: 2,
        mainAgentOnly: false,
      },
      {
        name: "docker_sandbox_remove",
        description: "Remove a sandbox container. Name must start with 'agent-sandbox-'.",
        input_schema: {
          type: "object" as const,
          properties: {
            name: {
              type: "string",
              description: "Container name (must start with 'agent-sandbox-')",
            },
            force: {
              type: "boolean",
              description: "Force remove even if running. Default: false.",
            },
          },
          required: ["name"],
        },
        permissionTier: 2,
        mainAgentOnly: false,
      },
      {
        name: "docker_sandbox_healthcheck",
        description:
          "HTTP GET health check against localhost. Use to verify a shadow container started correctly.",
        input_schema: {
          type: "object" as const,
          properties: {
            port: {
              type: "number",
              description: "Port to check (http://localhost:{port}{path})",
            },
            path: {
              type: "string",
              description: "URL path. Default: '/health'",
            },
            timeout_seconds: {
              type: "number",
              description: "Request timeout in seconds. Default: 10.",
            },
          },
          required: ["port"],
        },
        permissionTier: 0,
        mainAgentOnly: false,
      },
    ];
  }

  async startup(ctx: SkillContext): Promise<void> {
    this.logger = ctx.logger;
  }

  async shutdown(): Promise<void> {}

  async execute(toolName: string, input: Record<string, unknown>): Promise<string> {
    const start = Date.now();
    try {
      switch (toolName) {
        case "docker_sandbox_build":
          return await this.build(input as unknown as DockerSandboxBuildInput, start);
        case "docker_sandbox_run":
          return await this.run(input as unknown as DockerSandboxRunInput, start);
        case "docker_sandbox_logs":
          return await this.logs(input as unknown as DockerSandboxLogsInput, start);
        case "docker_sandbox_stop":
          return await this.stop(input as unknown as DockerSandboxStopInput, start);
        case "docker_sandbox_remove":
          return await this.remove(input as unknown as DockerSandboxRemoveInput, start);
        case "docker_sandbox_healthcheck":
          return await this.healthcheck(input as unknown as DockerSandboxHealthcheckInput, start);
        default:
          return JSON.stringify({ success: false, error: `Unknown tool: ${toolName}`, durationMs: 0 });
      }
    } catch (err) {
      const result: DockerSandboxResult = {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      };
      return JSON.stringify(result);
    }
  }

  // ── Tool implementations ─────────────────────────────────────────────────

  private async build(input: DockerSandboxBuildInput, start: number): Promise<string> {
    this.validatePrefix("tag", input.tag);
    this.validatePath("context_path", input.context_path);

    const args = ["build", "-t", input.tag, "-f", input.dockerfile_path];

    if (input.build_args) {
      for (const [key, val] of Object.entries(input.build_args)) {
        args.push("--build-arg", `${key}=${val}`);
      }
    }

    args.push(input.context_path);

    this.logger?.info({ tag: input.tag, contextPath: input.context_path }, "docker_sandbox_build");

    const { stdout, stderr } = await this.execDocker(args, BUILD_TIMEOUT_MS);
    const result: DockerSandboxResult = {
      success: true,
      output: `${stdout}\n${stderr}`.trim(),
      durationMs: Date.now() - start,
    };
    return JSON.stringify(result);
  }

  private async run(input: DockerSandboxRunInput, start: number): Promise<string> {
    this.validatePrefix("name", input.name);
    this.validatePrefix("image", input.image);

    const memory = input.memory ?? "512m";
    const args = [
      "run", "-d",
      "--name", input.name,
      "-p", `${input.host_port}:3000`,
      "--memory", memory,
      "--cpus", "1",
      "--network", "bridge",
    ];

    if (input.env) {
      for (const [key, val] of Object.entries(input.env)) {
        args.push("-e", `${key}=${val}`);
      }
    }

    args.push(input.image);

    this.logger?.info({ name: input.name, image: input.image, port: input.host_port }, "docker_sandbox_run");

    const { stdout } = await this.execDocker(args, DEFAULT_TIMEOUT_MS);
    const result: DockerSandboxResult = {
      success: true,
      output: stdout.trim(),
      durationMs: Date.now() - start,
    };
    return JSON.stringify(result);
  }

  private async logs(input: DockerSandboxLogsInput, start: number): Promise<string> {
    this.validatePrefix("name", input.name);

    const tail = String(input.tail ?? 100);
    const args = ["logs", "--tail", tail, input.name];

    const { stdout, stderr } = await this.execDocker(args, DEFAULT_TIMEOUT_MS);
    const result: DockerSandboxResult = {
      success: true,
      output: `${stdout}\n${stderr}`.trim(),
      durationMs: Date.now() - start,
    };
    return JSON.stringify(result);
  }

  private async stop(input: DockerSandboxStopInput, start: number): Promise<string> {
    this.validatePrefix("name", input.name);

    const args = ["stop", input.name];
    this.logger?.info({ name: input.name }, "docker_sandbox_stop");

    await this.execDocker(args, DEFAULT_TIMEOUT_MS);
    const result: DockerSandboxResult = {
      success: true,
      output: `Container ${input.name} stopped`,
      durationMs: Date.now() - start,
    };
    return JSON.stringify(result);
  }

  private async remove(input: DockerSandboxRemoveInput, start: number): Promise<string> {
    this.validatePrefix("name", input.name);

    const args = ["rm"];
    if (input.force) args.push("-f");
    args.push(input.name);

    this.logger?.info({ name: input.name, force: input.force }, "docker_sandbox_remove");

    await this.execDocker(args, DEFAULT_TIMEOUT_MS);
    const result: DockerSandboxResult = {
      success: true,
      output: `Container ${input.name} removed`,
      durationMs: Date.now() - start,
    };
    return JSON.stringify(result);
  }

  private async healthcheck(input: DockerSandboxHealthcheckInput, start: number): Promise<string> {
    const path = input.path ?? "/health";
    const timeoutMs = (input.timeout_seconds ?? 10) * 1000;
    const url = `http://localhost:${input.port}${path}`;

    this.logger?.debug({ url }, "docker_sandbox_healthcheck");

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutHandle);

      const body = await res.text().catch(() => "");
      const result: DockerSandboxResult = {
        success: res.ok,
        output: `HTTP ${res.status}: ${body.slice(0, 500)}`,
        durationMs: Date.now() - start,
        error: res.ok ? undefined : `Unexpected status ${res.status}`,
      };
      return JSON.stringify(result);
    } catch (err) {
      clearTimeout(timeoutHandle);
      const result: DockerSandboxResult = {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      };
      return JSON.stringify(result);
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Validate that a string value starts with the required sandbox prefix.
   * Throws on violation (prevents arbitrary container/image names).
   */
  private validatePrefix(field: string, value: string): void {
    if (!value.startsWith(SANDBOX_PREFIX)) {
      throw new Error(
        `Security violation: "${field}" must start with "${SANDBOX_PREFIX}" (got "${value}")`
      );
    }
  }

  /**
   * Validate that a path stays within the working directory.
   * Throws on path traversal attempts.
   */
  private validatePath(field: string, inputPath: string): void {
    const resolved = resolvePath(inputPath);
    const workingDirResolved = resolvePath(this.workingDir);
    if (!resolved.startsWith(workingDirResolved)) {
      throw new Error(
        `Security violation: "${field}" must be within working directory ` +
        `"${workingDirResolved}" (got "${resolved}")`
      );
    }
  }

  /**
   * Run a docker command via execFile (no shell injection risk).
   */
  private async execDocker(
    args: string[],
    timeoutMs: number
  ): Promise<{ stdout: string; stderr: string }> {
    try {
      return await execFileAsync("docker", args, {
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024, // 10 MB
      });
    } catch (err: unknown) {
      if (
        err &&
        typeof err === "object" &&
        "stdout" in err &&
        "stderr" in err &&
        "code" in err
      ) {
        const execErr = err as { stdout: string; stderr: string; code: number; message: string };
        // Non-zero exit — include stdout/stderr in error message for diagnostics
        throw new Error(
          `docker ${args[0]} exited with code ${execErr.code}:\n` +
          `stdout: ${execErr.stdout?.toString().trim() || "(empty)"}\n` +
          `stderr: ${execErr.stderr?.toString().trim() || "(empty)"}`
        );
      }
      throw err;
    }
  }
}
