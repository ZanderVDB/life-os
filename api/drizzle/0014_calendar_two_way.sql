-- Two-way Google Calendar: write capability, watch channels, mutation ledger.
--
-- Additive and idempotent. Existing calendars, events and sync tokens are
-- untouched: this adds what writing needs, and nothing already synced has to
-- be re-fetched.

ALTER TABLE calendar_connections
  ADD COLUMN IF NOT EXISTS can_write boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS scopes_version integer NOT NULL DEFAULT 1;

ALTER TABLE calendars
  ADD COLUMN IF NOT EXISTS counts_as_busy boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS is_default_target boolean NOT NULL DEFAULT false;

-- Reference calendars do not block time, and treating them as conflicts would
-- make the warning constant and therefore worthless. Best-effort match on the
-- names Google gives these; the user can change any of it in Settings.
UPDATE calendars
   SET counts_as_busy = false
 WHERE counts_as_busy = true
   AND (access_role = 'reader' OR access_role = 'freeBusyReader')
   AND (name ILIKE '%holiday%' OR name ILIKE '%birthday%' OR name ILIKE '%week number%'
        OR provider_calendar_id LIKE '%#holiday%' OR provider_calendar_id LIKE '%#contacts%');

-- The primary calendar is the sensible default target for a new event.
UPDATE calendars SET is_default_target = true
 WHERE is_primary = true
   AND NOT EXISTS (
     SELECT 1 FROM calendars c2
      WHERE c2.workspace_id = calendars.workspace_id AND c2.is_default_target = true);

CREATE TABLE IF NOT EXISTS calendar_watch_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES calendar_connections(id) ON DELETE CASCADE,
  calendar_id uuid NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
  channel_id text NOT NULL UNIQUE,
  resource_id text,
  resource_uri text,
  verification_token text NOT NULL,
  expires_at timestamptz,
  status text NOT NULL DEFAULT 'active',
  last_notified_at timestamptz,
  notify_count integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cal_watch_status CHECK (status IN ('active','expired','stopped','failed'))
);
CREATE INDEX IF NOT EXISTS cal_watch_ws_idx ON calendar_watch_channels (workspace_id);
CREATE INDEX IF NOT EXISTS cal_watch_cal_idx ON calendar_watch_channels (calendar_id);
CREATE INDEX IF NOT EXISTS cal_watch_exp_idx ON calendar_watch_channels (status, expires_at);

CREATE TABLE IF NOT EXISTS calendar_mutations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  request_id text NOT NULL,
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'proposed',
  origin text NOT NULL DEFAULT 'user',
  calendar_id uuid REFERENCES calendars(id) ON DELETE SET NULL,
  event_id uuid REFERENCES calendar_events(id) ON DELETE SET NULL,
  provider_event_id text,
  scope text NOT NULL DEFAULT 'single',
  payload jsonb,
  summary jsonb,
  error text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  executed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cal_mut_kind CHECK (kind IN ('calendar.create','calendar.update','calendar.delete')),
  CONSTRAINT cal_mut_status CHECK (status IN ('proposed','confirmed','executed','failed','cancelled')),
  CONSTRAINT cal_mut_scope CHECK (scope IN ('single','instance','series','following'))
);
CREATE INDEX IF NOT EXISTS cal_mut_ws_idx ON calendar_mutations (workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS cal_mut_request_idx ON calendar_mutations (workspace_id, request_id);

-- Every existing connection predates the write scopes, so none of them can
-- write. Saying so is what makes the app offer a reconnect BEFORE somebody
-- fills in an event form, rather than after Google refuses it.
UPDATE calendar_connections SET can_write = false, scopes_version = 1;
