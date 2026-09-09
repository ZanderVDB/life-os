-- `paused` was a status the code wrote and the constraint forbade.
--
-- `setReminderPaused` has set it since reminders existed, `calendar.ts` reads
-- it to suppress future occurrences of a paused series, and `resumeReminder`
-- sets it back to 'open'. The one place it was never written down was this
-- CHECK, so pressing Pause on a recurring reminder returned a 500. Confirmed
-- against a running database rather than inferred from the source.
--
-- WIDENING a CHECK cannot invalidate a row that already exists, which is what
-- makes this safe to run against live data: every current value still passes.
ALTER TABLE "reminders" DROP CONSTRAINT IF EXISTS "reminders_status";
--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_status"
  CHECK ("reminders"."status" IN ('open','done','dismissed','paused'));
