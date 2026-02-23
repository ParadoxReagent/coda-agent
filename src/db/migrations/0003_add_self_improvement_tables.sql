-- Migration 0003: Add self-improvement tables (Phase 4)
-- self_assessments, improvement_proposals, prompt_versions, task_state

--> statement-breakpoint
CREATE TABLE "self_assessments" (
  "id" serial PRIMARY KEY NOT NULL,
  "correlation_id" varchar(36),
  "user_id" varchar(255),
  "channel" varchar(50),
  "task_completed" boolean,
  "tool_failure_count" integer DEFAULT 0,
  "fallback_used" boolean DEFAULT false,
  "tier_used" varchar(20),
  "model_used" varchar(255),
  "tool_call_count" integer DEFAULT 0,
  "self_score" real,
  "assessment_summary" text,
  "failure_modes" jsonb DEFAULT '[]',
  "metadata" jsonb DEFAULT '{}',
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "self_assessments_correlation_id_idx" ON "self_assessments" ("correlation_id");
--> statement-breakpoint
CREATE INDEX "self_assessments_user_id_idx" ON "self_assessments" ("user_id");
--> statement-breakpoint
CREATE INDEX "self_assessments_created_at_idx" ON "self_assessments" ("created_at");
--> statement-breakpoint
CREATE INDEX "self_assessments_self_score_idx" ON "self_assessments" ("self_score");

--> statement-breakpoint
CREATE TABLE "improvement_proposals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "cycle_id" uuid,
  "category" varchar(50) NOT NULL,
  "title" varchar(500) NOT NULL,
  "description" text NOT NULL,
  "proposed_diff" text,
  "target_section" varchar(100),
  "priority" integer DEFAULT 5,
  "status" varchar(20) DEFAULT 'pending' NOT NULL,
  "user_decision" varchar(20),
  "user_feedback" text,
  "applied_at" timestamp with time zone,
  "metadata" jsonb DEFAULT '{}',
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "improvement_proposals_status_idx" ON "improvement_proposals" ("status");
--> statement-breakpoint
CREATE INDEX "improvement_proposals_created_at_idx" ON "improvement_proposals" ("created_at");
--> statement-breakpoint
CREATE INDEX "improvement_proposals_cycle_id_idx" ON "improvement_proposals" ("cycle_id");

--> statement-breakpoint
CREATE TABLE "prompt_versions" (
  "id" serial PRIMARY KEY NOT NULL,
  "section_name" varchar(100) NOT NULL,
  "content" text NOT NULL,
  "version" integer NOT NULL,
  "is_active" boolean DEFAULT false NOT NULL,
  "is_ab_variant" boolean DEFAULT false NOT NULL,
  "ab_weight" real DEFAULT 0.5,
  "source_proposal_id" uuid,
  "performance_score" real,
  "sample_count" integer DEFAULT 0,
  "created_by" varchar(50) DEFAULT 'system',
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "retired_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_versions_section_version_idx" ON "prompt_versions" ("section_name", "version");
--> statement-breakpoint
CREATE INDEX "prompt_versions_section_active_idx" ON "prompt_versions" ("section_name", "is_active");

--> statement-breakpoint
CREATE TABLE "task_state" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" varchar(255) NOT NULL,
  "channel" varchar(50) NOT NULL,
  "workspace_id" varchar(255),
  "goal" text NOT NULL,
  "steps" jsonb DEFAULT '[]' NOT NULL,
  "current_step" integer DEFAULT 0,
  "status" varchar(20) DEFAULT 'active' NOT NULL,
  "blockers" jsonb DEFAULT '[]',
  "next_action_at" timestamp with time zone,
  "result" text,
  "metadata" jsonb DEFAULT '{}',
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "task_state_user_status_idx" ON "task_state" ("user_id", "status");
--> statement-breakpoint
CREATE INDEX "task_state_status_next_action_idx" ON "task_state" ("status", "next_action_at");
--> statement-breakpoint
CREATE INDEX "task_state_created_at_idx" ON "task_state" ("created_at");
