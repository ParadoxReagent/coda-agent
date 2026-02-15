import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import type { Skill, SkillToolDefinition } from "../base.js";
import type { SkillContext } from "../context.js";
import type { Logger } from "../../utils/logger.js";
import type { ExecutionConfig } from "../../utils/config.js";
import type { CodeExecuteInput, CodeExecuteOutput } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Docker Executor Skill
 * Provides sandboxed code execution in ephemeral Docker containers
 */
export class DockerExecutorSkill implements Skill {
  readonly name = "docker-executor";
  readonly description = "Execute code in sandboxed Docker containers";
  readonly kind = "integration" as const;

  private config: Required<ExecutionConfig>;
  private logger: Logger;

  constructor(config: ExecutionConfig, logger: Logger) {
    // Apply defaults
    this.config = {
      enabled: config.enabled,
      docker_socket: config.docker_socket ?? "/var/run/docker.sock",
      default_image: config.default_image ?? "python:3.12-slim",
      timeout: config.timeout ?? 60,
      max_memory: config.max_memory ?? "512m",
      network_enabled: config.network_enabled ?? false,
      max_output_size: config.max_output_size ?? 52428800,
      allowed_images: config.allowed_images ?? [
        "python:*",
        "node:*",
        "ubuntu:*",
        "alpine:*",
      ],
    };
    this.logger = logger;
  }

  getTools(): SkillToolDefinition[] {
    return [
      {
        name: "code_execute",
        description:
          "Execute a shell command in an ephemeral Docker container. The container has access to files in working_dir mounted at /workspace. Write output files to /workspace/output/ to return them to the user.",
        input_schema: {
          type: "object",
          properties: {
            command: {
              type: "string",
              description:
                "Shell command to execute (passed to sh -c inside container)",
            },
            image: {
              type: "string",
              description: `Docker image to use. Must match allowed_images patterns. Default: ${this.config.default_image}`,
            },
            working_dir: {
              type: "string",
              description:
                "Local directory path to mount as /workspace in container. Should contain input files.",
            },
            timeout_seconds: {
              type: "number",
              description: `Execution timeout in seconds (max ${this.config.timeout})`,
            },
            network: {
              type: "boolean",
              description:
                "Enable network access in container (default: false for security)",
            },
          },
          required: ["command"],
        },
        requiresConfirmation: true,
        sensitive: true,
      },
    ];
  }

  async execute(
    toolName: string,
    input: Record<string, unknown>
  ): Promise<string> {
    if (toolName !== "code_execute") {
      throw new Error(`Unknown tool: ${toolName}`);
    }

    const params = input as unknown as CodeExecuteInput;

    // Validate input
    if (!params.command || typeof params.command !== "string") {
      throw new Error("command is required and must be a string");
    }

    const image = params.image ?? this.config.default_image;
    const timeout = Math.min(
      params.timeout_seconds ?? this.config.timeout,
      this.config.timeout
    );
    const network = params.network ?? this.config.network_enabled;
    const workingDir = params.working_dir;

    // Validate image against allowlist
    if (!this.isImageAllowed(image)) {
      throw new Error(
        `Image "${image}" is not in the allowed_images list. Allowed patterns: ${this.config.allowed_images.join(", ")}`
      );
    }

    this.logger.info(
      { image, timeout, network, workingDir },
      "Executing code in Docker container"
    );

    try {
      const result = await this.runContainer(
        image,
        params.command,
        workingDir,
        timeout,
        network
      );

      return JSON.stringify(result, null, 2);
    } catch (err) {
      this.logger.error({ error: err }, "Docker execution failed");
      const errorOutput: CodeExecuteOutput = {
        success: false,
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
      };
      return JSON.stringify(errorOutput, null, 2);
    }
  }

