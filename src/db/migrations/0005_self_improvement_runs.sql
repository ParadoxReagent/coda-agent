-- Self-improvement execution run history
-- Tracks each attempt by the SelfImprovementExecutorSkill to apply a proposal

CREATE TABLE IF NOT EXISTS self_improvement_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id UUID REFERENCES improvement_proposals(id),
  outcome VARCHAR(20) NOT NULL,
  branch_name VARCHAR(255),
  pr_url VARCHAR(500),
  target_files JSONB DEFAULT '[]',
  steps JSONB DEFAULT '[]',
  blast_radius JSONB DEFAULT '{}',
  narrative TEXT,
  error TEXT,
  duration_ms INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sir_proposal ON self_improvement_runs(proposal_id);
CREATE INDEX IF NOT EXISTS idx_sir_outcome ON self_improvement_runs(outcome);
CREATE INDEX IF NOT EXISTS idx_sir_created ON self_improvement_runs(created_at);
