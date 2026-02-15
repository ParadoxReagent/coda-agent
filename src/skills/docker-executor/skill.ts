import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { readdir, stat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
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
        "coda-skill-*",
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

    // Create temporary directory if no working_dir provided
    let workingDir = params.working_dir;
    let tempDir: string | undefined;
    if (!workingDir) {
      tempDir = await mkdtemp(join(tmpdir(), "coda-docker-"));
      workingDir = tempDir;
      this.logger.debug({ tempDir }, "Created temporary working directory");
    }

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
    } finally {
      // Clean up temporary directory if we created one
      if (tempDir) {
        try {
          await rm(tempDir, { recursive: true, force: true });
          this.logger.debug({ tempDir }, "Cleaned up temporary directory");
        } catch (cleanupErr) {
          this.logger.warn(
            { error: cleanupErr, tempDir },
            "Failed to clean up temporary directory"
          );
        }
      }
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
   * Execute a docker command with proper DOCKER_HOST configuration
   */
  private async execDocker(
    args: string[],
    options?: { signal?: AbortSignal; maxBuffer?: number }
  ): Promise<{ stdout: string; stderr: string }> {
    const env = { ...process.env };
    if (this.config.docker_socket !== "/var/run/docker.sock") {
      env.DOCKER_HOST = `unix://${this.config.docker_socket}`;
    }

    return await execFileAsync("docker", args, {
      ...options,
      env,
    });
  }

  /**
   * Create a temporary Docker volume
   */
  private async createVolume(): Promise<string> {
    const volumeName = `coda-exec-${randomBytes(8).toString("hex")}`;
    await this.execDocker(["volume", "create", volumeName]);
    this.logger.debug({ volumeName }, "Created Docker volume");
    return volumeName;
  }

  /**
   * Remove a Docker volume
   */
  private async removeVolume(volumeName: string): Promise<void> {
    try {
      await this.execDocker(["volume", "rm", volumeName]);
      this.logger.debug({ volumeName }, "Removed Docker volume");
    } catch (err) {
      this.logger.warn(
        { error: err, volumeName },
        "Failed to remove Docker volume"
      );
    }
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
    // Create a temporary Docker volume (works in any environment)
    const volumeName = await this.createVolume();
    let containerId: string | undefined;

    try {
      // Build docker create args with security constraints
      const createArgs = [
        "create",
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
        createArgs.push("--network", "none");
      }

      // Mount the Docker volume at /workspace
      createArgs.push("-v", `${volumeName}:/workspace:rw`);
      createArgs.push("-w", "/workspace");

      // Wrap command to ensure output directory exists
      const wrappedCommand = `mkdir -p /workspace/output && ${command}`;

      // Image and command
      createArgs.push(image, "sh", "-c", wrappedCommand);

      this.logger.debug({ createArgs }, "Docker create command");

      // Create the container
      const { stdout: createStdout } = await this.execDocker(createArgs);
      containerId = createStdout.trim();

      this.logger.debug({ containerId, volumeName }, "Created container");

      // Copy input files into the container if working_dir provided
      if (workingDir) {
        try {
          // Check if directory has any input files to copy (excluding output/ subdirectory)
          const entries = await readdir(workingDir);
          const inputFiles = entries.filter(name => name !== 'output');
          const hasInputFiles = inputFiles.length > 0;

          if (hasInputFiles) {
            // Copy all files from working_dir into /workspace in the container
            // The trailing /. syntax copies the contents of workingDir
            await this.execDocker([
              "cp",
              `${workingDir}/.`,
              `${containerId}:/workspace`,
            ]);
            this.logger.debug(
              { workingDir, containerId, fileCount: inputFiles.length },
              "Copied input files to container"
            );
          } else {
            this.logger.debug(
              { workingDir },
              "No input files to copy (working directory empty except for output/)"
            );
          }
        } catch (err) {
          // If workingDir doesn't exist or copy fails, warn but continue
          this.logger.warn(
            { error: err, workingDir },
            "Failed to copy input files"
          );
        }
      }

      // Start the container with timeout
      const timeoutMs = timeout * 1000;
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

      let stdout = "";
      let stderr = "";
      let exitCode = 0;
      let timedOut = false;

      try {
        const startResult = await this.execDocker(
          ["start", "-a", containerId],
          {
            signal: controller.signal,
            maxBuffer: 10 * 1024 * 1024, // 10 MB max output
          }
        );
        stdout = startResult.stdout;
        stderr = startResult.stderr;
      } catch (err: unknown) {
        clearTimeout(timeoutHandle);

        // Check if aborted due to timeout
        if (
          err &&
          typeof err === "object" &&
          "signal" in err &&
          err.signal === "SIGTERM"
        ) {
          timedOut = true;
          // Kill the container explicitly since aborting docker start only detaches
          try {
            await this.execDocker(["kill", containerId]);
          } catch (killErr) {
            this.logger.warn(
              { error: killErr, containerId },
              "Failed to kill timed-out container"
            );
          }
        } else if (
          err &&
          typeof err === "object" &&
          "code" in err &&
          (err as { code: unknown }).code === "ENOENT"
        ) {
          // Docker binary not found
          throw new Error(
            "Docker is not installed or not found in PATH. Please install Docker and ensure it is accessible."
          );
        } else if (
          err &&
          typeof err === "object" &&
          "stdout" in err &&
          "stderr" in err &&
          "code" in err
        ) {
          // Non-zero exit code
          const execErr = err as {
            stdout: string;
            stderr: string;
            code: number;
          };
          stdout = execErr.stdout?.toString() ?? "";
          stderr = execErr.stderr?.toString() ?? "";
          exitCode = execErr.code;
        } else {
          throw err;
        }
      }

      clearTimeout(timeoutHandle);

      if (timedOut) {
        throw new Error(`Execution timed out after ${timeout} seconds`);
      }

      // Copy output files from container to working directory
      let outputFiles: CodeExecuteOutput["output_files"];
      if (workingDir) {
        try {
          // Copy /workspace/output/ from container to workingDir/output/
          const outputDir = join(workingDir, "output");
          await mkdir(outputDir, { recursive: true });

          await this.execDocker([
            "cp",
            `${containerId}:/workspace/output/.`,
            outputDir,
          ]);

          this.logger.debug(
            { containerId, outputDir },
            "Copied output files from container"
          );

          outputFiles = await this.collectOutputFiles(workingDir);
        } catch (err) {
          // If output directory doesn't exist in container, that's okay
          this.logger.debug(
            { error: err },
            "No output files to copy (output/ directory not found in container)"
          );
        }
      }

      const result: CodeExecuteOutput = {
        success: exitCode === 0,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exit_code: exitCode,
      };

      if (outputFiles && outputFiles.length > 0) {
        result.output_files = outputFiles;
      }

      return result;
    } finally {
      // Clean up container and volume
      if (containerId) {
        try {
          await this.execDocker(["rm", "-f", containerId]);
          this.logger.debug({ containerId }, "Removed container");
        } catch (err) {
          this.logger.warn(
            { error: err, containerId },
            "Failed to remove container"
          );
        }
      }

      await this.removeVolume(volumeName);
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
