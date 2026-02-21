Here's what each self_improvement option does, traced through the actual code:                                                                    
                                                                                                                                                    
  ---                                                                                                                                               
  enabled (default: true)                                                                                                                           
                                                                                                                                                    
  Controls whether the SelfImprovementSkill is registered at all. When false, no reflection cron runs and the 4 improvement tools                   
  (improvement_proposals_list, improvement_proposal_decide, improvement_trigger_reflection, prompt_rollback) are unavailable. Note: the
  SelfAssessmentService and LearnedTierClassifier are instantiated unconditionally in main.ts regardless of this flag.                              
                                                                                                                                                    
  opus_model (default: unset — falls back to heavy-tier model)

  Overrides the model used for the weekly Opus reflection call. The provider always comes from the heavy tier (or default fallback). If unset,
  whatever model your heavy tier resolves to (e.g. OpenRouter Sonnet) is used. Set this to "claude-opus-4-6" if you want actual Opus for
  reflections.

  reflection_cron (default: "0 3 * * 0" — Sunday 3 AM)

  Cron schedule for the weekly reflection cycle. When it fires, it:
  1. Queries last 7 days of audit stats, low-scoring assessments (score ≤ 2), and routing tier distribution
  2. Sends that performance report to the Opus LLM
  3. Parses the response into structured improvement proposals (categories: prompt, routing, memory, capability_gap, failure_mode, tool_usage)
  4. Inserts them as "pending" in the improvement_proposals table
  5. Sends a summary to the approval_channel

  assessment_enabled (default: true)

  Schema placeholder — not actually wired yet. The SelfAssessmentService always runs after any turn with ≥1 tool call. It calls a lightweight LLM
  (Haiku-tier) to score the turn's quality. The scores feed into the weekly reflection as training signal. This flag exists for future gating.

  prompt_evolution_enabled (default: false)

  This is the big one. Controls whether approved prompt-category proposals are auto-applied to the live system prompt.

  - When false (default): Approving a prompt proposal just marks it "approved" in the DB. Nothing changes. You can review proposals via the
  improvement_proposals_list tool and decide on them with improvement_proposal_decide, but approval is purely informational.
  - When true: Approving a prompt proposal creates a new version in the prompt_versions table via PromptManager, then activates it. The
  PromptManager supports versioning, A/B testing with configurable weights, rollback, and per-version performance scoring. Activated versions
  override hardcoded defaults during system prompt assembly. There's also a prompt_rollback tool to revert if something goes wrong.

  This is deliberately false by default — it lets the agent modify its own instructions. You'd want to trust the proposal quality first by reviewing
   several cycles of proposals before enabling it.

  max_reflection_input_tokens (default: 8000)

  Schema placeholder — not currently consumed. The reflection input is hardcoded to truncate the system prompt snapshot at 3000 chars, and Opus
  response is capped at 3000 tokens. This exists for future use to control total input size.

  approval_channel (default: "discord")

  Which messaging channel receives the post-reflection summary with pending proposals. After each reflection cycle, a formatted summary (top 5
  proposals with category, title, priority, excerpt) is sent here via MessageSender.

  routing_retrain_cron (default: "0 4 * * 0" — Sunday 4 AM)

  Cron schedule for retraining the LearnedTierClassifier. Registered unconditionally (even if enabled: false). Retraining:
  1. Queries last 30 days of routing_decisions joined with self_assessments
  2. Identifies misroutes: light tier + low score → should've been heavy; heavy tier + high score → could've been light
  3. Extracts keyword patterns with confidence scores (min 0.6, min 3 samples)
  4. Keeps top 50 patterns for weighted-vote classification at request time

  Scheduled 1 hour after reflection, which makes sense since reflection may generate routing-related proposals.

  ---
  TL;DR on the flow: Every turn gets auto-scored (assessment). Weekly, Opus reviews the scores + audit data and proposes improvements. You review
  proposals via tools. If prompt_evolution_enabled is on, approving a prompt proposal live-patches the system prompt. The routing classifier
  retrains itself from historical misroutes independently.