  /**
   * Check if an image matches any allowed pattern
   */
  private isImageAllowed(image: string): boolean {
    return this.config.allowed_images.some((pattern) => {
      // Convert glob pattern to regex
      const regexPattern = pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".");
      const regex = new RegExp(`^${regexPattern}$`);
      return regex.test(image);
    });
  }

  /**
   * Run a command in a Docker container with security constraints
   */
  private async runContainer(
    image: string,
    command: string,
    workingDir: string | undefined,
    timeout: number,
    network: boolean
  ): Promise<CodeExecuteOutput> {
    const args = [
      "run",
      "--rm", // Ephemeral - auto-remove after exit
      "--memory",
      this.config.max_memory, // Memory limit
      "--cpus",
      "1", // CPU limit
      "--pids-limit",
      "256", // Process limit
      "--read-only", // Read-only root filesystem
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=100m", // Limited writable /tmp
    ];

    // Network configuration
    if (network) {
      this.logger.warn("Network access enabled for container");
    } else {
      args.push("--network", "none");
    }

    // Mount working directory if provided
    if (workingDir) {
      args.push("-v", `${workingDir}:/workspace:rw`);
      args.push("-w", "/workspace");
    }

    // Image and command
    args.push(image, "sh", "-c", command);

    this.logger.debug({ args }, "Docker run command");

    // Execute with timeout
    const timeoutMs = timeout * 1000;
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const { stdout, stderr } = await execFileAsync("docker", args, {
        signal: controller.signal,
        maxBuffer: 10 * 1024 * 1024, // 10 MB max output
      });

      clearTimeout(timeoutHandle);

      // Collect output files from /workspace/output/ if working_dir was provided
      let outputFiles: CodeExecuteOutput["output_files"];
      if (workingDir) {
        outputFiles = await this.collectOutputFiles(workingDir);
      }

      const result: CodeExecuteOutput = {
        success: true,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exit_code: 0,
      };

      if (outputFiles && outputFiles.length > 0) {
        result.output_files = outputFiles;
      }

      return result;
    } catch (err: unknown) {
      clearTimeout(timeoutHandle);

      if (
        err &&
        typeof err === "object" &&
        "signal" in err &&
        err.signal === "SIGTERM"
      ) {
        throw new Error(`Execution timed out after ${timeout} seconds`);
      }

      // Check if this is an ExecFileException
      if (
        err &&
        typeof err === "object" &&
        "stdout" in err &&
        "stderr" in err &&
        "code" in err
      ) {
        const execErr = err as {
          stdout: string;
          stderr: string;
          code: number;
        };
        // Non-zero exit code
        const result: CodeExecuteOutput = {
          success: false,
          stdout: execErr.stdout?.toString() ?? "",
          stderr: execErr.stderr?.toString() ?? "",
          exit_code: execErr.code,
        };

        // Still try to collect output files even if command failed
        if (workingDir) {
          const outputFiles = await this.collectOutputFiles(workingDir);
          if (outputFiles && outputFiles.length > 0) {
            result.output_files = outputFiles;
          }
        }

        return result;
      }

      throw err;
    }
  }

  /**
   * Collect output files from working_dir/output/
   */
  private async collectOutputFiles(
    workingDir: string
  ): Promise<CodeExecuteOutput["output_files"]> {
    const outputDir = join(workingDir, "output");

    try {
      const entries = await readdir(outputDir);
      const files: CodeExecuteOutput["output_files"] = [];

      for (const entry of entries) {
        const fullPath = join(outputDir, entry);
        const stats = await stat(fullPath);

        if (stats.isFile()) {
          // Check file size
          if (stats.size > this.config.max_output_size) {
            this.logger.warn(
              { fileName: entry, size: stats.size },
              "Output file exceeds max_output_size, skipping"
            );
            continue;
          }

          files.push({
            name: basename(fullPath),
            path: fullPath,
          });
        }
      }

      this.logger.debug(
        { fileCount: files.length },
        "Collected output files"
      );
      return files;
    } catch (err) {
      // output directory doesn't exist or other error
      this.logger.debug(
        { error: err },
        "No output files collected (output/ directory not found or empty)"
      );
      return [];
    }
  }

  getRequiredConfig(): string[] {
    return [];
  }

  async startup(_ctx: SkillContext): Promise<void> {
    // No startup required
  }

  async shutdown(): Promise<void> {
    // No persistent resources to cleanup
  }
}
