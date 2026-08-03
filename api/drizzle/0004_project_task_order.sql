-- Phase E2.1 — ordering tasks inside a project.
--
-- A SEPARATE column from `tasks.position`, deliberately.
--
-- `position` orders a task within its Today bucket. Reusing it for project
-- order would mean dragging a task in a project silently reshuffles the Today
-- board — a change the user did not ask for, in a place they were not looking.
-- Two different orderings of the same rows need two orderings.
--
-- Additive and idempotent: default 0 on every existing row, and the API
-- backfills sparse values the first time a project's tasks are ordered.

ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "project_position" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint

-- The project detail query: open tasks of one project, in their own order.
CREATE INDEX IF NOT EXISTS "tasks_project_order_idx"
  ON "tasks" USING btree ("project_id","status","project_position")
  WHERE "project_id" is not null;
