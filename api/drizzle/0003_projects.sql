-- Phase E2 — Projects.
--
-- Purely additive apart from one constraint on tasks.project_id, which has
-- existed as an unconstrained nullable uuid since the baseline and is null on
-- every row. Adding the foreign key therefore cannot fail on existing data and
-- cannot move any task.
--
-- Idempotent throughout: every statement is IF NOT EXISTS or guarded, so a
-- partial run can be repeated safely.

CREATE TABLE IF NOT EXISTS "projects" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "area_id" uuid,
  "title" text NOT NULL,
  -- Nullable at the database level ONLY because the Legacy migration cannot
  -- invent an outcome. The API requires it for every new project.
  "outcome" text,
  "description" text,
  "notes" text,
  "status" text DEFAULT 'planning' NOT NULL,
  "focus" text DEFAULT 'upcoming' NOT NULL,
  "target_date" date,
  "next_task_id" uuid,
  "position" integer DEFAULT 0 NOT NULL,
  "completed_at" timestamp with time zone,
  -- Archive is an overlay on the lifecycle, not a fifth status: a project
  -- keeps the status it had, and restore returns it there.
  "archived_at" timestamp with time zone,
  "pre_archive_status" text,
  "legacy_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "projects_status_check"
    CHECK ("status" in ('planning','active','on_hold','completed')),
  CONSTRAINT "projects_focus_check"
    CHECK ("focus" in ('now','upcoming','someday')),
  CONSTRAINT "projects_pre_archive_status_check"
    CHECK ("pre_archive_status" is null
           or "pre_archive_status" in ('planning','active','on_hold','completed')),
  -- An archived project must remember where to go back to.
  CONSTRAINT "projects_archive_pair_check"
    CHECK (("archived_at" is null and "pre_archive_status" is null)
           or ("archived_at" is not null and "pre_archive_status" is not null))
);
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_fk"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

-- Losing an Area must not lose the project.
DO $$ BEGIN
  ALTER TABLE "projects" ADD CONSTRAINT "projects_area_id_fk"
    FOREIGN KEY ("area_id") REFERENCES "areas"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

-- The explicit next action. Deliberately NOT cascade: deleting a task clears
-- the pointer, it does not delete the project.
DO $$ BEGIN
  ALTER TABLE "projects" ADD CONSTRAINT "projects_next_task_id_fk"
    FOREIGN KEY ("next_task_id") REFERENCES "tasks"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

-- The overview's main query: one status group at a time, in manual order.
CREATE INDEX IF NOT EXISTS "projects_ws_status_idx"
  ON "projects" USING btree ("workspace_id","status","position");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "projects_ws_focus_idx"
  ON "projects" USING btree ("workspace_id","focus","position");
--> statement-breakpoint
-- Partial: the default view excludes archived projects, and they are the
-- minority, so the index only carries live rows.
CREATE INDEX IF NOT EXISTS "projects_live_idx"
  ON "projects" USING btree ("workspace_id","position") WHERE "archived_at" is null;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "projects_area_idx"
  ON "projects" USING btree ("workspace_id","area_id");
--> statement-breakpoint
-- Import idempotency: a second migration run finds the row and writes nothing.
CREATE UNIQUE INDEX IF NOT EXISTS "projects_legacy_idx"
  ON "projects" USING btree ("workspace_id","legacy_id") WHERE "legacy_id" is not null;
--> statement-breakpoint

-- tasks.project_id becomes a real relationship.
--
-- ON DELETE SET NULL, never cascade: deleting a project must never delete
-- work. The task survives, keeps its area, bucket, dates and steps, and simply
-- stops belonging to a project.
DO $$ BEGIN
  ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_fk"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

-- Replaces the plain (workspace_id, project_id) index. Partial and
-- status-aware, because every project query asks for open tasks first.
CREATE INDEX IF NOT EXISTS "tasks_project_open_idx"
  ON "tasks" USING btree ("project_id","status","position")
  WHERE "project_id" is not null;
