-- Background calendar sync bookkeeping.
--
-- Additive and idempotent. Existing connections get next_sync_at = NULL, which
-- the scheduler reads as "due now" — so the first tick after deploy brings
-- every already-connected account up to date rather than waiting an interval.

ALTER TABLE calendar_connections
  ADD COLUMN IF NOT EXISTS next_sync_at timestamptz,
  ADD COLUMN IF NOT EXISTS syncing_since timestamptz,
  ADD COLUMN IF NOT EXISTS sync_failure_count integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS cal_conn_due_idx ON calendar_connections (next_sync_at);

-- A connection marked revoked by the OLD code cannot be trusted: every refresh
-- failure was recorded that way, so an unknown number of these are healthy
-- grants killed by a transient Google error. Returning them to active costs one
-- refresh attempt; if the grant really is gone, the next attempt marks it
-- revoked again -- this time for the right reason.
UPDATE calendar_connections
   SET status = 'active',
       last_error = NULL,
       next_sync_at = NULL
 WHERE status = 'revoked'
   AND refresh_token_ref IS NOT NULL;
