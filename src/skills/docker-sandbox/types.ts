export interface DockerSandboxBuildInput {
  /** Tag for the image. Must start with "agent-sandbox-". */
  tag: string;
  /** Path to the Dockerfile. Must be within the agent working directory. */
  dockerfile_path: string;
  /** Build context directory. Must be within the agent working directory. */
  context_path: string;
  /** Optional build args as key=value pairs. */
  build_args?: Record<string, string>;
}

export interface DockerSandboxRunInput {
  /** Container name. Must start with "agent-sandbox-". */
  name: string;
  /** Image tag to run. Must start with "agent-sandbox-". */
  image: string;
  /** Host port to map container port 3000 to. */
  host_port: number;
  /** Optional environment variables. */
  env?: Record<string, string>;
  /** Optional memory limit (e.g., "512m"). Default: "512m". */
  memory?: string;
}

export interface DockerSandboxLogsInput {
  /** Container name. Must start with "agent-sandbox-". */
  name: string;
  /** Number of log lines to tail. Default: 100. */
  tail?: number;
}

export interface DockerSandboxStopInput {
  /** Container name. Must start with "agent-sandbox-". */
  name: string;
}

export interface DockerSandboxRemoveInput {
  /** Container name. Must start with "agent-sandbox-". */
  name: string;
  /** Force remove even if running. Default: false. */
  force?: boolean;
}

export interface DockerSandboxHealthcheckInput {
  /** Port to check. Used as http://localhost:{port}/health. */
  port: number;
  /** Path to check. Default: "/health". */
  path?: string;
  /** Timeout in seconds. Default: 10. */
  timeout_seconds?: number;
}

export interface DockerSandboxResult {
  success: boolean;
  output?: string;
  error?: string;
  durationMs: number;
}
