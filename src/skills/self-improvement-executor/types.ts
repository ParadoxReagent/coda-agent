export type RunOutcome = "PASS" | "FAIL" | "SKIPPED";

export interface RunStep {
  name: string;
  passed: boolean;
  durationMs: number;
  output?: string;
  error?: string;
}

export interface BlastRadiusAnalysis {
  affected_files: string[];
  import_chain_depth: number;
  risk_level: "low" | "medium" | "high" | "critical";
  risk_factors: string[];
  protected_path_violations: string[];
  summary: string;
}

export interface FileChange {
  file: string;
  newContents: string;
  explanation: string;
  risk: "low" | "medium" | "high";
}

export interface SurgeonOutput {
  changes: FileChange[];
  summary: string;
  out_of_scope: boolean;
  out_of_scope_reason: string | null;
}

export interface RunResult {
  runId: string;
  proposalId: string;
  outcome: RunOutcome;
  branchName?: string;
  prUrl?: string;
  targetFiles: string[];
  steps: RunStep[];
  blastRadius?: BlastRadiusAnalysis;
  narrative?: string;
  error?: string;
  durationMs: number;
}

export interface ExecutorConfig {
  executor_enabled: boolean;
  executor_require_approval: boolean;
  executor_cron: string;
  executor_max_files: number;
  executor_blast_radius_limit: number;
  executor_allowed_paths: string[];
  executor_forbidden_paths: string[];
  executor_auto_merge: boolean;
  executor_shadow_port: number;
  executor_max_run_duration_minutes: number;
  executor_webhook_name?: string;
  executor_github_owner: string;
  executor_github_repo: string;
}
