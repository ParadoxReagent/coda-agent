/** Shared interfaces for the self-improvement skill (Phase 4.2 + 4.3). */

export type ProposalCategory =
  | "prompt"
  | "routing"
  | "memory"
  | "capability_gap"
  | "failure_mode"
  | "tool_usage";

export interface ProposalRecord {
  id: string;
  cycleId?: string;
  category: ProposalCategory;
  title: string;
  description: string;
  proposedDiff?: string;
  targetSection?: string;
  priority: number;
  status: "pending" | "approved" | "rejected" | "applied" | "rolled_back";
  userDecision?: string;
  userFeedback?: string;
  appliedAt?: string;
  createdAt: string;
}

export interface ReflectionInput {
  cycleId: string;
  auditStats: {
    totalCalls: number;
    successRate: number;
    topTools: Array<{ toolName: string; count: number }>;
    errorsByTool: Array<{ toolName: string; count: number }>;
  };
  lowScoringAssessments: Array<{
    correlationId?: string;
    selfScore: number;
    assessmentSummary?: string;
    failureModes: unknown;
    tierUsed?: string;
  }>;
  routingPatterns: Array<{
    tier: string;
    count: number;
    avgComplexity: number;
  }>;
  systemPromptSnapshot: string;
  toolList: string[];
}

export interface RawProposal {
  category: string;
  title: string;
  description: string;
  priority: number;
  proposed_diff?: string;
  target_section?: string;
}
