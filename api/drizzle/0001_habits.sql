CREATE TABLE IF NOT EXISTS "habit_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"habit_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"entry_date" date NOT NULL,
	"completed_count" integer DEFAULT 1 NOT NULL,
	"completed_at" timestamp with time zone,
	"source" text DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "habit_entries_count_check" CHECK ("habit_entries"."completed_count" >= 0),
	CONSTRAINT "habit_entries_source_check" CHECK ("habit_entries"."source" in ('user','import','system'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "habits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"area_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"frequency_type" text DEFAULT 'daily' NOT NULL,
	"frequency_config" jsonb,
	"target_count" integer DEFAULT 1 NOT NULL,
	"color" text DEFAULT 'sage' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"legacy_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "habits_frequency_check" CHECK ("habits"."frequency_type" in ('daily','weekly','specific_days','times_per_week')),
	CONSTRAINT "habits_target_check" CHECK ("habits"."target_count" >= 1)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "habit_entries" ADD CONSTRAINT "habit_entries_habit_id_habits_id_fk" FOREIGN KEY ("habit_id") REFERENCES "public"."habits"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "habit_entries" ADD CONSTRAINT "habit_entries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "habits" ADD CONSTRAINT "habits_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "habits" ADD CONSTRAINT "habits_area_id_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."areas"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "habit_entries_unique_day" ON "habit_entries" USING btree ("habit_id","entry_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "habit_entries_workspace_date_idx" ON "habit_entries" USING btree ("workspace_id","entry_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "habits_workspace_position_idx" ON "habits" USING btree ("workspace_id","position");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "habits_active_idx" ON "habits" USING btree ("workspace_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "habits_legacy_idx" ON "habits" USING btree ("workspace_id","legacy_id") WHERE "habits"."legacy_id" is not null;