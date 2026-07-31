CREATE TABLE IF NOT EXISTS "calendar_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provider" text DEFAULT 'google' NOT NULL,
	"provider_account_id" text NOT NULL,
	"account_email" text,
	"status" text DEFAULT 'active' NOT NULL,
	"access_token_ref" text,
	"refresh_token_ref" text,
	"token_expires_at" timestamp with time zone,
	"granted_scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"disconnected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cal_conn_status" CHECK ("calendar_connections"."status" IN ('active','needs_reauth','revoked','error'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "calendar_event_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"file_id" text,
	"file_url" text,
	"title" text,
	"mime_type" text,
	"icon_link" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "calendar_event_attendees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"email" text,
	"display_name" text,
	"response_status" text DEFAULT 'needsAction' NOT NULL,
	"is_optional" boolean DEFAULT false NOT NULL,
	"is_organizer" boolean DEFAULT false NOT NULL,
	"is_self" boolean DEFAULT false NOT NULL,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "calendar_event_reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"method" text DEFAULT 'popup' NOT NULL,
	"minutes_before" integer NOT NULL,
	"uses_default" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "calendar_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"calendar_id" uuid NOT NULL,
	"provider_event_id" text,
	"ical_uid" text,
	"recurring_event_id" text,
	"original_start_time" timestamp with time zone,
	"title" text,
	"description" text,
	"location" text,
	"is_all_day" boolean DEFAULT false NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"start_date" date,
	"end_date" date,
	"time_zone" text,
	"recurrence" jsonb,
	"status" text DEFAULT 'confirmed' NOT NULL,
	"transparency" text DEFAULT 'opaque' NOT NULL,
	"visibility" text DEFAULT 'default' NOT NULL,
	"provider_color_id" text,
	"event_type" text,
	"conference_data" jsonb,
	"hangout_link" text,
	"organizer_email" text,
	"organizer_name" text,
	"provider_html_link" text,
	"source_url" text,
	"etag" text,
	"sequence" integer DEFAULT 0 NOT NULL,
	"provider_created_at" timestamp with time zone,
	"provider_updated_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"sync_state" text DEFAULT 'local_only' NOT NULL,
	"is_synthetic" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cal_events_status" CHECK ("calendar_events"."status" IN ('confirmed','tentative','cancelled')),
	CONSTRAINT "cal_events_transparency" CHECK ("calendar_events"."transparency" IN ('opaque','transparent')),
	CONSTRAINT "cal_events_sync_state" CHECK ("calendar_events"."sync_state" IN ('synced','pending_push','push_failed','local_only'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "calendar_item_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "calendar_sync_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"calendar_id" uuid NOT NULL,
	"sync_token" text,
	"next_page_token" text,
	"full_sync_completed_at" timestamp with time zone,
	"last_incremental_at" timestamp with time zone,
	"token_invalidated_at" timestamp with time zone,
	"is_syncing" boolean DEFAULT false NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "calendars" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"connection_id" uuid,
	"provider_calendar_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"color" text,
	"time_zone" text,
	"access_role" text DEFAULT 'reader' NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"is_visible" boolean DEFAULT true NOT NULL,
	"is_read_only" boolean DEFAULT true NOT NULL,
	"is_synthetic" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendars_role" CHECK ("calendars"."access_role" IN ('owner','writer','reader','freeBusyReader'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reminder_recurrence_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"reminder_id" uuid NOT NULL,
	"frequency" text NOT NULL,
	"interval" integer DEFAULT 1 NOT NULL,
	"by_weekday" jsonb,
	"by_month_day" jsonb,
	"until" date,
	"count" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reminder_rrule_freq" CHECK ("reminder_recurrence_rules"."frequency" IN ('DAILY','WEEKLY','MONTHLY','YEARLY'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"area_id" uuid,
	"title" text NOT NULL,
	"notes" text,
	"due_date" date,
	"due_time" text,
	"time_zone" text,
	"status" text DEFAULT 'open' NOT NULL,
	"completed_at" timestamp with time zone,
	"deferred_to" date,
	"lead_days" integer DEFAULT 0 NOT NULL,
	"is_synthetic" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reminders_status" CHECK ("reminders"."status" IN ('open','done','dismissed'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_schedule_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"time_zone" text,
	"mirrored_event_id" uuid,
	"is_synthetic" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "calendar_connections" ADD CONSTRAINT "calendar_connections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "calendar_event_attachments" ADD CONSTRAINT "calendar_event_attachments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "calendar_event_attachments" ADD CONSTRAINT "calendar_event_attachments_event_id_calendar_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."calendar_events"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "calendar_event_attendees" ADD CONSTRAINT "calendar_event_attendees_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "calendar_event_attendees" ADD CONSTRAINT "calendar_event_attendees_event_id_calendar_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."calendar_events"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "calendar_event_reminders" ADD CONSTRAINT "calendar_event_reminders_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "calendar_event_reminders" ADD CONSTRAINT "calendar_event_reminders_event_id_calendar_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."calendar_events"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_calendar_id_calendars_id_fk" FOREIGN KEY ("calendar_id") REFERENCES "public"."calendars"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "calendar_item_links" ADD CONSTRAINT "calendar_item_links_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "calendar_sync_states" ADD CONSTRAINT "calendar_sync_states_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "calendar_sync_states" ADD CONSTRAINT "calendar_sync_states_calendar_id_calendars_id_fk" FOREIGN KEY ("calendar_id") REFERENCES "public"."calendars"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "calendars" ADD CONSTRAINT "calendars_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "calendars" ADD CONSTRAINT "calendars_connection_id_calendar_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."calendar_connections"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reminder_recurrence_rules" ADD CONSTRAINT "reminder_recurrence_rules_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reminder_recurrence_rules" ADD CONSTRAINT "reminder_recurrence_rules_reminder_id_reminders_id_fk" FOREIGN KEY ("reminder_id") REFERENCES "public"."reminders"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reminders" ADD CONSTRAINT "reminders_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reminders" ADD CONSTRAINT "reminders_area_id_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."areas"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_schedule_blocks" ADD CONSTRAINT "task_schedule_blocks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_schedule_blocks" ADD CONSTRAINT "task_schedule_blocks_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_schedule_blocks" ADD CONSTRAINT "task_schedule_blocks_mirrored_event_id_calendar_events_id_fk" FOREIGN KEY ("mirrored_event_id") REFERENCES "public"."calendar_events"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cal_conn_ws_idx" ON "calendar_connections" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cal_conn_account_idx" ON "calendar_connections" USING btree ("workspace_id","provider","provider_account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cal_ev_attach_event_idx" ON "calendar_event_attachments" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cal_attendees_event_idx" ON "calendar_event_attendees" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cal_attendees_unique_idx" ON "calendar_event_attendees" USING btree ("event_id","email") WHERE "calendar_event_attendees"."email" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cal_ev_reminders_event_idx" ON "calendar_event_reminders" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cal_events_ws_idx" ON "calendar_events" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cal_events_range_idx" ON "calendar_events" USING btree ("workspace_id","starts_at","ends_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cal_events_calendar_idx" ON "calendar_events" USING btree ("calendar_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cal_events_series_idx" ON "calendar_events" USING btree ("workspace_id","recurring_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cal_events_provider_idx" ON "calendar_events" USING btree ("calendar_id","provider_event_id") WHERE "calendar_events"."provider_event_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cal_links_ws_idx" ON "calendar_item_links" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cal_links_source_idx" ON "calendar_item_links" USING btree ("workspace_id","source_type","source_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cal_links_target_idx" ON "calendar_item_links" USING btree ("workspace_id","target_type","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cal_links_unique_idx" ON "calendar_item_links" USING btree ("source_type","source_id","target_type","target_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cal_sync_calendar_idx" ON "calendar_sync_states" USING btree ("calendar_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cal_sync_ws_idx" ON "calendar_sync_states" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calendars_ws_idx" ON "calendars" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "calendars_provider_idx" ON "calendars" USING btree ("workspace_id","provider_calendar_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "reminder_rrule_idx" ON "reminder_recurrence_rules" USING btree ("reminder_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reminders_ws_idx" ON "reminders" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reminders_due_idx" ON "reminders" USING btree ("workspace_id","due_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_blocks_ws_idx" ON "task_schedule_blocks" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_blocks_range_idx" ON "task_schedule_blocks" USING btree ("workspace_id","starts_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_blocks_task_idx" ON "task_schedule_blocks" USING btree ("task_id");