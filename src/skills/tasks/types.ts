/** Interfaces for the TaskExecutionSkill (4.5 Long-Horizon Tasks). */

export interface TaskStep {
  index: number;
  description: string;
  status: "pending" | "in_progress" | "completed" | "skipped";
  result?: string;
  completedAt?: string;
}

export interface TaskBlocker {
  description: string;
  type: "user_input" | "external_dependency" | "technical" | "other";
  createdAt: string;
}

export interface TaskRecord {
  id: string;
  userId: string;
  channel: string;
  workspaceId?: string;
  goal: string;
  steps: TaskStep[];
  currentStep: number;
  status: "active" | "paused" | "completed" | "failed";
  blockers: TaskBlocker[];
  nextActionAt?: string;
  result?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}
