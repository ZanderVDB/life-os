-- Phase E2.8 — the once-per-local-day marker for Today's automatic arrangement.
--
-- On the MEMBERSHIP, not the user and not the workspace: the record is "this
-- person's Today, in this workspace", which is exactly what a membership is.
-- A user with two workspaces arranges each one's Today on its own schedule.
--
-- A `date`, not a timestamp. The rule is "once per local calendar day", and the
-- local day is the client's — storing an instant would mean re-deriving a date
-- from it in a timezone the server does not reliably know.
ALTER TABLE workspace_memberships
  ADD COLUMN last_today_arranged_on date;
