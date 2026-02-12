CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "alert_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_id" varchar(36) NOT NULL,
	"event_type" varchar(255) NOT NULL,
	"severity" varchar(20) NOT NULL,
	"source_skill" varchar(100) NOT NULL,
	"channel" varchar(50),
	"payload" jsonb,
	"formatted_message" text,
	"delivered" integer DEFAULT 0 NOT NULL,
	"suppressed" integer DEFAULT 0 NOT NULL,
	"suppression_reason" varchar(255),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "known_clients" (
	"mac" varchar(17) PRIMARY KEY NOT NULL,
	"hostname" varchar(255),
	"friendly_name" varchar(255),
	"ip_address" varchar(45),
	"first_seen" timestamp DEFAULT now() NOT NULL,
	"last_seen" timestamp DEFAULT now() NOT NULL,
	"is_known" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content" text NOT NULL,
	"content_type" varchar(50) NOT NULL,
	"embedding" vector(384),
	"source_type" varchar(50) DEFAULT 'manual',
	"source_id" varchar(255),
	"importance" real DEFAULT 0.5,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"content_hash" varchar(64),
	"access_count" integer DEFAULT 0,
	"accessed_at" timestamp with time zone,
	"is_archived" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"search_vector" "tsvector",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "n8n_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"type" varchar(100) NOT NULL,
	"category" varchar(50),
	"priority" varchar(20) NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"data" jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"source_workflow" varchar(255),
	"processed" boolean DEFAULT false NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_preferences" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"dnd_enabled" boolean DEFAULT false NOT NULL,
	"alerts_only" boolean DEFAULT false NOT NULL,
	"quiet_hours_start" varchar(5),
	"quiet_hours_end" varchar(5),
	"timezone" varchar(100) DEFAULT 'America/New_York' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_preferences_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE INDEX "alert_history_event_type_idx" ON "alert_history" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "alert_history_created_at_idx" ON "alert_history" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "alert_history_event_id_idx" ON "alert_history" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "known_clients_is_known_idx" ON "known_clients" USING btree ("is_known");--> statement-breakpoint
CREATE INDEX "known_clients_last_seen_idx" ON "known_clients" USING btree ("last_seen");--> statement-breakpoint
CREATE INDEX "memories_content_type_idx" ON "memories" USING btree ("content_type");--> statement-breakpoint
CREATE INDEX "memories_created_at_idx" ON "memories" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "memories_importance_idx" ON "memories" USING btree ("importance");--> statement-breakpoint
CREATE INDEX "memories_tags_idx" ON "memories" USING btree ("tags");--> statement-breakpoint
CREATE INDEX "memories_source_type_idx" ON "memories" USING btree ("source_type");--> statement-breakpoint
CREATE INDEX "n8n_events_type_idx" ON "n8n_events" USING btree ("type");--> statement-breakpoint
CREATE INDEX "n8n_events_category_idx" ON "n8n_events" USING btree ("category");--> statement-breakpoint
CREATE INDEX "n8n_events_timestamp_idx" ON "n8n_events" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "n8n_events_processed_idx" ON "n8n_events" USING btree ("processed");--> statement-breakpoint
CREATE INDEX "n8n_events_priority_timestamp_idx" ON "n8n_events" USING btree ("priority","timestamp");--> statement-breakpoint
CREATE INDEX "n8n_events_tags_idx" ON "n8n_events" USING btree ("tags");--> statement-breakpoint
CREATE UNIQUE INDEX "user_prefs_user_id_idx" ON "user_preferences" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX memories_embedding_idx ON memories
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);--> statement-breakpoint
CREATE OR REPLACE FUNCTION memories_search_vector_update() RETURNS trigger AS $$
BEGIN
  NEW.search_vector := to_tsvector('english', NEW.content);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER memories_search_vector_trigger
  BEFORE INSERT OR UPDATE OF content ON memories
  FOR EACH ROW EXECUTE FUNCTION memories_search_vector_update();