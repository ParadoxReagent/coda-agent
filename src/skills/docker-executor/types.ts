/**
 * Types for Docker executor skill
 */

export interface CodeExecuteInput {
  /** Shell command to execute inside container */
  command: string;
  /** Docker image to use (must be in allowed_images list) */
  image?: string;
  /** Working directory path to mount as /workspace */
  working_dir?: string;
  /** Execution timeout in seconds (max 300) */
  timeout_seconds?: number;
  /** Enable network access in container (default: false) */
  network?: boolean;
}

export interface CodeExecuteOutput {
  /** Whether execution succeeded */
  success: boolean;
  /** Standard output from command */
  stdout: string;
  /** Standard error from command */
  stderr: string;
  /** Exit code from command */
  exit_code?: number;
  /** Output files generated in /workspace/output/ */
  output_files?: Array<{
    name: string;
    path: string;
    mimeType?: string;
  }>;
}
