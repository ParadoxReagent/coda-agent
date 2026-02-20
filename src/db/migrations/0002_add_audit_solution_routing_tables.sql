CREATE TABLE "audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"correlation_id" varchar(36),
	"user_id" varchar(255),
	"channel" varchar(50),
	"event_type" varchar(100) NOT NULL,
	"skill_name" varchar(100),
	"tool_name" varchar(255),
	"input_summary" text,
	"duration_ms" integer,
	"status" varchar(20) NOT NULL,
	"tier" varchar(20),
	"model" varchar(255),
	"provider" varchar(100),
	"permission_tier" integer,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "solution_patterns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" varchar(500) NOT NULL,
	"task_type" varchar(100),
	"problem_description" text NOT NULL,
	"resolution_steps" jsonb NOT NULL,
	"tools_used" text[] DEFAULT '{}' NOT NULL,
	"outcome" varchar(50) DEFAULT 'success' NOT NULL,
	"source_memory_id" uuid,
	"embedding" vector(384),
	"tags" text[] DEFAULT '{}' NOT NULL,
	"retrieval_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routing_decisions" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" varchar(36),
	"correlation_id" varchar(36),
	"user_id" varchar(255),
	"channel" varchar(50),
	"task_type" varchar(100),
	"model_chosen" varchar(255) NOT NULL,
	"provider" varchar(100),
	"tier" varchar(20) NOT NULL,
	"rationale" text,
	"input_complexity_score" real,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "audit_log_correlation_id_idx" ON "audit_log" USING btree ("correlation_id");
--> statement-breakpoint
CREATE INDEX "audit_log_user_id_idx" ON "audit_log" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "audit_log_event_type_idx" ON "audit_log" USING btree ("event_type");
--> statement-breakpoint
CREATE INDEX "audit_log_tool_name_idx" ON "audit_log" USING btree ("tool_name");
--> statement-breakpoint
CREATE INDEX "audit_log_created_at_idx" ON "audit_log" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX "audit_log_status_idx" ON "audit_log" USING btree ("status");
--> statement-breakpoint
CREATE INDEX "solution_patterns_task_type_idx" ON "solution_patterns" USING btree ("task_type");
--> statement-breakpoint
CREATE INDEX "solution_patterns_tags_idx" ON "solution_patterns" USING btree ("tags");
--> statement-breakpoint
CREATE INDEX "solution_patterns_created_at_idx" ON "solution_patterns" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX "routing_decisions_user_id_idx" ON "routing_decisions" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "routing_decisions_tier_idx" ON "routing_decisions" USING btree ("tier");
--> statement-breakpoint
CREATE INDEX "routing_decisions_created_at_idx" ON "routing_decisions" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX "routing_decisions_correlation_id_idx" ON "routing_decisions" USING btree ("correlation_id");
