CREATE TABLE "context_facts" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"key" varchar(255) NOT NULL,
	"value" text NOT NULL,
	"category" varchar(100) DEFAULT 'general' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"channel" varchar(50) NOT NULL,
	"role" varchar(20) NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_usage" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider" varchar(100) NOT NULL,
	"model" varchar(255) NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"estimated_cost_microcents" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"title" varchar(500),
	"content" text NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"search_vector" "tsvector",
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"service" varchar(50) NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"access_token" text NOT NULL,
	"refresh_token" text NOT NULL,
	"token_type" varchar(50) DEFAULT 'Bearer' NOT NULL,
	"expiry_date" timestamp with time zone NOT NULL,
	"scope" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"title" varchar(500) NOT NULL,
	"description" text,
	"due_at" timestamp with time zone NOT NULL,
	"recurring" varchar(100),
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"channel" varchar(50),
	"snoozed_until" timestamp with time zone,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "skills_config" (
	"id" serial PRIMARY KEY NOT NULL,
	"skill_name" varchar(100) NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "skills_config_skill_name_unique" UNIQUE("skill_name")
);
--> statement-breakpoint
CREATE INDEX "facts_user_idx" ON "context_facts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "facts_user_key_idx" ON "context_facts" USING btree ("user_id","key");--> statement-breakpoint
CREATE INDEX "conv_user_channel_idx" ON "conversations" USING btree ("user_id","channel");--> statement-breakpoint
CREATE INDEX "conv_created_at_idx" ON "conversations" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "usage_provider_model_idx" ON "llm_usage" USING btree ("provider","model");--> statement-breakpoint
CREATE INDEX "usage_created_at_idx" ON "llm_usage" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "notes_user_idx" ON "notes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "notes_tags_idx" ON "notes" USING btree ("tags");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_tokens_service_user_idx" ON "oauth_tokens" USING btree ("service","user_id");--> statement-breakpoint
CREATE INDEX "reminders_user_status_due_idx" ON "reminders" USING btree ("user_id","status","due_at");